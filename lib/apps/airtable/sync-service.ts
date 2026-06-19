/**
 * Airtable Sync Service
 *
 * Handles full and incremental sync of Airtable records into CMS collections.
 * Uses existing collection repositories for all database operations.
 *
 * Performance: reconciliation uses batch operations throughout — bulk insert
 * for new items/values, bulk upsert for updates, and batch soft-delete.
 * Dirty checking skips records whose mapped values haven't changed.
 */

import { randomUUID } from 'crypto';

import { getSupabaseAdmin, runWithTenantId } from '@/lib/supabase-server';
import { getAppSettingValue, setAppSetting } from '@/lib/repositories/appSettingsRepository';
import { slugify } from '@/lib/collection-utils';
import { isAssetFieldType, isMultipleAssetField, getAssetCategoryForField } from '@/lib/collection-field-utils';
import { ALLOWED_MIME_TYPES } from '@/lib/asset-constants';
import { uploadFile } from '@/lib/file-upload';
import { getFieldsByCollectionId, getFieldsByKeyAcrossCollections, createField } from '@/lib/repositories/collectionFieldRepository';
import {
  createItemsBulk,
  getAllItemsByCollectionId,
} from '@/lib/repositories/collectionItemRepository';
import {
  insertValuesBulk,
  getValuesByItemIds,
  getValueMapByFieldIds,
} from '@/lib/repositories/collectionItemValueRepository';

import { listAllRecords, listRecordsByIds, getWebhookPayloads, deleteWebhook, refreshWebhook } from './index';
import { transformFieldValue } from './field-mapping';
import type { AirtableConnection, AirtableRecord, AirtableWebhookPayload, SyncResult, TableChanges } from './types';
import type { CollectionFieldType, CollectionField } from '@/types';

export const APP_ID = 'airtable';
const HIDDEN_FIELD_KEY = 'airtable_id';
const SLUG_FIELD_KEY = 'slug';
const BULK_CHUNK_SIZE = 500;
const ATTACHMENT_CONCURRENCY = 5;
const INCREMENTAL_SYNC_THRESHOLD = 100;
/** Debounce delay so rapid-fire Airtable notifications settle before processing */
const WEBHOOK_DEBOUNCE_MS = 2000;
/** Auto-release stale locks after this duration (process crash safety net) */
const SYNC_LOCK_TIMEOUT_MS = 120_000;

// =============================================================================
// Connection Helpers
// =============================================================================

/** Get the stored Airtable API token, throwing if not configured */
export async function requireAirtableToken(): Promise<string> {
  const token = await getAppSettingValue<string>(APP_ID, 'api_token');
  if (!token) throw new Error('Airtable token not configured');
  return token;
}

/** Load all Airtable connections from app_settings */
export async function getConnections(): Promise<AirtableConnection[]> {
  return (await getAppSettingValue<AirtableConnection[]>(APP_ID, 'connections')) ?? [];
}

/** Persist connections back to app_settings */
export async function saveConnections(connections: AirtableConnection[]): Promise<void> {
  await setAppSetting(APP_ID, 'connections', connections);
}

/** Find a connection by ID */
export async function getConnectionById(connectionId: string): Promise<AirtableConnection | null> {
  const connections = await getConnections();
  return connections.find((c) => c.id === connectionId) ?? null;
}

/** Parse connectionId from a request body and resolve the connection, or throw */
export async function requireConnectionFromBody(
  request: Request
): Promise<AirtableConnection> {
  const { connectionId } = await request.json();
  if (!connectionId || typeof connectionId !== 'string') {
    throw new Error('connectionId is required');
  }
  const connection = await getConnectionById(connectionId);
  if (!connection) throw new Error('Connection not found');
  return connection;
}

/** Update a single connection field and persist */
export async function updateConnection(
  connectionId: string,
  patch: Partial<AirtableConnection>
): Promise<AirtableConnection | null> {
  const connections = await getConnections();
  const idx = connections.findIndex((c) => c.id === connectionId);
  if (idx === -1) return null;

  connections[idx] = { ...connections[idx], ...patch };
  await saveConnections(connections);
  return connections[idx];
}

/**
 * Clean up all registered Airtable webhooks before disconnecting.
 * Best-effort — failures are logged but don't block disconnect.
 */
export async function cleanupWebhooks(): Promise<void> {
  const token = await getAppSettingValue<string>(APP_ID, 'api_token');
  if (!token) return;

  const connections = await getConnections();
  const seen = new Set<string>();

  for (const conn of connections) {
    if (!conn.webhookId || seen.has(conn.webhookId)) continue;
    seen.add(conn.webhookId);
    try {
      await deleteWebhook(token, conn.baseId, conn.webhookId);
    } catch {
      // Webhook may already be expired or deleted — safe to ignore
    }
  }
}

/**
 * Refresh all active webhooks that expire within the given threshold.
 * Designed to be called by a daily cron to keep webhooks alive.
 */
export async function refreshActiveWebhooks(
  thresholdDays = 3
): Promise<{ refreshed: number; failed: number }> {
  const token = await getAppSettingValue<string>(APP_ID, 'api_token');
  if (!token) return { refreshed: 0, failed: 0 };

  const connections = await getConnections();
  const threshold = Date.now() + thresholdDays * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  let refreshed = 0;
  let failed = 0;

  for (const conn of connections) {
    if (!conn.webhookId || seen.has(conn.webhookId)) continue;
    seen.add(conn.webhookId);

    const expiresAt = conn.webhookExpiresAt ? new Date(conn.webhookExpiresAt).getTime() : 0;
    if (expiresAt > threshold) continue;

    try {
      const result = await refreshWebhook(token, conn.baseId, conn.webhookId);
      await updateConnection(conn.id, { webhookExpiresAt: result.expirationTime });
      refreshed++;
    } catch {
      // Webhook likely expired or was deleted — clear it so the user can re-enable
      await updateConnection(conn.id, {
        webhookId: null,
        webhookSecret: null,
        webhookExpiredAt: conn.webhookExpiresAt || new Date().toISOString(),
        webhookExpiresAt: null,
        webhookCursor: 0,
      });
      failed++;
    }
  }

  return { refreshed, failed };
}

// =============================================================================
// Webhook Sync Lock
// =============================================================================

interface SyncLock {
  locked_at: string | null;
}

/**
 * Best-effort distributed lock via Supabase REST API.
 * Uses getAppSettingValue/setAppSetting to avoid Knex connection pool
 * exhaustion on serverless platforms with limited pool sizes.
 *
 * Not strictly atomic (TOCTOU window), but combined with the dedup check
 * in executeBatchOperations, prevents duplicate record creation.
 */
async function tryClaimSyncLock(webhookId: string): Promise<'acquired' | 'busy' | 'error'> {
  try {
    const lockKey = `sync_lock_${webhookId}`;
    const existing = await getAppSettingValue<SyncLock>(APP_ID, lockKey);

    if (existing?.locked_at) {
      const lockedAt = new Date(existing.locked_at).getTime();
      const isStale = Date.now() - lockedAt > SYNC_LOCK_TIMEOUT_MS;
      if (!isStale) return 'busy';
    }

    await setAppSetting(APP_ID, lockKey, { locked_at: new Date().toISOString() });
    return 'acquired';
  } catch (err) {
    console.error('[Airtable Sync] Lock acquisition failed, proceeding without lock:', err);
    return 'error';
  }
}

/** Release the sync lock. Best-effort — stale timeout handles cleanup on crash. */
async function releaseSyncLock(webhookId: string): Promise<void> {
  try {
    const lockKey = `sync_lock_${webhookId}`;
    await setAppSetting(APP_ID, lockKey, { locked_at: null });
  } catch {
    // Best-effort — stale timeout handles cleanup
  }
}

// =============================================================================
// Hidden Field Management
// =============================================================================

/**
 * Ensure the hidden airtable_id field exists on a collection.
 * Creates it if missing, returns the field ID.
 */
export async function ensureRecordIdField(collectionId: string): Promise<string> {
  const fields = await getFieldsByCollectionId(collectionId);
  const existing = fields.find((f) => f.key === HIDDEN_FIELD_KEY);

  if (existing) return existing.id;

  const maxOrder = fields.reduce((max, f) => Math.max(max, f.order), 0);
  const field = await createField({
    name: 'Airtable ID',
    type: 'text',
    collection_id: collectionId,
    order: maxOrder + 1,
    hidden: true,
    key: HIDDEN_FIELD_KEY,
    is_computed: true,
    fillable: false,
  });

  return field.id;
}

// =============================================================================
// Sync Status Wrapper
// =============================================================================

/** Wrap a sync operation with status tracking on the connection */
async function withSyncStatus(
  connection: AirtableConnection,
  syncFn: () => Promise<SyncResult>
): Promise<SyncResult> {
  await updateConnection(connection.id, { syncStatus: 'syncing', syncError: null });
  try {
    const result = await syncFn();
    await updateConnection(connection.id, {
      syncStatus: 'idle',
      syncError: null,
      lastSyncedAt: result.syncedAt,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown sync error';
    await updateConnection(connection.id, { syncStatus: 'error', syncError: message });
    throw error;
  }
}

// =============================================================================
// Full Sync
// =============================================================================

/**
 * Run a full sync for a connection.
 * Fetches all Airtable records and reconciles with CMS items.
 */
export async function fullSync(connection: AirtableConnection): Promise<SyncResult> {
  return withSyncStatus(connection, async () => {
    const token = await requireAirtableToken();
    const airtableRecords = await listAllRecords(token, connection.baseId, connection.tableId);
    return reconcileRecords(connection, airtableRecords);
  });
}

// =============================================================================
// Webhook-triggered Sync
// =============================================================================

/** Aggregate record-level changes from webhook payloads for a specific table */
function extractTableChanges(
  payloads: AirtableWebhookPayload['payloads'],
  tableId: string
): TableChanges {
  const created = new Set<string>();
  const changed = new Set<string>();
  const destroyed = new Set<string>();

  for (const payload of payloads) {
    const table = payload.changedTablesById?.[tableId];
    if (!table) continue;

    if (table.createdRecordsById) {
      for (const id of Object.keys(table.createdRecordsById)) created.add(id);
    }
    if (table.changedRecordsById) {
      for (const id of Object.keys(table.changedRecordsById)) changed.add(id);
    }
    if (table.destroyedRecordIds) {
      for (const id of table.destroyedRecordIds) destroyed.add(id);
    }
  }

  return {
    createdRecordIds: Array.from(created),
    changedRecordIds: Array.from(changed),
    destroyedRecordIds: Array.from(destroyed),
  };
}

/**
 * Run an incremental sync for a connection using webhook change data.
 * Fetches only the created/changed records and deletes destroyed ones.
 */
async function incrementalSync(
  connection: AirtableConnection,
  changes: TableChanges
): Promise<SyncResult> {
  return withSyncStatus(connection, async () => {
    const token = await requireAirtableToken();

    // Don't fetch records that were destroyed — they no longer exist on Airtable
    const destroyedSet = new Set(changes.destroyedRecordIds);
    const uniqueIds = [...new Set([
      ...changes.createdRecordIds,
      ...changes.changedRecordIds,
    ].filter((id) => !destroyedSet.has(id)))];

    const records = await listRecordsByIds(token, connection.baseId, connection.tableId, uniqueIds);
    return incrementalReconcile(connection, records, changes.destroyedRecordIds);
  });
}

/**
 * Process an Airtable webhook notification.
 * Extracts per-record changes and runs incremental sync when practical,
 * falling back to full sync for large changesets.
 *
 * Concurrency: uses a database-level mutex (app_settings row) so only one
 * serverless invocation processes a given webhook at a time. A 2-second
 * debounce inside the lock lets rapid-fire Airtable notifications settle,
 * matching the pattern from the legacy Cache::lock + sleep(2).
 */
export async function processWebhookNotification(
  baseId: string,
  webhookId: string,
  tenantId?: string | null
): Promise<SyncResult[]> {
  const tid = tenantId ?? null;

  const doSync = async (): Promise<SyncResult[]> => {
    // Lock must be inside doSync so it runs within the tenant context
    // (runWithTenantId) — otherwise getSupabaseAdmin() has no tenant scope.
    const lockStatus = await tryClaimSyncLock(webhookId);

    if (lockStatus === 'busy') return [];
    const hasLock = lockStatus === 'acquired';

    try {
      if (hasLock) {
        // Debounce: let rapid-fire notifications settle before hitting the API
        await new Promise((resolve) => setTimeout(resolve, WEBHOOK_DEBOUNCE_MS));
      }

      const token = await requireAirtableToken();

      const connections = await getConnections();
      const affectedConnections = connections.filter(
        (c) => c.baseId === baseId && c.webhookId === webhookId
      );

      if (affectedConnections.length === 0) return [];

      const results: SyncResult[] = [];
      for (const conn of affectedConnections) {
        const freshConn = await getConnectionById(conn.id);
        if (!freshConn || freshConn.syncStatus === 'syncing') continue;

        await updateConnection(conn.id, { syncStatus: 'syncing', syncError: null });

        try {
          const cursor = freshConn.webhookCursor || undefined;
          const payloadResponse = await getWebhookPayloads(token, baseId, webhookId, cursor);

          if (payloadResponse.cursor) {
            await updateConnection(conn.id, { webhookCursor: payloadResponse.cursor });
          }

          if (!payloadResponse.payloads?.length) {
            await updateConnection(conn.id, { syncStatus: 'idle' });
            continue;
          }

          const changes = extractTableChanges(payloadResponse.payloads, conn.tableId);
          const totalChanges = changes.createdRecordIds.length
            + changes.changedRecordIds.length
            + changes.destroyedRecordIds.length;

          if (totalChanges > 0) {
            const result = totalChanges > INCREMENTAL_SYNC_THRESHOLD
              ? await fullSync(freshConn)
              : await incrementalSync(freshConn, changes);
            results.push(result);
          } else {
            await updateConnection(conn.id, { syncStatus: 'idle' });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown sync error';
          await updateConnection(conn.id, { syncStatus: 'error', syncError: message });
        }
      }

      return results;
    } finally {
      if (hasLock) {
        await releaseSyncLock(webhookId);
      }
    }
  };

  // Wrap in explicit tenant context so all nested calls (including lock
  // acquisition) resolve the correct tenant via AsyncLocalStorage.
  return tid ? runWithTenantId(tid, doSync) : doSync();
}

// =============================================================================
// Record Reconciliation
// =============================================================================

/** System field IDs resolved once per sync */
interface AutoFields {
  idFieldId: string | null;
  createdAtFieldId: string | null;
  updatedAtFieldId: string | null;
}

/** Shared context passed to buildRecordValues to avoid repeating params */
interface SyncContext {
  fieldMapping: AirtableConnection['fieldMapping'];
  recordIdFieldId: string;
  slugCtx: SlugContext | null;
  assetCache: Map<string, string>;
  /** CMS field IDs mapped from attachments — pre-computed for perf */
  attachmentFieldIds: Map<string, AttachmentFieldInfo>;
  /** Fingerprints of existing attachment data keyed by "recordId:fieldId" */
  attachmentFingerprintCache: Map<string, string>;
  autoFields: AutoFields;
  /** Per-field resolvers that map Airtable record IDs to CMS item UUIDs for reference fields */
  referenceResolvers: Map<string, Map<string, string>>;
}

interface AttachmentFieldInfo {
  isMultiple: boolean;
  allowedMimeTypes: string[] | null;
}

/** All pre-computed state needed by both full and incremental reconciliation */
interface SyncState {
  ctx: SyncContext;
  existingItems: Array<{ id: string }>;
  existingValues: Record<string, Record<string, unknown>>;
  recordIdToCmsItem: Map<string, string>;
  connectionId: string;
  collectionId: string;
  result: SyncResult;
}

interface SlugContext {
  slugFieldId: string;
  existingSlugs: Set<string>;
}

function generateUniqueSlug(value: string | null, ctx: SlugContext): string {
  const base = slugify(value || 'item');
  if (!ctx.existingSlugs.has(base)) {
    ctx.existingSlugs.add(base);
    return base;
  }

  let n = 1;
  while (ctx.existingSlugs.has(`${base}-${n}`)) n++;
  const unique = `${base}-${n}`;
  ctx.existingSlugs.add(unique);
  return unique;
}

/**
 * Fingerprint attachment data using stable Airtable attachment IDs + filenames.
 * URLs are NOT used because Airtable rotates them every ~2 hours.
 */
function attachmentFingerprint(rawValue: unknown): string {
  if (!Array.isArray(rawValue) || rawValue.length === 0) return '';
  return rawValue
    .map((a) => {
      const att = a as Record<string, unknown>;
      return `${att?.id ?? ''}|${att?.filename ?? ''}`;
    })
    .join(',');
}

/**
 * Build resolvers that map Airtable record IDs to CMS item UUIDs for reference fields.
 * Uses just 2 DB queries regardless of how many target collections are involved:
 * 1. Find all `airtable_id` fields across target collections
 * 2. Load all their values from `collection_item_values`
 */
async function buildReferenceResolvers(
  fieldMapping: AirtableConnection['fieldMapping'],
  fields: CollectionField[]
): Promise<Map<string, Map<string, string>>> {
  const resolvers = new Map<string, Map<string, string>>();

  const refMappings = fieldMapping.filter(
    (m) => m.airtableFieldType === 'multipleRecordLinks'
      && (m.cmsFieldType === 'reference' || m.cmsFieldType === 'multi_reference')
  );

  if (refMappings.length === 0) return resolvers;

  const fieldById = new Map(fields.map((f) => [f.id, f]));

  // Group by target collection to avoid loading the same collection twice
  const collectionToCmsFields = new Map<string, string[]>();
  for (const mapping of refMappings) {
    const cmsField = fieldById.get(mapping.cmsFieldId);
    if (!cmsField?.reference_collection_id) continue;

    const existing = collectionToCmsFields.get(cmsField.reference_collection_id) ?? [];
    existing.push(mapping.cmsFieldId);
    collectionToCmsFields.set(cmsField.reference_collection_id, existing);
  }

  const targetCollectionIds = Array.from(collectionToCmsFields.keys());
  if (targetCollectionIds.length === 0) return resolvers;

  // Query 1: find the airtable_id field in each target collection
  const fieldsByCollection = await getFieldsByKeyAcrossCollections(HIDDEN_FIELD_KEY, targetCollectionIds);

  const airtableIdFieldIds = Array.from(fieldsByCollection.values()).map((f) => f.id);
  if (airtableIdFieldIds.length === 0) return resolvers;

  // Query 2: load all airtable_id values across all target collections at once
  const valuesByField = await getValueMapByFieldIds(airtableIdFieldIds);

  // Build inverted lookups (airtableRecordId -> cmsItemId) per target collection
  for (const [targetCollectionId, cmsFieldIds] of collectionToCmsFields) {
    const airtableIdField = fieldsByCollection.get(targetCollectionId);
    if (!airtableIdField) continue;

    const itemValues = valuesByField.get(airtableIdField.id);
    if (!itemValues || itemValues.size === 0) continue;

    // Invert: value (airtable record ID) -> key (CMS item ID)
    const lookup = new Map<string, string>();
    for (const [cmsItemId, airtableRecordId] of itemValues) {
      lookup.set(airtableRecordId, cmsItemId);
    }

    for (const cmsFieldId of cmsFieldIds) {
      resolvers.set(cmsFieldId, lookup);
    }
  }

  return resolvers;
}

/**
 * Build the mapped values for a single Airtable record.
 * Pass existingItemValues when processing an existing record — attachment fields
 * whose raw data hasn't changed will reuse the stored asset IDs instead of
 * re-downloading.
 */
async function buildRecordValues(
  record: AirtableRecord,
  ctx: SyncContext,
  existingItemValues?: Record<string, string>
): Promise<Record<string, string | null>> {
  const values: Record<string, string | null> = {
    [ctx.recordIdFieldId]: record.id,
  };

  for (const mapping of ctx.fieldMapping) {
    const rawValue = record.fields[mapping.airtableFieldId];
    const attachmentInfo = ctx.attachmentFieldIds.get(mapping.cmsFieldId);

    if (attachmentInfo) {
      const fpKey = `${record.id}:${mapping.cmsFieldId}`;
      const fp = attachmentFingerprint(rawValue);

      // Skip download if fingerprint matches previous sync and we have a stored value
      if (existingItemValues) {
        const prevFp = ctx.attachmentFingerprintCache.get(fpKey);
        if (prevFp === fp && existingItemValues[mapping.cmsFieldId]) {
          values[mapping.cmsFieldId] = existingItemValues[mapping.cmsFieldId];
          ctx.attachmentFingerprintCache.set(fpKey, fp);
          continue;
        }
      }

      values[mapping.cmsFieldId] = await uploadAttachmentsAsAssets(
        rawValue, ctx.assetCache, attachmentInfo.isMultiple, attachmentInfo.allowedMimeTypes
      );
      ctx.attachmentFingerprintCache.set(fpKey, fp);
      continue;
    }

    // Resolve linked record IDs to CMS item UUIDs for reference fields
    const resolver = ctx.referenceResolvers.get(mapping.cmsFieldId);
    if (resolver) {
      const airtableIds = Array.isArray(rawValue) ? rawValue as string[] : [];
      const resolvedIds = airtableIds
        .map((id) => resolver.get(id))
        .filter((id): id is string => !!id);

      if (mapping.cmsFieldType === 'reference') {
        values[mapping.cmsFieldId] = resolvedIds[0] ?? null;
      } else {
        values[mapping.cmsFieldId] = resolvedIds.length > 0 ? JSON.stringify(resolvedIds) : '[]';
      }
      continue;
    }

    let value = transformFieldValue(rawValue, mapping.airtableFieldType, mapping.cmsFieldType);

    if (ctx.slugCtx && mapping.cmsFieldId === ctx.slugCtx.slugFieldId) {
      // For existing records, temporarily remove their current slug so the
      // record doesn't conflict with itself (prevents flip-flopping)
      const currentSlug = existingItemValues?.[ctx.slugCtx.slugFieldId] as string | undefined;
      if (currentSlug) ctx.slugCtx.existingSlugs.delete(currentSlug);

      value = generateUniqueSlug(value, ctx.slugCtx);
    }

    values[mapping.cmsFieldId] = value;
  }

  return values;
}

/**
 * Download Airtable attachments and upload as CMS assets.
 * Single-asset fields return one UUID; multi-asset fields return a JSON array of UUIDs.
 * Downloads up to ATTACHMENT_CONCURRENCY files in parallel.
 * When allowedMimeTypes is set, only attachments with a matching MIME type are included.
 */
async function uploadAttachmentsAsAssets(
  rawValue: unknown,
  cache: Map<string, string>,
  isMultiple: boolean,
  allowedMimeTypes: string[] | null
): Promise<string | null> {
  if (!Array.isArray(rawValue) || rawValue.length === 0) return null;

  const filtered = allowedMimeTypes
    ? rawValue.filter((a) => {
      const mime = (a as Record<string, unknown>)?.type as string | undefined;
      return mime ? allowedMimeTypes.includes(mime) : false;
    })
    : rawValue;

  const attachments = isMultiple ? filtered : filtered.slice(0, 1);

  // Separate cached vs uncached to avoid redundant downloads
  const tasks: Array<{ att: Record<string, unknown>; url: string; index: number }> = [];
  const results: Array<{ index: number; assetId: string }> = [];

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i] as Record<string, unknown>;
    const url = att?.url as string | undefined;
    if (!url) continue;

    const cached = cache.get(url);
    if (cached) {
      results.push({ index: i, assetId: cached });
    } else {
      tasks.push({ att, url, index: i });
    }
  }

  // Download uncached attachments with concurrency limit
  for (let i = 0; i < tasks.length; i += ATTACHMENT_CONCURRENCY) {
    const batch = tasks.slice(i, i + ATTACHMENT_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ att, url, index }) => {
        const res = await fetch(url);
        if (!res.ok) return null;

        const contentType = (att.type as string) || res.headers.get('content-type') || 'image/png';
        const buffer = await res.arrayBuffer();
        const blob = new Blob([buffer], { type: contentType });
        const filename = (att.filename as string) || url.split('/').pop()?.split('?')[0] || 'attachment';
        const file = new File([blob], filename, { type: contentType });

        const asset = await uploadFile(file, 'airtable-sync');
        if (!asset) return null;

        cache.set(url, asset.id);
        return { index, assetId: asset.id };
      })
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value) {
        results.push(outcome.value);
      }
    }
  }

  if (results.length === 0) return null;

  // Restore original order
  results.sort((a, b) => a.index - b.index);
  const assetIds = results.map((r) => r.assetId);

  return isMultiple ? JSON.stringify(assetIds) : assetIds[0];
}

/**
 * Check if two value maps differ for the mapped fields.
 * Normalizes both sides to strings since getValuesByItemIds returns
 * cast values (number, boolean, object) while buildRecordValues returns strings.
 */
function hasChanges(
  newValues: Record<string, string | null>,
  existingValues: Record<string, unknown> | undefined
): boolean {
  if (!existingValues) return true;
  for (const [fieldId, value] of Object.entries(newValues)) {
    const newStr = value ?? '';
    const existing = existingValues[fieldId];
    const existingStr = existing == null ? '' : typeof existing === 'object' ? JSON.stringify(existing) : String(existing);
    if (newStr !== existingStr) return true;
  }
  return false;
}

/**
 * Re-check which Airtable record IDs already exist in the CMS.
 * Guards against concurrent webhook invocations that race past
 * the syncStatus check and both try to create the same records.
 */
async function getExistingAirtableRecordIds(
  recordIdFieldId: string,
  airtableRecordIds: string[]
): Promise<Set<string>> {
  if (airtableRecordIds.length === 0) return new Set();

  const client = await getSupabaseAdmin();
  if (!client) return new Set();

  const { data } = await client
    .from('collection_item_values')
    .select('value')
    .eq('field_id', recordIdFieldId)
    .eq('is_published', false)
    .is('deleted_at', null)
    .in('value', airtableRecordIds);

  return new Set((data || []).map((row) => row.value).filter(Boolean));
}

// =============================================================================
// Shared Sync State & Operations
// =============================================================================

/** Load fields, items, values, and build the sync context for a connection */
async function prepareSyncState(connection: AirtableConnection): Promise<SyncState> {
  const { collectionId, recordIdFieldId } = connection;
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, errors: [], syncedAt: new Date().toISOString() };

  // Use getAllItemsByCollectionId (paginates past PostgREST's 1000-row cap) so
  // reconciliation sees every item. A truncated list makes items beyond the cap
  // look "missing", so they're never matched (and the dedup guard then blocks
  // re-creating them), leaving their values permanently stale.
  const [existingItems, fields] = await Promise.all([
    getAllItemsByCollectionId(collectionId),
    getFieldsByCollectionId(collectionId),
  ]);

  const activeFieldIds = new Set(fields.map((f) => f.id));
  const fieldMapping = connection.fieldMapping.filter((m) => activeFieldIds.has(m.cmsFieldId));

  const existingItemIds = existingItems.map((item) => item.id);
  const existingValues = existingItemIds.length > 0
    ? await getValuesByItemIds(existingItemIds)
    : {};

  const multiAssetFieldIdSet = new Set(
    fields.filter((f) => isMultipleAssetField(f)).map((f) => f.id)
  );
  const attachmentFieldIds = new Map<string, AttachmentFieldInfo>();
  for (const mapping of fieldMapping) {
    if (mapping.airtableFieldType === 'multipleAttachments' && isAssetFieldType(mapping.cmsFieldType as CollectionFieldType)) {
      const category = getAssetCategoryForField(mapping.cmsFieldType as CollectionFieldType);
      attachmentFieldIds.set(mapping.cmsFieldId, {
        isMultiple: multiAssetFieldIdSet.has(mapping.cmsFieldId),
        allowedMimeTypes: ALLOWED_MIME_TYPES[category],
      });
    }
  }

  const slugField = fields.find((f) => f.key === SLUG_FIELD_KEY);
  const slugIsMapped = slugField
    ? fieldMapping.some((m) => m.cmsFieldId === slugField.id)
    : false;

  let slugCtx: SlugContext | null = null;
  if (slugIsMapped && slugField) {
    const existingSlugs = new Set<string>();
    for (const item of existingItems) {
      const slug = existingValues[item.id]?.[slugField.id];
      if (slug) existingSlugs.add(slug);
    }
    slugCtx = { slugFieldId: slugField.id, existingSlugs };
  }

  const idField = fields.find((f) => f.key === 'id');
  const createdAtField = fields.find((f) => f.key === 'created_at');
  const updatedAtField = fields.find((f) => f.key === 'updated_at');

  const autoFields: AutoFields = {
    idFieldId: idField?.id ?? null,
    createdAtFieldId: createdAtField?.id ?? null,
    updatedAtFieldId: updatedAtField?.id ?? null,
  };

  const prevFingerprints = new Map<string, string>(
    Object.entries(connection.attachmentFingerprints ?? {})
  );

  const referenceResolvers = await buildReferenceResolvers(fieldMapping, fields);

  const ctx: SyncContext = {
    fieldMapping,
    recordIdFieldId,
    slugCtx,
    assetCache: new Map<string, string>(),
    attachmentFieldIds,
    attachmentFingerprintCache: prevFingerprints,
    autoFields,
    referenceResolvers,
  };

  const recordIdToCmsItem = new Map<string, string>();
  for (const item of existingItems) {
    const vals = existingValues[item.id];
    if (vals?.[recordIdFieldId]) {
      recordIdToCmsItem.set(vals[recordIdFieldId], item.id);
    }
  }

  return { ctx, existingItems, existingValues, recordIdToCmsItem, connectionId: connection.id, collectionId, result };
}

/** Classify Airtable records into creates and updates based on existing CMS data */
async function classifyRecords(
  records: AirtableRecord[],
  state: SyncState
): Promise<{
  toCreate: AirtableRecord[];
  toUpdate: Array<{ cmsItemId: string; values: Record<string, string | null> }>;
  seenCmsItemIds: Set<string>;
}> {
  const seenCmsItemIds = new Set<string>();
  const toCreate: AirtableRecord[] = [];
  const toUpdate: Array<{ cmsItemId: string; values: Record<string, string | null> }> = [];

  for (const record of records) {
    const cmsItemId = state.recordIdToCmsItem.get(record.id);
    if (cmsItemId) {
      seenCmsItemIds.add(cmsItemId);
      const newValues = await buildRecordValues(record, state.ctx, state.existingValues[cmsItemId] as Record<string, string>);
      if (hasChanges(newValues, state.existingValues[cmsItemId])) {
        if (state.ctx.autoFields.updatedAtFieldId) {
          newValues[state.ctx.autoFields.updatedAtFieldId] = new Date().toISOString();
        }
        toUpdate.push({ cmsItemId, values: newValues });
      }
    } else {
      toCreate.push(record);
    }
  }

  return { toCreate, toUpdate, seenCmsItemIds };
}

/** Execute batch create, update, and delete operations. Mutates state.result. */
async function executeBatchOperations(
  state: SyncState,
  toCreate: AirtableRecord[],
  toUpdate: Array<{ cmsItemId: string; values: Record<string, string | null> }>,
  toDeleteIds: string[]
): Promise<void> {
  const { ctx, existingItems, existingValues, collectionId, result } = state;

  if (toCreate.length > 0) {
    try {
      // Re-check DB to filter out records a concurrent invocation already created
      const alreadyCreated = await getExistingAirtableRecordIds(
        ctx.recordIdFieldId,
        toCreate.map((r) => r.id)
      );
      const dedupedToCreate = alreadyCreated.size > 0
        ? toCreate.filter((r) => !alreadyCreated.has(r.id))
        : toCreate;

      if (dedupedToCreate.length > 0) {
        const newItemIds = dedupedToCreate.map(() => randomUUID());
        const newItems = newItemIds.map((id) => ({
          id,
          collection_id: collectionId,
          manual_order: 0,
          is_published: false,
          is_publishable: true,
        }));

        let nextAutoId = 1;
        if (ctx.autoFields.idFieldId) {
          for (const item of existingItems) {
            const val = existingValues[item.id]?.[ctx.autoFields.idFieldId];
            if (val) {
              const num = parseInt(String(val), 10);
              if (!isNaN(num) && num >= nextAutoId) nextAutoId = num + 1;
            }
          }
        }

        const buildValues = async () => {
          const now = new Date().toISOString();
          const valuesToInsert: Array<{ item_id: string; field_id: string; value: string | null }> = [];
          for (let i = 0; i < dedupedToCreate.length; i++) {
            const vals = await buildRecordValues(dedupedToCreate[i], ctx);

            if (ctx.autoFields.idFieldId) {
              vals[ctx.autoFields.idFieldId] = String(nextAutoId++);
            }
            if (ctx.autoFields.createdAtFieldId) {
              vals[ctx.autoFields.createdAtFieldId] = now;
            }
            if (ctx.autoFields.updatedAtFieldId) {
              vals[ctx.autoFields.updatedAtFieldId] = now;
            }

            for (const [fieldId, value] of Object.entries(vals)) {
              valuesToInsert.push({ item_id: newItemIds[i], field_id: fieldId, value });
            }
          }
          return valuesToInsert;
        };

        const [, valuesToInsert] = await Promise.all([
          createItemsBulk(newItems),
          buildValues(),
        ]);

        for (let i = 0; i < valuesToInsert.length; i += BULK_CHUNK_SIZE) {
          await insertValuesBulk(valuesToInsert.slice(i, i + BULK_CHUNK_SIZE));
        }

        result.created = dedupedToCreate.length;
      }
    } catch (error) {
      result.errors.push(`Create failed: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  if (toUpdate.length > 0) {
    try {
      await batchUpsertValues(toUpdate);
      result.updated = toUpdate.length;
    } catch (error) {
      result.errors.push(`Update failed: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  if (toDeleteIds.length > 0) {
    try {
      await batchSoftDelete(toDeleteIds);
      result.deleted = toDeleteIds.length;
    } catch (error) {
      result.errors.push(`Delete failed: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  if (ctx.attachmentFingerprintCache.size > 0) {
    await updateConnection(state.connectionId, {
      attachmentFingerprints: Object.fromEntries(ctx.attachmentFingerprintCache),
    });
  }
}

// =============================================================================
// Reconciliation
// =============================================================================

/** Full reconciliation — compares all Airtable records against all CMS items */
async function reconcileRecords(
  connection: AirtableConnection,
  airtableRecords: AirtableRecord[]
): Promise<SyncResult> {
  const state = await prepareSyncState(connection);
  const { toCreate, toUpdate, seenCmsItemIds } = await classifyRecords(airtableRecords, state);

  // Full sync: items with an airtable_id not present in the fetched data are deleted
  const toDeleteIds = state.existingItems
    .filter((item) => state.existingValues[item.id]?.[connection.recordIdFieldId] && !seenCmsItemIds.has(item.id))
    .map((item) => item.id);

  await executeBatchOperations(state, toCreate, toUpdate, toDeleteIds);
  return state.result;
}

/** Incremental reconciliation — only processes specific records + explicit deletes */
async function incrementalReconcile(
  connection: AirtableConnection,
  records: AirtableRecord[],
  destroyedRecordIds: string[]
): Promise<SyncResult> {
  const state = await prepareSyncState(connection);
  const { toCreate, toUpdate } = await classifyRecords(records, state);

  // Incremental: deletes come directly from the webhook payload
  const toDeleteIds = destroyedRecordIds
    .map((id) => state.recordIdToCmsItem.get(id))
    .filter((id): id is string => !!id);

  await executeBatchOperations(state, toCreate, toUpdate, toDeleteIds);
  return state.result;
}

// =============================================================================
// Batch Database Helpers
// =============================================================================

/**
 * Bulk upsert values using Knex raw SQL.
 * Supabase's .upsert() can't target the partial unique index
 * (WHERE deleted_at IS NULL), but raw ON CONFLICT can.
 */
async function batchUpsertValues(
  items: Array<{ cmsItemId: string; values: Record<string, string | null> }>
): Promise<void> {
  const { getKnexClient } = await import('@/lib/knex-client');
  const { getTenantIdFromHeaders } = await import('@/lib/supabase-server');
  const knex = await getKnexClient();
  const tenantId = await getTenantIdFromHeaders();

  const now = new Date().toISOString();
  const rows = items.flatMap(({ cmsItemId, values }) =>
    Object.entries(values).map(([fieldId, value]) => ({
      id: randomUUID(),
      item_id: cmsItemId,
      field_id: fieldId,
      value,
      is_published: false,
      created_at: now,
      updated_at: now,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    }))
  );

  // Build column list dynamically based on whether tenant_id is present
  const cols = tenantId
    ? 'id, item_id, field_id, value, is_published, created_at, updated_at, tenant_id'
    : 'id, item_id, field_id, value, is_published, created_at, updated_at';
  const placeholders = tenantId
    ? '(?, ?, ?, ?, ?, ?, ?, ?)'
    : '(?, ?, ?, ?, ?, ?, ?)';

  for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_CHUNK_SIZE);

    const params = tenantId
      ? chunk.flatMap((r) => [r.id, r.item_id, r.field_id, r.value, r.is_published, r.created_at, r.updated_at, tenantId])
      : chunk.flatMap((r) => [r.id, r.item_id, r.field_id, r.value, r.is_published, r.created_at, r.updated_at]);

    await knex.raw(
      `INSERT INTO collection_item_values (${cols})
       VALUES ${chunk.map(() => placeholders).join(', ')}
       ON CONFLICT (item_id, field_id, is_published) WHERE deleted_at IS NULL
       DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      params
    );
  }
}

/** Soft-delete multiple items in a single query */
async function batchSoftDelete(itemIds: string[]): Promise<void> {
  const client = await getSupabaseAdmin();
  if (!client) throw new Error('Supabase not configured');

  const now = new Date().toISOString();

  const { error } = await client
    .from('collection_items')
    .update({ deleted_at: now, updated_at: now })
    .in('id', itemIds)
    .eq('is_published', false);

  if (error) throw new Error(`Batch delete failed: ${error.message}`);
}
