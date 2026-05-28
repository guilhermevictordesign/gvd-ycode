import type {
  Page,
  PageFolder,
  Locale,
  LinkSettings,
  Layer,
  DynamicTextVariable,
  CollectionLinkValue,
  CollectionFieldType,
} from '@/types';
import { buildLocalizedSlugPath, buildLocalizedDynamicPageUrl } from '@/lib/page-utils';
import { isAssetFieldType, isVirtualAssetField } from '@/lib/collection-field-utils';
import { resolveInlineVariablesFromData } from '@/lib/inline-variables';

// ============================================================================
// LinkSettings Validation
// ============================================================================

/**
 * Check if link settings have valid content (not just a type set)
 */
export function isValidLinkSettings(link: LinkSettings | undefined | null): boolean {
  if (!link || !link.type) return false;

  switch (link.type) {
    case 'url':
      return !!link.url?.data?.content;
    case 'email':
      return !!link.email?.data?.content;
    case 'phone':
      return !!link.phone?.data?.content;
    case 'asset':
      return !!link.asset?.id;
    case 'page':
      return !!link.page?.id;
    case 'field':
      return !!link.field?.data?.field_id;
    default:
      return false;
  }
}

// ============================================================================
// LinkSettings Creation
// ============================================================================

/**
 * Create a DynamicTextVariable for link content
 */
function createDynamicTextVariable(content: string): DynamicTextVariable {
  return {
    type: 'dynamic_text',
    data: { content },
  };
}

/**
 * Create a URL link settings object
 */
export function createUrlLinkSettings(url: string, anchorLayerId?: string | null): LinkSettings {
  return {
    type: 'url',
    url: createDynamicTextVariable(url),
    anchor_layer_id: anchorLayerId || null,
  };
}

/**
 * Create an email link settings object
 */
export function createEmailLinkSettings(email: string): LinkSettings {
  return {
    type: 'email',
    email: createDynamicTextVariable(email),
  };
}

/**
 * Create a phone link settings object
 */
export function createPhoneLinkSettings(phone: string): LinkSettings {
  return {
    type: 'phone',
    phone: createDynamicTextVariable(phone),
  };
}

/**
 * Create an asset link settings object
 */
export function createAssetLinkSettings(assetId: string): LinkSettings {
  return {
    type: 'asset',
    asset: { id: assetId },
  };
}

/**
 * Create a page link settings object
 */
export function createPageLinkSettings(
  pageId: string,
  collectionItemId?: string | null,
  anchorLayerId?: string | null
): LinkSettings {
  return {
    type: 'page',
    page: {
      id: pageId,
      collection_item_id: collectionItemId || null,
    },
    anchor_layer_id: anchorLayerId || null,
  };
}

/**
 * Create a field link settings object (CMS field containing URL, email, phone, or image)
 */
export function createFieldLinkSettings(
  fieldId: string,
  relationships: string[] = [],
  fieldType: CollectionFieldType | null = null
): LinkSettings {
  return {
    type: 'field',
    field: {
      type: 'field',
      data: {
        field_id: fieldId,
        relationships,
        field_type: fieldType,
      },
    },
  };
}

// ============================================================================
// Layer Link Checking
// ============================================================================

/**
 * Check if a layer has link settings configured
 */
export function layerHasLink(layer: Layer): boolean {
  return !!(layer.variables?.link && layer.variables.link.type);
}

/**
 * Check if a layer has rich text links in its content
 */
export function hasRichTextLinks(layer: Layer): boolean {
  const textVariable = layer.variables?.text;
  if (!textVariable || textVariable.type !== 'dynamic_rich_text') {
    return false;
  }

  const content = textVariable.data?.content;
  if (!content || typeof content !== 'object') {
    return false;
  }

  // Recursively check for richTextLink marks in the content
  const checkNode = (node: any): boolean => {
    if (node.marks && Array.isArray(node.marks)) {
      if (node.marks.some((mark: any) => mark.type === 'richTextLink')) {
        return true;
      }
    }
    if (node.content && Array.isArray(node.content)) {
      return node.content.some((child: any) => checkNode(child));
    }
    return false;
  };

  return checkNode(content);
}

/**
 * Check if a layer or any of its descendants has link settings or rich text links
 */
export function hasLinkInTree(layer: Layer): boolean {
  if (layerHasLink(layer)) {
    return true;
  }

  if (hasRichTextLinks(layer)) {
    return true;
  }

  if (layer.children) {
    return layer.children.some(child => hasLinkInTree(child));
  }

  return false;
}

export { REF_PAGE_PREFIX, REF_COLLECTION_PREFIX } from '@/lib/collection-field-utils';
import { REF_PAGE_PREFIX, REF_COLLECTION_PREFIX } from '@/lib/collection-field-utils';

/**
 * Sentinel values stored in `linkSettings.page.collection_item_id` to indicate
 * dynamic resolution at render time instead of a hard-coded item id.
 */
export const COLLECTION_ITEM_KEYWORDS = {
  CURRENT_PAGE: 'current-page',
  CURRENT_COLLECTION: 'current-collection',
  NEXT_ITEM: 'next-item',
  PREVIOUS_ITEM: 'previous-item',
} as const;

export type CollectionItemKeyword = typeof COLLECTION_ITEM_KEYWORDS[keyof typeof COLLECTION_ITEM_KEYWORDS];

const KEYWORD_VALUES = new Set<string>(Object.values(COLLECTION_ITEM_KEYWORDS));

/** Returns true when the value is one of the known dynamic-resolution keywords. */
export function isCollectionItemKeyword(value: string | null | undefined): value is CollectionItemKeyword {
  return !!value && KEYWORD_VALUES.has(value);
}

/** Returns true for next/previous page-navigation keywords. */
export function isPageNavigationKeyword(value: string | null | undefined): boolean {
  return value === COLLECTION_ITEM_KEYWORDS.NEXT_ITEM || value === COLLECTION_ITEM_KEYWORDS.PREVIOUS_ITEM;
}

/**
 * Resolve a ref-* collection_item_id to the actual referenced item ID
 * by looking up the reference field value in the current item data.
 */
export function resolveRefCollectionItemId(
  collectionItemId: string,
  pageCollectionItemData?: Record<string, string>,
  collectionItemData?: Record<string, string>
): string | undefined {
  if (collectionItemId.startsWith(REF_PAGE_PREFIX)) {
    const fieldId = collectionItemId.slice(REF_PAGE_PREFIX.length);
    return pageCollectionItemData?.[fieldId];
  }
  if (collectionItemId.startsWith(REF_COLLECTION_PREFIX)) {
    const fieldId = collectionItemId.slice(REF_COLLECTION_PREFIX.length);
    return collectionItemData?.[fieldId];
  }
  return undefined;
}

/**
 * Context for resolving links (page, asset, field types)
 */
export interface LinkResolutionContext {
  pages?: Page[];
  folders?: PageFolder[];
  collectionItemSlugs?: Record<string, string>;
  collectionItemId?: string;
  pageCollectionItemId?: string;
  collectionItemData?: Record<string, string>;
  pageCollectionItemData?: Record<string, string>;
  isPreview?: boolean;
  locale?: Locale | null;
  translations?: Record<string, any> | null;
  getAsset?: (id: string) => { public_url?: string | null; content?: string | null } | null;
  anchorMap?: Record<string, string>;
  /** Pre-resolved assets (asset_id -> { url, width, height }) for SSR */
  resolvedAssets?: Record<string, { url: string; width?: number | null; height?: number | null }>;
  /** Map of layer ID → item data for layer-specific field resolution */
  layerDataMap?: Record<string, Record<string, string>>;
  /**
   * Ordered list of collection item ids on the current dynamic page's collection.
   * Used to resolve `next-item` / `previous-item` link keywords. Should be present
   * for any render whose root is a dynamic collection page.
   */
  pageCollectionSortedItemIds?: string[];
}

/**
 * Parse a string or object value as CollectionLinkValue
 * Returns null if the value is not a valid CollectionLinkValue
 */
export function parseCollectionLinkValue(value: string | CollectionLinkValue | unknown): CollectionLinkValue | null {
  if (!value) return null;

  // If already an object, validate and return it
  if (typeof value === 'object' && 'type' in value) {
    if (value.type === 'url' || value.type === 'page' || value.type === 'asset') {
      return value as CollectionLinkValue;
    }
    return null;
  }

  // If string, parse JSON
  if (typeof value === 'string') {
    if (!value.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(value);
      // Validate it has the expected structure
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        if (parsed.type === 'url' || parsed.type === 'page' || parsed.type === 'asset') {
          return parsed as CollectionLinkValue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Options for resolving a raw field value to a link href
 */
export interface ResolveFieldLinkOptions {
  fieldId: string;
  rawValue: string;
  fieldType?: string | null;
  context: LinkResolutionContext;
  /** Asset map for SSR (asset_id -> { public_url, content }) */
  assetMap?: Record<string, { public_url: string | null; content?: string | null }>;
}

/**
 * Extract collection_item_ids referenced by link field values that point to
 * dynamic pages. Used to pre-fetch slugs for cross-collection link resolution.
 * Skips dynamic-resolution keywords (`current-page`, `ref-*`, etc.) since those
 * are resolved at render time and don't map to a concrete item id.
 */
export function extractCrossCollectionItemIds(
  items: { values: Record<string, string> }[],
  linkFieldIds: string[],
  existingSlugs?: Record<string, string>,
): string[] {
  const itemIds = new Set<string>();
  for (const item of items) {
    for (const fieldId of linkFieldIds) {
      const rawValue = item.values[fieldId];
      if (!rawValue) continue;
      const linkValue = parseCollectionLinkValue(rawValue);
      if (linkValue?.type !== 'page' || !linkValue.page?.collection_item_id) continue;

      const refItemId = linkValue.page.collection_item_id;
      if (isCollectionItemKeyword(refItemId)) continue;
      if (refItemId.startsWith(REF_PAGE_PREFIX) || refItemId.startsWith(REF_COLLECTION_PREFIX)) continue;
      if (existingSlugs?.[refItemId]) continue;

      itemIds.add(refItemId);
    }
  }
  return Array.from(itemIds);
}

/**
 * Resolve a raw field value to a link href.
 * Handles CollectionLinkValue JSON, email, phone, virtual asset fields, and regular asset fields.
 */
export function resolveFieldLinkValue(options: ResolveFieldLinkOptions): string {
  const { fieldId, rawValue, fieldType, context, assetMap } = options;
  const { getAsset, resolvedAssets } = context;

  // Check if value is a CollectionLinkValue JSON (for 'link' field type)
  const linkValue = parseCollectionLinkValue(rawValue);
  if (linkValue) {
    return resolveCollectionLinkValue(linkValue, context) || '';
  }

  // Email field
  if (fieldType === 'email' || looksLikeEmail(rawValue)) {
    return `mailto:${rawValue}`;
  }

  // Phone field
  if (fieldType === 'phone' || looksLikePhone(rawValue)) {
    return `tel:${rawValue}`;
  }

  // Virtual asset fields (e.g., __asset_url) contain URLs directly
  if (isVirtualAssetField(fieldId)) {
    return rawValue;
  }

  // Asset field types - resolve ID to URL
  if (isAssetFieldType(fieldType as any)) {
    // SSR: use assetMap
    if (assetMap) {
      const asset = assetMap[rawValue];
      // SVG assets don't have URLs (they use inline content)
      if (asset && !asset.public_url && asset.content) {
        return '#no-svg-url';
      }
      return asset?.public_url || rawValue;
    }
    // SSR: use pre-resolved assets
    if (resolvedAssets?.[rawValue]) {
      if (resolvedAssets[rawValue].url.startsWith('<')) {
        return '#no-svg-url';
      }
      return resolvedAssets[rawValue].url;
    }
    // Client: use getAsset callback
    if (getAsset) {
      const asset = getAsset(rawValue);
      // SVG assets don't have URLs (they use inline content)
      if (asset && !asset.public_url && asset.content) {
        return '#no-svg-url';
      }
      return asset?.public_url || '';
    }
    return rawValue;
  }

  // Default: use raw value as-is
  return rawValue;
}

/**
 * Resolve a CollectionLinkValue to an href string
 */
export function resolveCollectionLinkValue(
  linkValue: CollectionLinkValue,
  context: LinkResolutionContext
): string | null {
  const { pages, folders, collectionItemSlugs, isPreview, locale, translations, getAsset, resolvedAssets } = context;

  if (linkValue.type === 'url') {
    return linkValue.url || null;
  }

  if (linkValue.type === 'asset') {
    if (!linkValue.asset?.id) return null;

    // SSR: use pre-resolved assets
    if (resolvedAssets?.[linkValue.asset.id]) {
      const resolved = resolvedAssets[linkValue.asset.id];
      if (resolved.url.startsWith('<')) return '#no-svg-url';
      return resolved.url;
    }

    // Client: use getAsset callback
    if (getAsset) {
      const asset = getAsset(linkValue.asset.id);
      if (asset && !asset.public_url && asset.content) return '#no-svg-url';
      return asset?.public_url || null;
    }

    return null;
  }

  if (linkValue.type === 'page') {
    if (!linkValue.page?.id || !pages || !folders) return null;

    const page = pages.find(p => p.id === linkValue.page?.id);
    if (!page) return null;

    let href: string;

    // Handle dynamic pages with specific collection item
    if (page.is_dynamic && linkValue.page.collection_item_id && collectionItemSlugs) {
      const itemSlug = collectionItemSlugs[linkValue.page.collection_item_id];
      href = buildLocalizedDynamicPageUrl(page, folders, itemSlug || null, locale, translations || undefined);
    } else {
      // Static page or dynamic page without specific item
      href = buildLocalizedSlugPath(page, folders, 'page', locale, translations || undefined);
    }

    // Prefix with /ycode/preview in preview mode
    if (isPreview && href) {
      href = `/ycode/preview${href}`;
    }

    // Append anchor if present
    if (href && linkValue.page.anchor_layer_id) {
      href = `${href}#${linkValue.page.anchor_layer_id}`;
    }

    return href || null;
  }

  return null;
}

/**
 * Generate href from link settings using provided context
 * Shared utility for both layer-level links and rich text links
 */
export function generateLinkHref(
  linkSettings: LinkSettings | undefined,
  context: LinkResolutionContext
): string | null {
  if (!linkSettings || !linkSettings.type) return null;

  const {
    pages,
    folders,
    collectionItemSlugs,
    collectionItemId,
    pageCollectionItemId,
    collectionItemData,
    pageCollectionItemData,
    isPreview,
    locale,
    translations,
    getAsset,
    anchorMap,
    pageCollectionSortedItemIds,
  } = context;

  let href = '';

  switch (linkSettings.type) {
    case 'url': {
      const urlContent = linkSettings.url?.data?.content || '';
      href = resolveInlineVariablesFromData(urlContent, collectionItemData, pageCollectionItemData) || '';
      break;
    }
    case 'email': {
      const emailContent = linkSettings.email?.data?.content || '';
      const resolvedEmail = resolveInlineVariablesFromData(emailContent, collectionItemData, pageCollectionItemData);
      href = resolvedEmail ? `mailto:${resolvedEmail}` : '';
      break;
    }
    case 'phone': {
      const phoneContent = linkSettings.phone?.data?.content || '';
      const resolvedPhone = resolveInlineVariablesFromData(phoneContent, collectionItemData, pageCollectionItemData);
      href = resolvedPhone ? `tel:${resolvedPhone}` : '';
      break;
    }
    case 'asset':
      if (linkSettings.asset?.id && getAsset) {
        const asset = getAsset(linkSettings.asset.id);
        // SVG assets don't have URLs (they use inline content)
        if (asset && !asset.public_url && asset.content) {
          href = '#no-svg-url';
        } else {
          href = asset?.public_url || '';
        }
      }
      break;
    case 'page':
      if (linkSettings.page?.id && pages && folders) {
        const page = pages.find(p => p.id === linkSettings.page?.id);
        if (page) {
          // Check if this is a dynamic page with a specific collection item
          if (page.is_dynamic && linkSettings.page.collection_item_id && collectionItemSlugs) {
            let itemSlug: string | undefined;

            const itemKeyword = linkSettings.page.collection_item_id;
            switch (itemKeyword) {
              case COLLECTION_ITEM_KEYWORDS.CURRENT_PAGE:
                itemSlug = pageCollectionItemId ? collectionItemSlugs[pageCollectionItemId] : undefined;
                break;
              case COLLECTION_ITEM_KEYWORDS.CURRENT_COLLECTION:
                itemSlug = collectionItemId ? collectionItemSlugs[collectionItemId] : undefined;
                break;
              case COLLECTION_ITEM_KEYWORDS.NEXT_ITEM:
              case COLLECTION_ITEM_KEYWORDS.PREVIOUS_ITEM: {
                // Navigate to neighbouring item on the current dynamic page's collection.
                // When out of bounds (first/last item), itemSlug stays undefined so we
                // emit no href — callers can detect this and render a disabled state.
                if (pageCollectionSortedItemIds && pageCollectionItemId) {
                  const currentIndex = pageCollectionSortedItemIds.indexOf(pageCollectionItemId);
                  if (currentIndex !== -1) {
                    const offset = itemKeyword === COLLECTION_ITEM_KEYWORDS.NEXT_ITEM ? 1 : -1;
                    const targetIndex = currentIndex + offset;
                    if (targetIndex >= 0 && targetIndex < pageCollectionSortedItemIds.length) {
                      itemSlug = collectionItemSlugs[pageCollectionSortedItemIds[targetIndex]];
                    }
                  }
                }
                break;
              }
              default:
                if (itemKeyword.startsWith(REF_PAGE_PREFIX) || itemKeyword.startsWith(REF_COLLECTION_PREFIX)) {
                  const refItemId = resolveRefCollectionItemId(itemKeyword, pageCollectionItemData, collectionItemData);
                  itemSlug = refItemId ? collectionItemSlugs[refItemId] : undefined;
                } else {
                  itemSlug = collectionItemSlugs[itemKeyword];
                }
                break;
            }

            href = buildLocalizedDynamicPageUrl(page, folders, itemSlug || null, locale, translations || undefined);
          } else {
            // Static page or dynamic page without specific item
            href = buildLocalizedSlugPath(page, folders, 'page', locale, translations || undefined);
          }

          // Prefix with /ycode/preview in preview mode
          if (isPreview && href) {
            href = `/ycode/preview${href}`;
          }
        }
      }
      break;
    case 'field': {
      const fieldId = linkSettings.field?.data?.field_id;
      if (!fieldId) break;

      // Use pre-resolved value from injectCollectionData when available
      // (published pages strip _collectionItemValues, but _resolvedValue survives)
      let rawValue: string | undefined = linkSettings.field?.data?._resolvedValue;

      if (!rawValue) {
        // Fall back to runtime field data lookup
        const source = linkSettings.field?.data?.source;
        const collectionLayerId = linkSettings.field?.data?.collection_layer_id;
        const { layerDataMap } = context;

        let fieldData: Record<string, string> | undefined;

        if (collectionLayerId && layerDataMap?.[collectionLayerId]) {
          fieldData = layerDataMap[collectionLayerId];
        } else if (source === 'page') {
          fieldData = pageCollectionItemData;
        } else if (source === 'collection') {
          fieldData = collectionItemData;
        } else {
          fieldData = collectionItemData || pageCollectionItemData;
        }

        if (fieldData) {
          const relationships = linkSettings.field?.data?.relationships || [];
          if (relationships.length > 0) {
            const fullPath = [fieldId, ...relationships].join('.');
            rawValue = fieldData[fullPath];
          } else {
            rawValue = fieldData[fieldId];
          }
        }
      }

      if (rawValue) {
        const fieldType = linkSettings.field?.data?.field_type;
        href = resolveFieldLinkValue({
          fieldId,
          rawValue,
          fieldType,
          context,
        });
      }
      break;
    }
  }

  // Append anchor if present (anchor_layer_id references a layer's ID attribute)
  // Resolve layer ID to actual anchor value using pre-built map (O(1) lookup)
  if (linkSettings.anchor_layer_id) {
    const anchorValue = anchorMap?.[linkSettings.anchor_layer_id] || linkSettings.anchor_layer_id;
    if (href) {
      href = `${href}#${anchorValue}`;
    } else {
      // Anchor-only link (same page)
      href = `#${anchorValue}`;
    }
  }

  return href || null;
}

/** Heuristic: value looks like email when field type unknown (e.g. collection layer fields not in fieldsByFieldId) */
export function looksLikeEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Heuristic: value looks like phone (digits, spaces, dashes, parens) when field type unknown */
export function looksLikePhone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const digitCount = (trimmed.match(/\d/g) || []).length;
  return /^[\d\s\-()+.]*$/.test(trimmed) && digitCount >= 7;
}

export interface ResolvedLinkAttrs {
  href: string;
  target: string;
  rel?: string;
  download?: boolean;
}

/** Resolve link settings to HTML anchor attributes (href, target, rel, download) */
export function resolveLinkAttrs(
  linkSettings: LinkSettings,
  context: LinkResolutionContext
): ResolvedLinkAttrs | null {
  const href = generateLinkHref(linkSettings, context);
  if (!href) return null;

  const target = linkSettings.target || '_self';
  const rel = linkSettings.rel || (target === '_blank' ? 'noopener noreferrer' : undefined);

  return {
    href,
    target,
    ...(rel && { rel }),
    ...(linkSettings.download && { download: linkSettings.download }),
  };
}

/**
 * Detects whether a link is a next/previous navigation that has hit a
 * collection boundary (first or last item). Useful for rendering a disabled
 * affordance instead of an unclickable bare `<a>` tag.
 */
export function isLinkAtCollectionBoundary(
  linkSettings: LinkSettings | undefined,
  context: LinkResolutionContext
): boolean {
  if (!linkSettings || linkSettings.type !== 'page') return false;
  const keyword = linkSettings.page?.collection_item_id;
  if (!isPageNavigationKeyword(keyword)) return false;
  // No bound item at all → not a boundary, just unconfigured.
  const ids = context.pageCollectionSortedItemIds;
  const currentId = context.pageCollectionItemId;
  if (!ids || !currentId) return false;
  const index = ids.indexOf(currentId);
  if (index === -1) return false;
  const offset = keyword === COLLECTION_ITEM_KEYWORDS.NEXT_ITEM ? 1 : -1;
  const target = index + offset;
  return target < 0 || target >= ids.length;
}
