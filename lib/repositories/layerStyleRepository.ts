/**
 * Layer Style Repository
 *
 * Data access layer for layer styles (reusable design configurations)
 * Supports draft/published workflow with content hash-based change detection
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import type { LayerStyle, Layer, ComponentVariant } from '@/types';
import {
  generateLayerStyleContentHash,
  generatePageLayersHash,
  generateComponentContentHash,
} from '../hash-utils';
import { updateLayersWithStyle, detachStyleFromLayers, getStyleIds } from '@/lib/layer-style-utils';

/**
 * Input data for creating a new layer style
 */
export interface CreateLayerStyleData {
  name: string;
  classes: string;
  design?: LayerStyle['design'];
  group?: string;
}

/**
 * Affected entity when deleting a layer style
 */
export interface LayerStyleAffectedEntity {
  type: 'page' | 'component';
  id: string;
  name: string;
  pageId?: string; // For pages, this is the page.id (not page_layers.id)
  previousLayers: Layer[];
  newLayers: Layer[];
  previousVariants?: ComponentVariant[];
  newVariants?: ComponentVariant[];
}

/**
 * Result of soft delete operation
 */
export interface LayerStyleSoftDeleteResult {
  layerStyle: LayerStyle;
  affectedEntities: LayerStyleAffectedEntity[];
}

/**
 * Get all layer styles (draft by default, excludes soft deleted)
 */
export async function getAllStyles(isPublished: boolean = false): Promise<LayerStyle[]> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('layer_styles')
    .select('*')
    .eq('is_published', isPublished)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch layer styles: ${error.message}`);
  }

  return data || [];
}

/**
 * Get a single layer style by ID (draft by default, excludes soft deleted)
 * With composite primary key, we need to specify is_published to get a single row
 */
export async function getStyleById(id: string, isPublished: boolean = false): Promise<LayerStyle | null> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('layer_styles')
    .select('*')
    .eq('id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch layer style: ${error.message}`);
  }

  return data;
}

/**
 * Get a layer style by ID including soft deleted (for restoration)
 */
export async function getStyleByIdIncludingDeleted(id: string, isPublished: boolean = false): Promise<LayerStyle | null> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('layer_styles')
    .select('*')
    .eq('id', id)
    .eq('is_published', isPublished)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch layer style: ${error.message}`);
  }

  return data;
}

/**
 * Create a new layer style (draft by default)
 */
export async function createStyle(
  styleData: CreateLayerStyleData
): Promise<LayerStyle> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  // Calculate content hash
  const contentHash = generateLayerStyleContentHash({
    name: styleData.name,
    classes: styleData.classes,
    design: styleData.design,
  });

  const { data, error } = await client
    .from('layer_styles')
    .insert({
      name: styleData.name,
      classes: styleData.classes,
      design: styleData.design,
      group: styleData.group,
      content_hash: contentHash,
      is_published: false,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create layer style: ${error.message}`);
  }

  return data;
}

/**
 * Update a layer style and recalculate content hash
 */
export async function updateStyle(
  id: string,
  updates: Partial<Pick<LayerStyle, 'name' | 'classes' | 'design'>>
): Promise<LayerStyle> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  // Get current style to merge with updates
  const current = await getStyleById(id);
  if (!current) {
    throw new Error('Layer style not found');
  }

  // Merge current data with updates for hash calculation
  const finalData = {
    name: updates.name !== undefined ? updates.name : current.name,
    classes: updates.classes !== undefined ? updates.classes : current.classes,
    design: updates.design !== undefined ? updates.design : current.design,
  };

  // Recalculate content hash
  const contentHash = generateLayerStyleContentHash(finalData);

  const { data, error } = await client
    .from('layer_styles')
    .update({
      ...updates,
      content_hash: contentHash,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('is_published', false) // Update draft version only
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update layer style: ${error.message}`);
  }

  return data;
}

/**
 * Get published layer style by ID
 * Used to find the published version of a draft layer style
 */
export async function getPublishedStyleById(id: string): Promise<LayerStyle | null> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('layer_styles')
    .select('*')
    .eq('id', id)
    .eq('is_published', true)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch published layer style: ${error.message}`);
  }

  return data;
}

/**
 * Publish a layer style (dual-record pattern like pages and components)
 * Creates/updates a separate published version while keeping draft untouched
 * Uses composite primary key (id, is_published) - same ID for draft and published versions
 */
export async function publishLayerStyle(draftStyleId: string): Promise<LayerStyle> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  // Get the draft style
  const draftStyle = await getStyleById(draftStyleId);
  if (!draftStyle) {
    throw new Error('Draft layer style not found');
  }

  // Upsert published version - composite key handles insert/update automatically
  const { data, error } = await client
    .from('layer_styles')
    .upsert({
      id: draftStyle.id, // Same ID for draft and published versions
      name: draftStyle.name,
      classes: draftStyle.classes,
      design: draftStyle.design,
      group: draftStyle.group,
      content_hash: draftStyle.content_hash, // Copy hash from draft
      is_published: true,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'id,is_published',
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to publish layer style: ${error.message}`);
  }

  return data;
}

/**
 * Publish multiple layer styles in batch
 * Only upserts styles whose content_hash actually changed.
 * Returns the IDs of styles that were modified.
 */
export async function publishLayerStyles(styleIds: string[]): Promise<{ count: number; changedStyleIds: string[] }> {
  if (styleIds.length === 0) {
    return { count: 0, changedStyleIds: [] };
  }

  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  // Batch fetch all draft styles (exclude soft-deleted)
  const { data: draftStyles, error: fetchError } = await client
    .from('layer_styles')
    .select('*')
    .in('id', styleIds)
    .eq('is_published', false)
    .is('deleted_at', null);

  if (fetchError) {
    throw new Error(`Failed to fetch draft layer styles: ${fetchError.message}`);
  }

  if (!draftStyles || draftStyles.length === 0) {
    return { count: 0, changedStyleIds: [] };
  }

  // Fetch existing published versions to compare hashes
  const { data: publishedStyles } = await client
    .from('layer_styles')
    .select('id, content_hash')
    .in('id', draftStyles.map(d => d.id))
    .eq('is_published', true);

  const publishedHashById = new Map<string, string>();
  if (publishedStyles) {
    for (const pub of publishedStyles) {
      if (pub.content_hash) publishedHashById.set(pub.id, pub.content_hash);
    }
  }

  // Only upsert styles that are new or have changed
  const stylesToUpsert = draftStyles
    .filter(draft => {
      const pubHash = publishedHashById.get(draft.id);
      return !pubHash || pubHash !== draft.content_hash;
    })
    .map(draft => ({
      id: draft.id,
      name: draft.name,
      classes: draft.classes,
      design: draft.design,
      group: draft.group,
      content_hash: draft.content_hash,
      is_published: true,
      updated_at: new Date().toISOString(),
    }));

  if (stylesToUpsert.length > 0) {
    const { error: upsertError } = await client
      .from('layer_styles')
      .upsert(stylesToUpsert, {
        onConflict: 'id,is_published',
      });

    if (upsertError) {
      throw new Error(`Failed to publish layer styles: ${upsertError.message}`);
    }
  }

  return {
    count: stylesToUpsert.length,
    changedStyleIds: stylesToUpsert.map(s => s.id),
  };
}

/**
 * Get all unpublished layer styles
 * A layer style needs publishing if:
 * - It has is_published: false (never published), OR
 * - Its draft content_hash differs from published content_hash (needs republishing)
 */
export async function getUnpublishedLayerStyles(): Promise<LayerStyle[]> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  // Get all draft layer styles (exclude soft-deleted)
  const { data: draftStyles, error } = await client
    .from('layer_styles')
    .select('*')
    .eq('is_published', false)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch draft layer styles: ${error.message}`);
  }

  if (!draftStyles || draftStyles.length === 0) {
    return [];
  }

  const unpublishedStyles: LayerStyle[] = [];

  // Batch fetch all published styles for the draft IDs
  const draftIds = draftStyles.map(s => s.id);
  const { data: publishedStyles, error: publishedError } = await client
    .from('layer_styles')
    .select('*')
    .in('id', draftIds)
    .eq('is_published', true);

  if (publishedError) {
    throw new Error(`Failed to fetch published layer styles: ${publishedError.message}`);
  }

  // Build lookup map
  const publishedById = new Map<string, LayerStyle>();
  (publishedStyles || []).forEach(s => publishedById.set(s.id, s));

  // Check each draft style
  for (const draftStyle of draftStyles) {
    // Check if published version exists
    const publishedStyle = publishedById.get(draftStyle.id);

    // If no published version exists, needs first-time publishing
    if (!publishedStyle) {
      unpublishedStyles.push(draftStyle);
      continue;
    }

    // Compare content hashes
    if (draftStyle.content_hash !== publishedStyle.content_hash) {
      unpublishedStyles.push(draftStyle);
    }
  }

  return unpublishedStyles;
}

/**
 * Hard-delete soft-deleted draft layer styles and their published counterparts.
 */
export async function hardDeleteSoftDeletedLayerStyles(): Promise<{ count: number }> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data: deletedDrafts, error } = await client
    .from('layer_styles')
    .select('id')
    .eq('is_published', false)
    .not('deleted_at', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch deleted draft layer styles: ${error.message}`);
  }

  if (!deletedDrafts || deletedDrafts.length === 0) {
    return { count: 0 };
  }

  const ids = deletedDrafts.map(s => s.id);

  const { error: pubError } = await client
    .from('layer_styles')
    .delete()
    .in('id', ids)
    .eq('is_published', true);

  if (pubError) {
    console.error('Failed to delete published layer styles:', pubError);
  }

  const { error: draftError } = await client
    .from('layer_styles')
    .delete()
    .in('id', ids)
    .eq('is_published', false)
    .not('deleted_at', 'is', null);

  if (draftError) {
    throw new Error(`Failed to delete draft layer styles: ${draftError.message}`);
  }

  return { count: deletedDrafts.length };
}

/**
 * Get count of unpublished layer styles
 */
export async function getUnpublishedLayerStylesCount(): Promise<number> {
  const styles = await getUnpublishedLayerStyles();
  return styles.length;
}

/**
 * Check if layers contain a reference to a specific layer style
 */
function layersContainStyle(layers: Layer[], styleId: string): boolean {
  for (const layer of layers) {
    if (getStyleIds(layer).includes(styleId)) {
      return true;
    }
    if (layer.children && layersContainStyle(layer.children, styleId)) {
      return true;
    }
  }
  return false;
}

/**
 * Find all entities (pages and components) using a layer style
 * Returns detailed info including previous and new layers for undo/redo
 */
export async function findEntitiesUsingLayerStyle(styleId: string): Promise<LayerStyleAffectedEntity[]> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const affectedEntities: LayerStyleAffectedEntity[] = [];

  // Snapshot all draft styles so combo stacks can be re-flattened the same way
  // the client does on detach — keeping client and server perfectly in sync.
  const { data: allDraftStyles } = await client
    .from('layer_styles')
    .select('*')
    .eq('is_published', false)
    .is('deleted_at', null);
  const stylesById = new Map<string, LayerStyle>(
    (allDraftStyles || []).map((s) => [s.id, s as LayerStyle])
  );

  // Find affected page_layers
  const { data: pageLayersRecords, error: pageError } = await client
    .from('page_layers')
    .select('id, page_id, layers')
    .eq('is_published', false)
    .is('deleted_at', null);

  if (pageError) {
    throw new Error(`Failed to fetch page layers: ${pageError.message}`);
  }

  // Get page info for affected pages
  const affectedPageLayerIds = (pageLayersRecords || [])
    .filter(record => layersContainStyle(record.layers || [], styleId))
    .map(record => record.page_id);

  if (affectedPageLayerIds.length > 0) {
    const { data: pages, error: pagesError } = await client
      .from('pages')
      .select('id, name')
      .in('id', affectedPageLayerIds)
      .eq('is_published', false)
      .is('deleted_at', null);

    if (pagesError) {
      throw new Error(`Failed to fetch pages: ${pagesError.message}`);
    }

    const pageMap = new Map((pages || []).map(p => [p.id, p.name]));

    for (const record of pageLayersRecords || []) {
      if (layersContainStyle(record.layers || [], styleId)) {
        const newLayers = detachStyleFromLayers(record.layers || [], styleId, stylesById);
        affectedEntities.push({
          type: 'page',
          id: record.id,
          name: pageMap.get(record.page_id) || 'Unknown Page',
          pageId: record.page_id,
          previousLayers: record.layers || [],
          newLayers,
        });
      }
    }
  }

  // Find affected components — search all variant layer trees
  const { data: componentRecords, error: compError } = await client
    .from('components')
    .select('id, name, layers, variants')
    .eq('is_published', false)
    .is('deleted_at', null);

  if (compError) {
    throw new Error(`Failed to fetch components: ${compError.message}`);
  }

  for (const record of componentRecords || []) {
    const variants = record.variants as ComponentVariant[] | undefined;
    const primaryLayers = record.layers || [];

    const hasStyleInPrimary = layersContainStyle(primaryLayers, styleId);
    const hasStyleInVariants = Array.isArray(variants) && variants.some(v => layersContainStyle(v.layers ?? [], styleId));

    if (hasStyleInPrimary || hasStyleInVariants) {
      const newLayers = detachStyleFromLayers(primaryLayers, styleId, stylesById);
      let newVariants: ComponentVariant[] | undefined;
      if (Array.isArray(variants) && variants.length > 0) {
        newVariants = variants.map((v, i) => ({
          ...v,
          layers: i === 0 ? newLayers : detachStyleFromLayers(v.layers ?? [], styleId, stylesById),
        }));
      }
      affectedEntities.push({
        type: 'component',
        id: record.id,
        name: record.name,
        previousLayers: primaryLayers,
        newLayers,
        previousVariants: variants || undefined,
        newVariants,
      });
    }
  }

  return affectedEntities;
}

/**
 * Soft delete a layer style and detach it from all layers
 * Returns the deleted style and affected entities for undo/redo
 */
export async function softDeleteStyle(id: string): Promise<LayerStyleSoftDeleteResult> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  // Get the layer style before deleting
  const { data: layerStyle, error: fetchError } = await client
    .from('layer_styles')
    .select('*')
    .eq('id', id)
    .eq('is_published', false)
    .is('deleted_at', null)
    .single();

  if (fetchError || !layerStyle) {
    throw new Error('Layer style not found');
  }

  // Find all affected entities
  const affectedEntities = await findEntitiesUsingLayerStyle(id);

  // Detach style from all affected page_layers and recompute hashes
  const { generatePageLayersHash } = await import('@/lib/hash-utils');

  for (const entity of affectedEntities) {
    if (entity.type === 'page') {
      const { data: existing } = await client
        .from('page_layers')
        .select('generated_css')
        .eq('id', entity.id)
        .eq('is_published', false)
        .single();

      const contentHash = generatePageLayersHash({
        layers: entity.newLayers,
        generated_css: existing?.generated_css || null,
      });

      const { error: updateError } = await client
        .from('page_layers')
        .update({
          layers: entity.newLayers,
          content_hash: contentHash,
          updated_at: new Date().toISOString(),
        })
        .eq('id', entity.id);

      if (updateError) {
        console.error(`Failed to update page_layers ${entity.id}:`, updateError);
      }
    } else if (entity.type === 'component') {
      const contentHash = generateComponentContentHash({
        name: entity.name,
        layers: entity.newLayers,
        variables: undefined,
        variants: entity.newVariants,
      });

      const { error: updateError } = await client
        .from('components')
        .update({
          layers: entity.newLayers,
          ...(entity.newVariants ? { variants: entity.newVariants } : {}),
          content_hash: contentHash,
          updated_at: new Date().toISOString(),
        })
        .eq('id', entity.id)
        .eq('is_published', false);

      if (updateError) {
        console.error(`Failed to update component ${entity.id}:`, updateError);
      }
    }
  }

  // Soft delete the style (both draft and published versions)
  const deletedAt = new Date().toISOString();
  const { error: deleteError } = await client
    .from('layer_styles')
    .update({ deleted_at: deletedAt })
    .eq('id', id);

  if (deleteError) {
    throw new Error(`Failed to soft delete layer style: ${deleteError.message}`);
  }

  return {
    layerStyle: { ...layerStyle, deleted_at: deletedAt },
    affectedEntities,
  };
}

/**
 * Restore a soft-deleted layer style
 */
export async function restoreLayerStyle(id: string): Promise<LayerStyle> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { data, error } = await client
    .from('layer_styles')
    .update({ deleted_at: null })
    .eq('id', id)
    .eq('is_published', false)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to restore layer style: ${error.message}`);
  }

  return data;
}

/**
 * Hard delete a layer style (permanent, use with caution)
 * @deprecated Use softDeleteStyle instead for undo/redo support
 */
export async function deleteStyle(id: string): Promise<void> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const { error } = await client
    .from('layer_styles')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete layer style: ${error.message}`);
  }
}

/**
 * Recursively check whether any layer in the tree references one of the
 * given style IDs — either directly via `layer.styleId` or through a
 * `textStyles` entry. Used to skip drafts that don't reference any of
 * the changed styles so we don't bump their content_hash for no reason.
 */
function layersReferenceAnyStyle(layers: Layer[], styleIds: Set<string>): boolean {
  for (const layer of layers) {
    if (getStyleIds(layer).some(id => styleIds.has(id))) return true;
    if (layer.textStyles) {
      for (const ts of Object.values(layer.textStyles)) {
        const tsStyleId = (ts as { styleId?: string })?.styleId;
        if (tsStyleId && styleIds.has(tsStyleId)) return true;
      }
    }
    if (Array.isArray(layer.children) && layer.children.length > 0) {
      if (layersReferenceAnyStyle(layer.children, styleIds)) return true;
    }
  }
  return false;
}

/**
 * Propagate updated layer style values into the draft layers of every page
 * and component that references them.
 *
 * Layer styles are denormalized: when applied, the style's classes/design are
 * COPIED onto the layer (alongside layer.styleId). The builder client only
 * syncs the currently-open pages when a style is edited, so pages and
 * components that aren't loaded keep stale denormalized values in the DB.
 *
 * Without this server-side sync, publishing a style change updates only the
 * layer_styles row — the layers themselves still carry the OLD classes, so
 * the published HTML references the old class names and renders with the
 * old style. The CSS catch-up doesn't fix it because it generates CSS from
 * the same stale layers.
 *
 * Skips layers that have styleOverrides (local customizations win). Also
 * handles textStyles entries (rich-text inline styles) via the existing
 * updateLayersWithStyle helper.
 *
 * @returns IDs of pages and components whose drafts were updated. Callers
 *   should republish affected components so their published versions get
 *   the fresh classes; affected pages are handled by the CSS catch-up step.
 */
export async function syncLayerStyleChangesToDrafts(
  styleIds: string[],
): Promise<{ affectedPageIds: string[]; affectedComponentIds: string[] }> {
  if (styleIds.length === 0) {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  const client = await getSupabaseAdmin();
  if (!client) {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  // Use the just-published versions of the changed styles as the source of
  // truth: they were just upserted by publishLayerStyles with the new values.
  const { data: styles } = await client
    .from('layer_styles')
    .select('id, classes, design')
    .in('id', styleIds)
    .eq('is_published', true)
    .is('deleted_at', null);

  if (!styles || styles.length === 0) {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  const styleIdSet = new Set(styles.map(s => s.id));

  // Combo-class layers reference a stack of styles, so re-flattening needs
  // every style a layer might point at — not just the changed ones. Snapshot
  // all published styles, then overlay the just-published changed values.
  const { data: allStyles } = await client
    .from('layer_styles')
    .select('id, classes, design')
    .eq('is_published', true)
    .is('deleted_at', null);
  const stylesById = new Map<string, LayerStyle>();
  for (const s of allStyles ?? []) stylesById.set(s.id, s as LayerStyle);
  for (const s of styles) stylesById.set(s.id, s as LayerStyle);

  // --- Sync draft page_layers ---
  const { data: pageLayersRecords } = await client
    .from('page_layers')
    .select('id, page_id, layers, generated_css, content_hash')
    .eq('is_published', false)
    .is('deleted_at', null);

  const affectedPageIds: string[] = [];
  const now = new Date().toISOString();

  for (const record of pageLayersRecords || []) {
    // Skip rows without an actual layer tree — they can't reference any
    // style anyway, and hashing a missing `layers` field with our default
    // `[]` would diverge from whatever the original save path stored.
    if (!Array.isArray(record.layers)) continue;

    // Skip drafts that don't reference any of the changed styles.
    // Without this, recomputing the hash for unrelated drafts (e.g. those
    // with NULL content_hash from a legacy import/template apply) bumps
    // them into "affected" status and writes a fresh hash to the draft.
    // The published row never sees this hash because the downstream
    // CSS catch-up step only republishes pages found by findAffectedPages,
    // which scans for actual style references — so the draft drifts ahead
    // of published and getUnpublishedPages keeps flagging them.
    if (!layersReferenceAnyStyle(record.layers as Layer[], styleIdSet)) continue;

    let layers = record.layers as Layer[];
    for (const style of styles) {
      layers = updateLayersWithStyle(layers, style.id, stylesById);
    }

    // Match the canonical save formula exactly: empty-string generated_css
    // must coalesce to null, otherwise the recomputed hash will drift from
    // the stored one on every publish.
    const newHash = generatePageLayersHash({
      layers,
      generated_css: record.generated_css || null,
    });

    if (newHash !== record.content_hash) {
      affectedPageIds.push(record.page_id);
      // CRITICAL: page_layers has a composite primary key (id, is_published).
      // Drafts and published rows share the same `id`, so without filtering
      // by is_published this UPDATE silently clobbers the published row too,
      // writing the new layers + hash but NOT a fresh generated_css. That
      // breaks the published render (new class names, old CSS file) AND
      // makes batchPublishPageLayers below think nothing changed.
      await client
        .from('page_layers')
        .update({ layers, content_hash: newHash, updated_at: now })
        .eq('id', record.id)
        .eq('is_published', false);
    }
  }

  // --- Sync draft components ---
  const { data: componentRecords } = await client
    .from('components')
    .select('id, name, layers, variants, variables, content_hash')
    .eq('is_published', false)
    .is('deleted_at', null);

  const affectedComponentIds: string[] = [];

  for (const record of componentRecords || []) {
    // Same guard as page_layers above: components with no layer tree have
    // nothing to sync, and forcing `[]` would diverge from the stored hash.
    if (!Array.isArray(record.layers)) continue;

    // Skip components that don't reference any of the changed styles in
    // their primary tree OR any variant tree. Same rationale as the
    // page_layers guard above — keep over-eager hash bumps out of unrelated
    // components.
    const variantsList = Array.isArray(record.variants) ? (record.variants as ComponentVariant[]) : [];
    const primaryReferences = layersReferenceAnyStyle(record.layers as Layer[], styleIdSet);
    const variantReferences = variantsList.some(
      v => Array.isArray(v.layers) && layersReferenceAnyStyle(v.layers as Layer[], styleIdSet),
    );
    if (!primaryReferences && !variantReferences) continue;

    let layers = record.layers as Layer[];
    for (const style of styles) {
      layers = updateLayersWithStyle(layers, style.id, stylesById);
    }

    // Apply style updates to all variant layer trees so non-primary
    // variants stay in sync with style changes.
    let variants: ComponentVariant[] | undefined = record.variants as ComponentVariant[] | undefined;
    if (Array.isArray(variants) && variants.length > 0) {
      variants = variants.map((v, i) => {
        if (i === 0) return { ...v, layers };
        let variantLayers = v.layers as Layer[] ?? [];
        for (const style of styles) {
          variantLayers = updateLayersWithStyle(variantLayers, style.id, stylesById);
        }
        return { ...v, layers: variantLayers };
      });
    }

    const newHash = generateComponentContentHash({
      name: record.name,
      layers,
      variables: record.variables,
      variants,
    });

    if (newHash !== record.content_hash) {
      affectedComponentIds.push(record.id);
      // Same composite-key trap as page_layers: components share an `id`
      // across draft/published. Always scope the update to the draft row.
      await client
        .from('components')
        .update({
          layers,
          ...(variants ? { variants } : {}),
          content_hash: newHash,
          updated_at: now,
        })
        .eq('id', record.id)
        .eq('is_published', false);
    }
  }

  return { affectedPageIds, affectedComponentIds };
}
