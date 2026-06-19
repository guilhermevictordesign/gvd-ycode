/**
 * Project Service
 *
 * Handles exporting and importing project data as portable .ycode dumps.
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import type { Knex } from 'knex';
import { getKnexClient, closeKnexClient, testKnexConnection } from '../knex-client';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { STORAGE_BUCKET, STORAGE_FOLDERS } from '@/lib/asset-constants';
import { migrations } from '../migrations-loader';
import { guardKnexForMigrationReplay } from '@/lib/migration-replay-guard';

/**
 * Tables in FK-safe order (parents before children).
 * Used for both export (insert order) and import.
 */
export const CONTENT_TABLES = [
  'settings',
  'fonts',
  'asset_folders',
  'assets',
  'page_folders',
  'pages',
  'page_layers',
  'layer_styles',
  'components',
  'collections',
  'collection_fields',
  'collection_items',
  'collection_item_values',
  'collection_imports',
  'locales',
  'translations',
  'versions',
  'webhooks',
  'webhook_deliveries',
  'api_keys',
  'app_settings',
  'form_submissions',
  'color_variables',
  'global_variables',
];

/**
 * Tables to truncate before import (children first for FK safety).
 */
export const TABLES_TO_TRUNCATE = [
  'global_variables',
  'color_variables',
  'webhook_deliveries',
  'form_submissions',
  'translations',
  'locales',
  'versions',
  'collection_imports',
  'collection_item_values',
  'collection_items',
  'collection_fields',
  'collections',
  'layer_styles',
  'components',
  'page_layers',
  'pages',
  'page_folders',
  'assets',
  'asset_folders',
  'fonts',
  'webhooks',
  'api_keys',
  'app_settings',
  'settings',
];

export const GLOBAL_EXCLUDED_COLUMNS = [
  'tenant_id',
  'deleted_at',
  'created_at',
  'updated_at',
  'content_hash',
];

export const TABLE_EXCLUDED_COLUMNS: Record<string, string[]> = {};

export const SUPPORTED_VERSION = '1.0.0';
export const BATCH_SIZE = 500;

import { ToastError } from '../toast-error';
export { ToastError };

// ─── Types ───────────────────────────────────────────────────────────

export interface ProjectManifest {
  version: string;
  exportedAt: string;
  source: 'cloud' | 'opensource';
  projectName: string;
  tables: string[];
  stats: {
    pages: number;
    components: number;
    collections: number;
    assets?: number;
  };
  lastMigration?: string;
}

export interface ExportFile {
  storagePath: string;
  base64: string;
  mimeType: string;
}

export interface ProjectExportData {
  manifest: ProjectManifest;
  data: Record<string, Record<string, unknown>[]>;
  files?: ExportFile[];
}

export interface ProjectExportResult {
  success: boolean;
  export?: ProjectExportData;
  error?: string;
}

export interface ProjectImportResult {
  success: boolean;
  stats?: {
    pages: number;
    components: number;
    collections: number;
    assets?: number;
  };
  error?: string;
}

// ─── Encryption ──────────────────────────────────────────────────────

const ENCRYPTION_ALGO = 'aes-256-gcm';
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** 4-byte magic header to identify encrypted .ycode files. */
const ENCRYPTED_MAGIC = Buffer.from('YCEN');

/** Encrypt a buffer with a password using AES-256-GCM. */
export function encryptBuffer(data: Buffer, password: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const key = scryptSync(password, salt, 32);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPTED_MAGIC, salt, iv, authTag, encrypted]);
}

/** Decrypt a buffer that was encrypted with `encryptBuffer`. */
export function decryptBuffer(data: Buffer, password: string): Buffer {
  const magic = data.subarray(0, 4);
  if (!magic.equals(ENCRYPTED_MAGIC)) {
    throw new Error('File is not encrypted');
  }

  const offset = 4;
  const salt = data.subarray(offset, offset + SALT_LENGTH);
  const iv = data.subarray(offset + SALT_LENGTH, offset + SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(
    offset + SALT_LENGTH + IV_LENGTH,
    offset + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  );
  const encrypted = data.subarray(offset + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = scryptSync(password, salt, 32);
  const decipher = createDecipheriv(ENCRYPTION_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/** Check if a buffer starts with the encrypted magic header. */
export function isEncrypted(data: Buffer): boolean {
  return data.length >= 4 && data.subarray(0, 4).equals(ENCRYPTED_MAGIC);
}

/**
 * Pack export data into a .ycode file buffer.
 * Gzip-compresses the JSON; optionally encrypts with a password.
 */
export function packExport(exportData: ProjectExportData, password?: string): Buffer {
  const json = JSON.stringify(exportData);
  const compressed = gzipSync(Buffer.from(json, 'utf-8'));
  return password ? encryptBuffer(compressed, password) : compressed;
}

/**
 * Unpack a .ycode file buffer into export data.
 * Handles both encrypted and plain gzipped files.
 */
export function unpackImport(
  buffer: Buffer,
  password?: string
): ProjectExportData {
  let compressed: Buffer;

  if (isEncrypted(buffer)) {
    if (!password) {
      throw new ToastError('Password required', 'This backup file requires a password');
    }
    try {
      compressed = decryptBuffer(buffer, password);
    } catch (err) {
      if (err instanceof Error && err.message === 'File is not encrypted') throw err;
      throw new ToastError('Decryption failed', 'Incorrect password or corrupted backup file');
    }
  } else {
    compressed = buffer;
  }

  const jsonString = gunzipSync(compressed).toString('utf-8');
  const parsed = JSON.parse(jsonString);

  if (!parsed.manifest || !parsed.data) {
    throw new ToastError('Invalid backup file', 'The backup file structure is not valid');
  }

  return parsed as ProjectExportData;
}

// ─── Schema Cache ───────────────────────────────────────────────────

export interface SchemaInfo {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
  jsonColumns: Map<string, Set<string>>;
}

/**
 * Fetch all table/column info in a single query instead of N hasTable/hasColumn calls.
 * Also identifies json/jsonb columns for proper serialization on insert.
 */
export async function loadSchemaInfo(
  db: Knex,
  tableNames: string[]
): Promise<SchemaInfo> {
  const { rows } = await db.raw<{ rows: { table_name: string; column_name: string; data_type: string }[] }>(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY(?)`,
    [tableNames]
  );

  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const jsonColumns = new Map<string, Set<string>>();

  for (const row of rows) {
    tables.add(row.table_name);
    if (!columns.has(row.table_name)) {
      columns.set(row.table_name, new Set());
    }
    columns.get(row.table_name)!.add(row.column_name);

    if (row.data_type === 'json' || row.data_type === 'jsonb') {
      if (!jsonColumns.has(row.table_name)) {
        jsonColumns.set(row.table_name, new Set());
      }
      jsonColumns.get(row.table_name)!.add(row.column_name);
    }
  }

  return { tables, columns, jsonColumns };
}

// ─── Shared Helpers ──────────────────────────────────────────────────

const DEFAULT_PROJECT_NAME = 'ycode-app';

export async function getProjectName(
  knex: Awaited<ReturnType<typeof getKnexClient>>
): Promise<string> {
  try {
    const hasSettings = await knex.schema.hasTable('settings');
    if (!hasSettings) return DEFAULT_PROJECT_NAME;

    const row = await knex('settings')
      .where('key', 'site_name')
      .first('value');

    if (row?.value) {
      const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
    }

    return DEFAULT_PROJECT_NAME;
  } catch {
    return DEFAULT_PROJECT_NAME;
  }
}

export async function getLatestMigrationName(
  knex: Awaited<ReturnType<typeof getKnexClient>>
): Promise<string | null> {
  try {
    const tableExists = await knex.schema.hasTable('migrations');
    if (!tableExists) return null;

    const result = await knex('migrations')
      .orderBy('migration_time', 'desc')
      .first('name');

    return result?.name || null;
  } catch {
    return null;
  }
}

export function stripColumns(
  row: Record<string, unknown>,
  table: string
): Record<string, unknown> {
  const tableExclusions = TABLE_EXCLUDED_COLUMNS[table] || [];
  const allExcluded = [...GLOBAL_EXCLUDED_COLUMNS, ...tableExclusions];

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!allExcluded.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

export function getPendingMigrations(
  lastMigration: string | null | undefined
): typeof migrations {
  if (!lastMigration) return migrations;

  const idx = migrations.findIndex((m) => m.name === lastMigration);
  if (idx === -1) return [];

  return migrations.slice(idx + 1);
}

export function validateManifest(manifest: ProjectManifest): string | null {
  if (!manifest.version) return 'Missing manifest version';
  if (manifest.version !== SUPPORTED_VERSION) {
    return `Unsupported version: ${manifest.version} (expected ${SUPPORTED_VERSION})`;
  }
  if (manifest.source !== 'cloud' && manifest.source !== 'opensource') {
    return 'Invalid export source';
  }
  if (!manifest.tables || !Array.isArray(manifest.tables)) return 'Missing tables list';
  return null;
}

/** Sanitize a project name into a slug-safe string (lowercase, alphanumeric, hyphens). */
export function sanitizeProjectNameSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || DEFAULT_PROJECT_NAME;
}

/** Generate a filename for a .ycode export from the manifest. */
export function getExportFilename(manifest: ProjectManifest): string {
  const name = sanitizeProjectNameSlug(manifest.projectName || DEFAULT_PROJECT_NAME);
  const ts = new Date(manifest.exportedAt).toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '-');
  return `${name}-${ts}.ycode`;
}

// ─── Concurrency Helper ─────────────────────────────────────────────

const STORAGE_CONCURRENCY = 10;

/**
 * Process items with a concurrency limit.
 * Returns only successful results (failures are logged and skipped).
 */
export async function processInParallel<T, R>(
  items: T[],
  fn: (item: T) => Promise<R | null>,
  concurrency = STORAGE_CONCURRENCY
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value !== null) {
        results.push(result.value);
      }
    }
  }
  return results;
}

/** Generate a unique storage path for an uploaded asset. */
export function generateStoragePath(originalPath: string): string {
  const extension = originalPath.split('.').pop() || 'bin';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${STORAGE_FOLDERS.WEBSITE}/${timestamp}-${random}.${extension}`;
}

// ─── Asset File Helpers ──────────────────────────────────────────────

/** Collect asset files from Supabase Storage as base64 (parallel). */
export async function collectAssetFiles(
  assetRows: Record<string, unknown>[]
): Promise<ExportFile[]> {
  const client = await getSupabaseAdmin();
  if (!client) return [];

  const storagePaths = assetRows
    .map(r => r.storage_path as string | null)
    .filter((p): p is string => !!p);

  const uniquePaths = [...new Set(storagePaths)];
  if (uniquePaths.length === 0) return [];

  return processInParallel(uniquePaths, async (storagePath): Promise<ExportFile | null> => {
    try {
      const { data, error } = await client.storage
        .from(STORAGE_BUCKET)
        .download(storagePath);

      if (error || !data) {
        console.warn(`[collectAssetFiles] Failed to download ${storagePath}:`, error);
        return null;
      }

      const buffer = await data.arrayBuffer();
      return {
        storagePath,
        base64: Buffer.from(buffer).toString('base64'),
        mimeType: data.type || 'application/octet-stream',
      };
    } catch (err) {
      console.warn(`[collectAssetFiles] Error processing ${storagePath}:`, err);
      return null;
    }
  });
}

/** Upload asset files to Supabase Storage and batch-update DB records. */
export async function restoreAssetFiles(
  files: ExportFile[],
  db: Knex
): Promise<void> {
  const client = await getSupabaseAdmin();
  if (!client || files.length === 0) return;

  const pathUpdates = await processInParallel(files, async (file): Promise<{ oldPath: string; newPath: string; publicUrl: string } | null> => {
    try {
      const buffer = Buffer.from(file.base64, 'base64');
      const newPath = generateStoragePath(file.storagePath);

      const { data, error } = await client.storage
        .from(STORAGE_BUCKET)
        .upload(newPath, buffer, {
          contentType: file.mimeType,
          cacheControl: '3600',
          upsert: false,
        });

      if (error || !data) {
        console.warn(`[restoreAssetFiles] Failed to upload ${file.storagePath}:`, error);
        return null;
      }

      const { data: urlData } = client.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(data.path);

      return { oldPath: file.storagePath, newPath: data.path, publicUrl: urlData.publicUrl };
    } catch (err) {
      console.warn(`[restoreAssetFiles] Error uploading ${file.storagePath}:`, err);
      return null;
    }
  });

  if (pathUpdates.length === 0) return;

  // Batch DB updates using a single raw query with CASE expressions
  const whenStorage = pathUpdates.map((_, i) => `WHEN ? THEN ?`).join(' ');
  const whenUrl = pathUpdates.map((_, i) => `WHEN ? THEN ?`).join(' ');
  const oldPaths = pathUpdates.map(u => u.oldPath);
  const storageBindings = pathUpdates.flatMap(u => [u.oldPath, u.newPath]);
  const urlBindings = pathUpdates.flatMap(u => [u.oldPath, u.publicUrl]);

  await db.raw(
    `UPDATE assets
     SET storage_path = CASE storage_path ${whenStorage} END,
         public_url = CASE storage_path ${whenUrl} END
     WHERE storage_path IN (${oldPaths.map(() => '?').join(', ')})`,
    [...storageBindings, ...urlBindings, ...oldPaths]
  );
}

// ─── Export ──────────────────────────────────────────────────────────

/** Export the project as portable JSON data. */
export async function exportProject(): Promise<ProjectExportResult> {
  const canConnect = await testKnexConnection();
  if (!canConnect) {
    return {
      success: false,
      error: 'Cannot connect to database. Please check your configuration.',
    };
  }

  const knex = await getKnexClient();

  try {
    const allTables = [...new Set([...CONTENT_TABLES, 'settings', 'migrations'])];
    const schema = await loadSchemaInfo(knex, allTables);

    const data: Record<string, Record<string, unknown>[]> = {};
    const stats: ProjectManifest['stats'] = { pages: 0, components: 0, collections: 0 };

    for (const table of CONTENT_TABLES) {
      if (!schema.tables.has(table)) continue;
      const cols = schema.columns.get(table)!;

      let query = knex(table);

      if (cols.has('deleted_at')) {
        query = query.whereNull('deleted_at');
      }

      const rows = await query.select('*');
      if (rows.length === 0) continue;

      if (table === 'pages') stats.pages = rows.length;
      if (table === 'components') stats.components = rows.length;
      if (table === 'collections') stats.collections = rows.length;

      data[table] = rows.map((row: Record<string, unknown>) => stripColumns(row, table));
    }

    const assetRows = data['assets'] || [];
    const files = await collectAssetFiles(assetRows);

    if (assetRows.length > 0) {
      stats.assets = assetRows.length;
    }

    const lastMigration = await getLatestMigrationName(knex);
    const projectName = await getProjectName(knex);

    const manifest: ProjectManifest = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      source: 'opensource',
      projectName,
      tables: Object.keys(data),
      stats,
      lastMigration: lastMigration || undefined,
    };

    return {
      success: true,
      export: { manifest, data, files: files.length > 0 ? files : undefined },
    };
  } catch (error) {
    console.error('[exportProject] Failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Export failed',
    };
  } finally {
    await closeKnexClient();
  }
}

/**
 * Stringify values for json/jsonb columns so pg can accept them on insert.
 * If `jsonCols` is provided, ALL non-null values in those columns are stringified
 * (handles plain strings/numbers that pg auto-unwraps on read but rejects on write).
 * Object/array values are always stringified regardless.
 */
export function serializeJsonColumns(
  row: Record<string, unknown>,
  jsonCols?: Set<string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && jsonCols?.has(key)) {
      result[key] = JSON.stringify(value);
    } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Import ──────────────────────────────────────────────────────────

/**
 * Import a project dump into the local database.
 * Truncates all content tables and inserts the imported data.
 */
export async function importProject(
  manifest: ProjectManifest,
  data: Record<string, Record<string, unknown>[]>,
  files?: ExportFile[]
): Promise<ProjectImportResult> {
  const validationError = validateManifest(manifest);
  if (validationError) {
    return { success: false, error: validationError };
  }

  const canConnect = await testKnexConnection();
  if (!canConnect) {
    return {
      success: false,
      error: 'Cannot connect to database. Please check your configuration.',
    };
  }

  const knex = await getKnexClient();

  try {
    const allTables = [...new Set([...CONTENT_TABLES, ...TABLES_TO_TRUNCATE])];
    const schema = await loadSchemaInfo(knex, allTables);

    await knex.transaction(async (trx) => {
      await trx.raw('SET session_replication_role = replica');

      const existingTables = TABLES_TO_TRUNCATE.filter(t => schema.tables.has(t));
      if (existingTables.length > 0) {
        await trx.raw(`TRUNCATE ${existingTables.join(', ')} CASCADE;`);
      }

      for (const table of CONTENT_TABLES) {
        const rows = data[table];
        if (!rows || rows.length === 0) continue;
        if (!schema.tables.has(table)) continue;

        const jsonCols = schema.jsonColumns.get(table);
        const serialized = rows.map(r => serializeJsonColumns(r, jsonCols));
        for (let i = 0; i < serialized.length; i += BATCH_SIZE) {
          const batch = serialized.slice(i, i + BATCH_SIZE);
          await trx(table).insert(batch);
        }
      }

      await trx.raw('SET session_replication_role = DEFAULT');
    });

    if (files && files.length > 0) {
      await restoreAssetFiles(files, knex);
    }

    // Destructive DDL is blocked: these up()s replay against live data.
    const guardedKnex = guardKnexForMigrationReplay(knex);
    const pending = getPendingMigrations(manifest.lastMigration);
    for (const migration of pending) {
      try {
        await migration.up(guardedKnex);
      } catch (error) {
        console.warn(
          `[importProject] Migration ${migration.name} failed (may be expected for schema-only):`,
          error
        );
      }
    }

    return {
      success: true,
      stats: manifest.stats,
    };
  } catch (error) {
    console.error('[importProject] Failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Import failed',
    };
  } finally {
    await closeKnexClient();
  }
}
