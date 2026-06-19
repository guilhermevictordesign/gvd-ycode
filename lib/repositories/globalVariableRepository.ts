/**
 * Global Variable Repository
 *
 * Data access layer for global variables: site-wide typed singletons
 * (Name / Type / Value) that can be injected into any layer property accepting
 * a matching CMS field type.
 *
 * Supports the draft/published workflow via the composite primary key
 * (id, is_published), same pattern as pages, components, layer_styles, and
 * collection fields/values. Change detection compares the draft signature
 * against the published one (globals are small, so no content_hash column).
 */

import { cache } from 'react';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import type {
  GlobalVariable,
  CreateGlobalVariableData,
  UpdateGlobalVariableData,
} from '@/types';

/** Deterministic signature of the publishable fields, for change detection. */
function globalSignature(v: GlobalVariable): string {
  return JSON.stringify({
    name: v.name,
    key: v.key,
    type: v.type,
    value: v.value,
    data: v.data ?? {},
    order: v.order,
  });
}

/**
 * Fetch all active global variables for the given publish mode.
 *
 * Wrapped in React `cache()` for request-scoped memoization: a single page
 * render resolves globals from several independent code paths (PageRenderer,
 * page-fetcher's collection-layer resolution, and the dynamic-page injection
 * step). Without this, the same small table would be queried 2–3× per request.
 * `cache()` dedupes them to one round-trip per (isPublished) value per request,
 * while still returning fresh data on the next request.
 */
export const getAllGlobalVariables = cache(async (
  isPublished: boolean = false
): Promise<GlobalVariable[]> => {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('global_variables')
    .select('*')
    .eq('is_published', isPublished)
    .is('deleted_at', null)
    .order('order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch global variables: ${error.message}`);
  }

  return data || [];
});

export async function getGlobalVariableById(
  id: string,
  isPublished: boolean = false
): Promise<GlobalVariable | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('global_variables')
    .select('*')
    .eq('id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to fetch global variable: ${error.message}`);
  }

  return data;
}

export async function createGlobalVariable(
  variableData: CreateGlobalVariableData
): Promise<GlobalVariable> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Append at end unless an explicit order was provided
  let order = variableData.order;
  if (order === undefined) {
    const { data: maxRow } = await client
      .from('global_variables')
      .select('order')
      .eq('is_published', false)
      .order('order', { ascending: false })
      .limit(1)
      .single();
    order = (maxRow?.order ?? -1) + 1;
  }

  const { data, error } = await client
    .from('global_variables')
    .insert({
      name: variableData.name,
      key: variableData.key ?? null,
      type: variableData.type,
      value: variableData.value ?? null,
      data: variableData.data ?? {},
      order,
      is_published: false,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create global variable: ${error.message}`);
  }

  return data;
}

export async function updateGlobalVariable(
  id: string,
  updates: UpdateGlobalVariableData
): Promise<GlobalVariable> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('global_variables')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('is_published', false) // Update draft only
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update global variable: ${error.message}`);
  }

  return data;
}

/**
 * Soft delete a global variable. Sets deleted_at on the *draft* row only, so the
 * builder hides it immediately while the published row keeps serving the live
 * site until the next publish removes it. Keeping the published row intact also
 * lets change detection surface the pending deletion in the publish modal.
 */
export async function softDeleteGlobalVariable(id: string): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { error } = await client
    .from('global_variables')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('is_published', false);

  if (error) {
    throw new Error(`Failed to delete global variable: ${error.message}`);
  }
}

/**
 * Get draft globals that are new or differ from their published counterpart,
 * plus soft-deleted drafts that still have a live published row (pending
 * deletion). Used to surface "unpublished changes" and drive the publish step.
 */
export async function getUnpublishedGlobalVariables(): Promise<GlobalVariable[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data: drafts, error } = await client
    .from('global_variables')
    .select('*')
    .eq('is_published', false);

  if (error) {
    throw new Error(`Failed to fetch draft global variables: ${error.message}`);
  }

  if (!drafts || drafts.length === 0) {
    return [];
  }

  const { data: published } = await client
    .from('global_variables')
    .select('*')
    .in('id', drafts.map((d) => d.id))
    .eq('is_published', true);

  const publishedById = new Map<string, GlobalVariable>(
    (published || []).map((p) => [p.id, p])
  );

  const unpublished: GlobalVariable[] = [];
  for (const draft of drafts) {
    const live = publishedById.get(draft.id);

    // Pending deletion: draft soft-deleted but a live row still exists
    if (draft.deleted_at) {
      if (live && !live.deleted_at) {
        unpublished.push(draft);
      }
      continue;
    }

    // New or changed
    if (!live || live.deleted_at || globalSignature(draft) !== globalSignature(live)) {
      unpublished.push(draft);
    }
  }

  return unpublished;
}

export async function getUnpublishedGlobalVariablesCount(): Promise<number> {
  const globals = await getUnpublishedGlobalVariables();
  return globals.length;
}

/**
 * Publish global variables (dual-record pattern).
 *
 * Copies changed draft rows into their published counterparts and removes
 * published rows whose draft was soft-deleted. Returns the number of rows
 * affected (upserts + deletions).
 */
export async function publishGlobalVariables(): Promise<{ count: number; changedIds: string[] }> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data: drafts, error } = await client
    .from('global_variables')
    .select('*')
    .eq('is_published', false);

  if (error) {
    throw new Error(`Failed to fetch draft global variables: ${error.message}`);
  }

  if (!drafts || drafts.length === 0) {
    return { count: 0, changedIds: [] };
  }

  const { data: published } = await client
    .from('global_variables')
    .select('*')
    .in('id', drafts.map((d) => d.id))
    .eq('is_published', true);

  const publishedById = new Map<string, GlobalVariable>(
    (published || []).map((p) => [p.id, p])
  );

  const now = new Date().toISOString();
  const deletedIds: string[] = [];
  const toUpsert: Record<string, unknown>[] = [];

  for (const draft of drafts) {
    const live = publishedById.get(draft.id);

    // Soft-deleted draft -> remove the published row
    if (draft.deleted_at) {
      if (live) deletedIds.push(draft.id);
      continue;
    }

    // New or changed -> upsert published version
    if (!live || globalSignature(draft) !== globalSignature(live)) {
      toUpsert.push({
        id: draft.id,
        name: draft.name,
        key: draft.key,
        type: draft.type,
        value: draft.value,
        data: draft.data ?? {},
        order: draft.order,
        is_published: true,
        updated_at: now,
      });
    }
  }

  if (toUpsert.length > 0) {
    const { error: upsertError } = await client
      .from('global_variables')
      .upsert(toUpsert, { onConflict: 'id,is_published' });

    if (upsertError) {
      throw new Error(`Failed to publish global variables: ${upsertError.message}`);
    }
  }

  if (deletedIds.length > 0) {
    const { error: deleteError } = await client
      .from('global_variables')
      .delete()
      .in('id', deletedIds)
      .eq('is_published', true);

    if (deleteError) {
      throw new Error(`Failed to remove published global variables: ${deleteError.message}`);
    }
  }

  const changedIds = [...toUpsert.map((u) => u.id as string), ...deletedIds];
  return { count: changedIds.length, changedIds };
}

/**
 * Hard-delete soft-deleted draft global variables (and any leftover published
 * counterparts). Called after publish to reclaim rows.
 */
export async function hardDeleteSoftDeletedGlobalVariables(): Promise<{ count: number }> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data: deletedDrafts, error } = await client
    .from('global_variables')
    .select('id')
    .eq('is_published', false)
    .not('deleted_at', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch deleted draft global variables: ${error.message}`);
  }

  if (!deletedDrafts || deletedDrafts.length === 0) {
    return { count: 0 };
  }

  const ids = deletedDrafts.map((d) => d.id);

  const { error: deleteError } = await client
    .from('global_variables')
    .delete()
    .in('id', ids);

  if (deleteError) {
    throw new Error(`Failed to hard delete global variables: ${deleteError.message}`);
  }

  return { count: deletedDrafts.length };
}
