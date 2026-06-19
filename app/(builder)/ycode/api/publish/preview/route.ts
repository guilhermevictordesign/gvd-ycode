import { NextRequest } from 'next/server';
import { getUnpublishedPagesCount } from '@/lib/repositories/pageRepository';
import { getTotalPublishableItemsCount } from '@/lib/repositories/collectionItemRepository';
import { getUnpublishedCollections } from '@/lib/repositories/collectionRepository';
import { getUnpublishedComponents } from '@/lib/repositories/componentRepository';
import { getUnpublishedLayerStyles } from '@/lib/repositories/layerStyleRepository';
import { getUnpublishedAssets } from '@/lib/repositories/assetRepository';
import { getUnpublishedTranslationsCount } from '@/lib/repositories/translationRepository';
import { getUnpublishedGlobalVariablesCount } from '@/lib/repositories/globalVariableRepository';
import { getDeletedDraftCount } from '@/lib/sync-utils';
import { noCache } from '@/lib/api-response';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export interface PublishPreviewCounts {
  pages: number;
  collections: number;
  collectionItems: number;
  components: number;
  layerStyles: number;
  assets: number;
  translations: number;
  globalVariables: number;
  total: number;
}

/**
 * GET /ycode/api/publish/preview
 * Count all pending changes (new, modified, deleted) per entity type.
 */
export async function GET(_request: NextRequest) {
  try {
    // Count changed + deleted in parallel for each entity type
    const [
      pagesChanged, pagesDeleted,
      collectionsChanged, collectionsDeleted,
      itemsChanged, itemsDeleted,
      componentsChanged, componentsDeleted,
      layerStylesChanged, layerStylesDeleted,
      assetsChanged, assetsDeleted,
      translationsChanged,
      globalVariablesChanged,
    ] = await Promise.all([
      getUnpublishedPagesCount(),
      getDeletedDraftCount('pages'),
      getUnpublishedCollections().then(c => c.length),
      getDeletedDraftCount('collections'),
      getTotalPublishableItemsCount(),
      getDeletedDraftCount('collection_items'),
      getUnpublishedComponents().then(c => c.length),
      getDeletedDraftCount('components'),
      getUnpublishedLayerStyles().then(s => s.length),
      getDeletedDraftCount('layer_styles'),
      getUnpublishedAssets().then(a => a.length),
      getDeletedDraftCount('assets'),
      getUnpublishedTranslationsCount(),
      getUnpublishedGlobalVariablesCount(),
    ]);

    const pages = pagesChanged + pagesDeleted;
    const collections = collectionsChanged + collectionsDeleted;
    const collectionItems = itemsChanged + itemsDeleted;
    const components = componentsChanged + componentsDeleted;
    const layerStyles = layerStylesChanged + layerStylesDeleted;
    const assets = assetsChanged + assetsDeleted;
    const translations = translationsChanged;
    const globalVariables = globalVariablesChanged;
    const total = pages + collections + collectionItems + components + layerStyles + assets + translations + globalVariables;

    return noCache({
      data: { pages, collections, collectionItems, components, layerStyles, assets, translations, globalVariables, total } satisfies PublishPreviewCounts,
    });
  } catch (error) {
    console.error('Error fetching publish preview:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch publish preview' },
      500
    );
  }
}
