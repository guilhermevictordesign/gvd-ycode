import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getUnpublishedPages, getAllDraftPages } from '@/lib/repositories/pageRepository';
import { getUnpublishedLayerStyles, publishLayerStyles } from '@/lib/repositories/layerStyleRepository';
import { getUnpublishedComponents, publishComponents } from '@/lib/repositories/componentRepository';
import { getAllCollections, getUnpublishedCollections } from '@/lib/repositories/collectionRepository';
import { getItemsByCollectionId } from '@/lib/repositories/collectionItemRepository';
import { getUnpublishedAssets, publishAssets, hardDeleteSoftDeletedAssets } from '@/lib/repositories/assetRepository';
import { getUnpublishedAssetFolders, publishAssetFolders, hardDeleteSoftDeletedAssetFolders } from '@/lib/repositories/assetFolderRepository';
import { getUnpublishedFonts, publishFonts } from '@/lib/repositories/fontRepository';
import { getAllLocales } from '@/lib/repositories/localeRepository';
import { getUnpublishedTranslationsCount } from '@/lib/repositories/translationRepository';
import { getUnpublishedGlobalVariables, publishGlobalVariables, hardDeleteSoftDeletedGlobalVariables } from '@/lib/repositories/globalVariableRepository';
import { publishPages } from '@/lib/services/pageService';
import { publishCollectionWithItems } from '@/lib/services/collectionService';
import { publishLocalisation } from '@/lib/services/localisationService';
import { publishFolders } from '@/lib/services/folderService';
import { publishCSS, savePublishedAt } from '@/lib/services/settingsService';
import { generateAndSaveDraftCSS } from '@/lib/server/cssGenerator';
import { clearAllCache } from '@/lib/services/cacheService';

/** Count draft locales not yet present in the published set (new languages awaiting publish). */
async function countUnpublishedLocales(): Promise<number> {
  const [draft, published] = await Promise.all([
    getAllLocales(false),
    getAllLocales(true),
  ]);
  const publishedIds = new Set(published.map((l) => l.id));
  return draft.filter((l) => !publishedIds.has(l.id)).length;
}

export function registerPublishingTools(server: McpServer) {
  server.tool(
    'get_unpublished_changes',
    'Check what changes are pending and need to be published. Reports unpublished pages, styles, components, collections, fonts, assets, translations, and locales.',
    {},
    async () => {
      const [pages, styles, components, collections, fonts, assets, assetFolders, translations, locales, globals] = await Promise.all([
        getUnpublishedPages().catch(() => []),
        getUnpublishedLayerStyles().catch(() => []),
        getUnpublishedComponents().catch(() => []),
        getUnpublishedCollections().catch(() => []),
        getUnpublishedFonts().catch(() => []),
        getUnpublishedAssets().catch(() => []),
        getUnpublishedAssetFolders().catch(() => []),
        getUnpublishedTranslationsCount().catch(() => 0),
        countUnpublishedLocales().catch(() => 0),
        getUnpublishedGlobalVariables().catch(() => []),
      ]);

      const hasChanges = pages.length > 0 || styles.length > 0 || components.length > 0
        || collections.length > 0 || fonts.length > 0 || assets.length > 0 || assetFolders.length > 0
        || translations > 0 || locales > 0 || globals.length > 0;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            has_unpublished_changes: hasChanges,
            unpublished_pages: pages.map((p) => ({ id: p.id, name: p.name })),
            unpublished_styles: styles.map((s) => ({ id: s.id, name: s.name })),
            unpublished_components: components.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })),
            unpublished_collections: collections.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })),
            unpublished_fonts: fonts.map((f) => ({ id: f.id, family: f.family })),
            unpublished_assets: assets.length,
            unpublished_asset_folders: assetFolders.length,
            unpublished_translations: translations,
            unpublished_locales: locales,
            unpublished_global_variables: globals.map((g) => ({ id: g.id, name: g.name })),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'publish',
    'Publish all draft changes to make them live. This publishes pages, collections, components, styles, assets, and regenerates CSS.',
    {},
    async () => {
      const publishedAt = new Date().toISOString();
      const changes: Record<string, number> = {};

      // Publish folders
      try {
        const foldersResult = await publishFolders([], undefined);
        changes.folders = foldersResult.count;
      } catch { changes.folders = 0; }

      // Publish all draft pages
      try {
        const draftPages = await getAllDraftPages();
        if (draftPages.length > 0) {
          const result = await publishPages(draftPages.map((p) => p.id));
          changes.pages = result.count;
        } else {
          changes.pages = 0;
        }
      } catch { changes.pages = 0; }

      // Publish collections with items
      try {
        const allCollections = await getAllCollections({ is_published: false });
        let totalItems = 0;
        for (const collection of allCollections) {
          const { items } = await getItemsByCollectionId(collection.id, false);
          if (items.length > 0) {
            const result = await publishCollectionWithItems({
              collectionId: collection.id,
              itemIds: items.map((item: { id: string }) => item.id),
            });
            totalItems += result.published?.itemsCount || 0;
          }
        }
        changes.collection_items = totalItems;
      } catch { changes.collection_items = 0; }

      // Publish components
      try {
        const unpublished = await getUnpublishedComponents();
        if (unpublished.length > 0) {
          const result = await publishComponents(unpublished.map((c: { id: string }) => c.id));
          changes.components = result.count;
        } else {
          changes.components = 0;
        }
      } catch { changes.components = 0; }

      // Publish layer styles
      try {
        const unpublished = await getUnpublishedLayerStyles();
        if (unpublished.length > 0) {
          const result = await publishLayerStyles(unpublished.map((s) => s.id));
          changes.layer_styles = result.count;
        } else {
          changes.layer_styles = 0;
        }
      } catch { changes.layer_styles = 0; }

      // Publish asset folders
      try {
        await hardDeleteSoftDeletedAssetFolders();
        const unpublished = await getUnpublishedAssetFolders();
        if (unpublished.length > 0) {
          const result = await publishAssetFolders(unpublished.map((f: { id: string }) => f.id));
          changes.asset_folders = result.count;
        }
      } catch { /* non-fatal */ }

      // Publish assets
      try {
        await hardDeleteSoftDeletedAssets();
        const unpublished = await getUnpublishedAssets();
        if (unpublished.length > 0) {
          const result = await publishAssets(unpublished.map((a: { id: string }) => a.id));
          changes.assets = result.count;
        }
      } catch { /* non-fatal */ }

      // Publish fonts
      try { await publishFonts(); } catch { /* non-fatal */ }

      // Publish global variables
      try {
        const globalsResult = await publishGlobalVariables();
        changes.globalVariables = globalsResult.count;
        await hardDeleteSoftDeletedGlobalVariables();
      } catch { /* non-fatal */ }

      // Publish locales and translations
      try {
        const locResult = await publishLocalisation();
        changes.locales = locResult.locales;
        changes.translations = locResult.translations;
      } catch { /* non-fatal */ }

      // Regenerate draft CSS from all current layers, then publish it
      try {
        await generateAndSaveDraftCSS();
        await publishCSS();
      } catch { /* non-fatal */ }

      // Clear cache. No warming here: MCP is invoked over JSON-RPC, not HTTP,
      // so there's no Request/host header to build absolute URLs from. The
      // builder's HTTP publish endpoint warms after publish — this AI tool
      // path is rare enough that a cold next-visit is acceptable.
      try { await clearAllCache(); } catch { /* non-fatal */ }

      // Save published_at timestamp
      try { await savePublishedAt(publishedAt); } catch { /* non-fatal */ }

      const total = Object.values(changes).reduce((sum, n) => sum + n, 0);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Published ${total} item(s) successfully`,
            published_at: publishedAt,
            changes,
          }, null, 2),
        }],
      };
    },
  );
}
