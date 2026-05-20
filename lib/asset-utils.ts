/**
 * Asset Utility Functions
 * Centralized helpers for asset type detection, formatting, and categorization
 */

/**
 * Build a data URL for inline SVG content. When `width`/`height` are provided
 * and the SVG root lacks them, they're injected so `<img>` consumers get
 * intrinsic dimensions — otherwise browsers fall back to 300×150 for SVGs
 * that only carry a viewBox, breaking CSS `w-auto`/`h-auto` sizing.
 */
export function buildSvgDataUrl(
  content: string,
  width?: number | null,
  height?: number | null
): string {
  let svg = content;
  if (width && height) {
    svg = svg.replace(/<svg\b([^>]*)>/i, (match, attrs: string) => {
      const hasWidth = /\swidth\s*=/i.test(attrs);
      const hasHeight = /\sheight\s*=/i.test(attrs);
      if (hasWidth && hasHeight) return match;
      const injected = `${!hasWidth ? ` width="${width}"` : ''}${!hasHeight ? ` height="${height}"` : ''}`;
      return `<svg${injected}${attrs}>`;
    });
  }
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

import type { AssetCategory, AssetCategoryFilter, Layer, Component, ComponentVariable } from '@/types';
import {
  ASSET_CATEGORIES,
  ALLOWED_MIME_TYPES,
  DEFAULT_ASSETS,
  getAcceptString,
} from './asset-constants';
import { isAssetVariable, getAssetId } from '@/lib/variable-utils';
import { applyComponentOverrides } from '@/lib/resolve-components';
import { uuidToBase62, mimeToExtension } from '@/lib/convertion-utils';
import { sanitizeSlug } from '@/lib/page-utils';
import { isValidUUID } from '@/lib/utils';

// Re-export constants for backward compatibility
export { ASSET_CATEGORIES, ALLOWED_MIME_TYPES, DEFAULT_ASSETS, getAcceptString };

/**
 * Check if an asset matches the specified category based on MIME type
 * Always uses ALLOWED_MIME_TYPES for consistency across all categories
 *
 * @param mimeType - The MIME type to check
 * @param category - The asset category to check against ('images', 'videos', 'audio', 'documents', 'icons')
 * @returns True if the MIME type matches the specified asset category
 *
 * @example
 * isAssetOfType('image/png', 'images') // true
 * isAssetOfType('image/svg+xml', 'icons') // true
 * isAssetOfType('video/mp4', 'videos') // true
 * isAssetOfType('application/pdf', 'documents') // true
 */
export function isAssetOfType(
  mimeType: string | undefined | null,
  category: AssetCategory
): boolean {
  if (!mimeType) return false;
  return ALLOWED_MIME_TYPES[category].includes(mimeType);
}

/**
 * Validate a MIME type against a category.
 * Returns an error message if invalid, or null if valid.
 */
export function validateCategoryMimeType(
  mimeType: string,
  category: string | null | undefined
): string | null {
  if (!category) return null;

  const categoryMap: Record<string, { category: AssetCategory; label: string }> = {
    [ASSET_CATEGORIES.IMAGES]: { category: ASSET_CATEGORIES.IMAGES, label: 'image' },
    [ASSET_CATEGORIES.VIDEOS]: { category: ASSET_CATEGORIES.VIDEOS, label: 'video' },
    [ASSET_CATEGORIES.AUDIO]: { category: ASSET_CATEGORIES.AUDIO, label: 'audio' },
    [ASSET_CATEGORIES.DOCUMENTS]: { category: ASSET_CATEGORIES.DOCUMENTS, label: 'document' },
    [ASSET_CATEGORIES.ICONS]: { category: ASSET_CATEGORIES.ICONS, label: 'icon' },
  };

  const entry = categoryMap[category];
  if (!entry) return null;

  if (!isAssetOfType(mimeType, entry.category)) {
    return `Only ${entry.label} files are allowed`;
  }

  return null;
}

// Category to label mapping
const CATEGORY_LABELS: Record<AssetCategory, string> = {
  icons: 'Icon',
  images: 'Image',
  videos: 'Video',
  audio: 'Audio',
  documents: 'Document',
};

/**
 * Get a human-readable asset type label
 * Optimized to use getAssetCategoryFromMimeType instead of multiple isAssetOfType calls
 */
export function getAssetTypeLabel(mimeType: string | undefined | null): string {
  if (!mimeType) return 'Unknown';
  const category = getAssetCategoryFromMimeType(mimeType);
  return category ? CATEGORY_LABELS[category] : 'File';
}

// Category to icon name mapping
const CATEGORY_ICONS: Record<AssetCategory, string> = {
  icons: 'icon',
  images: 'image',
  videos: 'video',
  audio: 'audio',
  documents: 'file-text',
};

/**
 * Get icon name for an asset type based on MIME type
 * Optimized to use getAssetCategoryFromMimeType instead of multiple isAssetOfType calls
 */
export function getAssetIcon(mimeType: string | undefined | null): string {
  if (!mimeType) return 'file-text';
  const category = getAssetCategoryFromMimeType(mimeType);
  return category ? CATEGORY_ICONS[category] : 'file-text';
}

/**
 * Get asset category from MIME type
 * Returns the category that matches the MIME type, or null if no match
 * Optimized to check categories in order of specificity (icons first, then by prefix, then by ALLOWED_MIME_TYPES)
 *
 * @param mimeType - The MIME type to check
 * @returns The asset category ('images', 'videos', 'audio', 'documents', 'icons') or null if unknown
 *
 * @example
 * getAssetCategoryFromMimeType('image/png') // 'images'
 * getAssetCategoryFromMimeType('image/svg+xml') // 'icons'
 * getAssetCategoryFromMimeType('video/mp4') // 'videos'
 * getAssetCategoryFromMimeType('unknown/type') // null
 */
export function getAssetCategoryFromMimeType(
  mimeType: string | undefined | null
): AssetCategory | null {
  if (!mimeType) return null;

  // Check icons first (most specific, uses ALLOWED_MIME_TYPES)
  if (ALLOWED_MIME_TYPES.icons.includes(mimeType)) {
    return ASSET_CATEGORIES.ICONS;
  }

  // Check by prefix for faster matching (images, videos, audio)
  if (mimeType.startsWith('image/')) {
    return ASSET_CATEGORIES.IMAGES;
  }
  if (mimeType.startsWith('video/')) {
    return ASSET_CATEGORIES.VIDEOS;
  }
  if (mimeType.startsWith('audio/')) {
    return ASSET_CATEGORIES.AUDIO;
  }

  // Check documents (requires array lookup in ALLOWED_MIME_TYPES)
  if (ALLOWED_MIME_TYPES.documents.includes(mimeType)) {
    return ASSET_CATEGORIES.DOCUMENTS;
  }

  return null;
}

/**
 * Check if an asset matches the given category filter
 * Supports single category, array of categories, 'all', or null (shows all)
 */
export function matchesCategoryFilter(
  mimeType: string | undefined | null,
  filter: AssetCategoryFilter
): boolean {
  // Show all if filter is 'all' or null
  if (filter === 'all' || filter === null) {
    return true;
  }

  const assetCategory = getAssetCategoryFromMimeType(mimeType);
  if (!assetCategory) return false;

  // Single category
  if (typeof filter === 'string') {
    return assetCategory === filter;
  }

  // Array of categories
  return filter.includes(assetCategory);
}

/**
 * Normalize category filter to array format for internal use
 */
export function normalizeCategoryFilter(
  filter: AssetCategoryFilter
): AssetCategory[] | null {
  if (filter === 'all' || filter === null) {
    return null; // null means show all
  }
  if (typeof filter === 'string') {
    return [filter];
  }
  return filter;
}

/**
 * Format file size to human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round(bytes / Math.pow(k, i))} ${sizes[i]}`;
}

/**
 * Get file extension from mime type
 */
export function getFileExtension(mimeType: string): string {
  const parts = mimeType.split('/');
  return parts[1]?.toUpperCase() || 'FILE';
}

/**
 * File validation result type
 */
export interface FileValidationResult {
  isValid: boolean;
  error?: string;
}

/**
 * Validate an image file for upload
 * @param file - The file to validate
 * @param maxSizeMB - Maximum file size in megabytes (default: 10MB)
 * @returns Validation result with error message if invalid
 *
 * @example
 * const result = validateImageFile(file, 5);
 * if (!result.isValid) {
 *   console.error(result.error);
 * }
 */
export function validateImageFile(
  file: File,
  maxSizeMB: number = 10
): FileValidationResult {
  // Check file type
  if (!isAssetOfType(file.type, ASSET_CATEGORIES.IMAGES)) {
    return {
      isValid: false,
      error: 'Only image files are allowed',
    };
  }

  // Check file size
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  if (file.size > maxSizeBytes) {
    return {
      isValid: false,
      error: `File size must be less than ${maxSizeMB}MB`,
    };
  }

  return { isValid: true };
}

/**
 * Generate SEO-friendly proxy URL for an asset
 * Format: /a/{base62-id}/{slugified-name}.{ext}
 * Returns null for SVG/inline assets (no storage_path)
 */
export function getAssetProxyUrl(
  asset: { id: string; filename: string; mime_type: string; storage_path?: string | null }
): string | null {
  if (!asset.storage_path) return null;

  const hash = uuidToBase62(asset.id);
  const baseName = asset.filename.replace(/\.[^/.]+$/, '');
  const slug = sanitizeSlug(baseName) || 'file';
  const ext = mimeToExtension(asset.mime_type);

  return `/a/${hash}/${slug}.${ext}`;
}

/**
 * Default max width applied to bitmap images served to the builder canvas.
 * Caps decoded image bitmaps so a 11k×6k hero doesn't allocate ~260 MB of
 * RGBA per copy in the iframe.
 */
const EDITOR_DEFAULT_IMAGE_WIDTH = 1920;
const EDITOR_DEFAULT_IMAGE_QUALITY = 80;

/**
 * Bitmap MIME types we want to size-cap through the proxy in the editor.
 * SVGs are skipped (vector, no decode cost) and videos/audio aren't bitmap
 * decoded at all.
 */
function isBitmapImageMime(mimeType?: string | null): boolean {
  if (!mimeType) return false;
  if (!mimeType.startsWith('image/')) return false;
  if (mimeType === 'image/svg+xml') return false;
  return true;
}

/**
 * Build an editor-optimized URL for a bitmap image asset. Routes through the
 * `/a/{hash}/{slug}.{ext}` proxy with `?width=&quality=` so Sharp can downscale
 * before the browser decodes the bitmap.
 *
 * Returns the asset's existing `public_url` unchanged when:
 *   - the asset isn't a bitmap image (SVG, video, document, …)
 *   - there's no `storage_path` (external/inline asset)
 *   - the URL has already been rewritten to the proxy by an upstream consumer
 */
export function getEditorImageUrl(
  asset: {
    id: string;
    filename: string;
    mime_type: string;
    storage_path?: string | null;
    public_url?: string | null;
  },
  maxWidth: number = EDITOR_DEFAULT_IMAGE_WIDTH,
  quality: number = EDITOR_DEFAULT_IMAGE_QUALITY
): string | null {
  const existing = asset.public_url ?? null;
  if (!isBitmapImageMime(asset.mime_type)) return existing;
  if (!asset.storage_path) return existing;

  const proxyBase = getAssetProxyUrl(asset);
  if (!proxyBase) return existing;

  // Avoid double-appending if `public_url` already routes through the proxy
  // (e.g. server pre-rewrote it). Re-append width to enforce the cap.
  return `${proxyBase}?width=${maxWidth}&quality=${quality}`;
}

/**
 * Check if a URL is an asset proxy URL (starts with /a/)
 */
function isProxyUrl(url: string): boolean {
  return url.startsWith('/a/');
}

/**
 * Check if a URL supports image transformation params
 */
function isTransformableUrl(url: string): boolean {
  if (isProxyUrl(url)) return true;
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes('supabase') || urlObj.pathname.includes('/storage/v1/object/public/');
  } catch {
    return false;
  }
}

/**
 * Generate optimized image URL with width and quality constraints.
 * Aspect ratio is preserved by the image service — only width caps the output.
 * @param url - Original image URL
 * @param width - Max width in pixels (default: 200)
 * @param quality - Image quality 0-100 (default: 80)
 * @returns Optimized URL with transformation parameters or original URL if not transformable
 */
export function getOptimizedImageUrl(
  url: string,
  width: number = 200,
  quality: number = 80
): string {
  if (!isTransformableUrl(url)) return url;

  try {
    if (isProxyUrl(url)) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}width=${width}&quality=${quality}`;
    }

    const urlObj = new URL(url);
    urlObj.searchParams.set('width', width.toString());
    urlObj.searchParams.set('quality', quality.toString());
    return urlObj.toString();
  } catch {
    return url;
  }
}

/**
 * Generate responsive image srcset with multiple sizes
 * Creates optimized URLs for different viewport widths
 * @param url - Original image URL
 * @param sizes - Array of widths in pixels (default: see below)
 * @param quality - Image quality 0-100 (default: 85)
 * @param intrinsicWidth - Source image natural width. When provided, caps
 *   variants to it so descriptors match the file the proxy returns (Sharp
 *   runs with `withoutEnlargement: true`). Without this, a 1512px source
 *   with a `?width=1920 1920w` descriptor sends a 1512px file: browsers
 *   then compute `intrinsic = 1512 / (1920/1512) = 1190px` and render the
 *   image ~21% smaller than intended.
 * @returns Srcset string with multiple size options
 *
 * Default ladder: 320, 480, 640, 750, 828, 1080, 1280, 1536, 1920.
 * Picked to land within ~10% of the natural rendered size for every common
 * viewport × DPR combination — coarser ladders (e.g. 640 → 960 → 1280) made
 * mid-range phones download the next-bigger variant and wasted 20–30% of
 * the byte budget on hero images.
 *
 *   320 — tiny viewports / small thumbnails
 *   480 — older phones at 1x
 *   640 — medium phones, tablet portrait at 1x
 *   750 — iPhone SE/8 at 2x DPR (375 × 2)
 *   828 — iPhone XR/11 at 2x DPR (414 × 2)
 *  1080 — Pixel / Galaxy at 3x DPR (360 × 3)
 *  1280 — iPhone 12–15 at ~3x DPR (390–430 × 3)
 *  1536 — tablets at 2x DPR
 *  1920 — full-width desktop hero (cap — bigger variants get picked on
 *         retina laptops even when the rendered size is much smaller).
 *
 * @example
 * generateImageSrcset('https://supabase.co/storage/v1/object/public/assets/image.jpg')
 * // Returns: 'https://.../image.jpg?width=320&quality=85 320w, https://.../image.jpg?width=480&quality=85 480w, ...'
 */
export function generateImageSrcset(
  url: string,
  sizes: number[] = [320, 480, 640, 750, 828, 1080, 1280, 1536, 1920],
  quality: number = 85,
  intrinsicWidth?: number | null
): string {
  if (!isTransformableUrl(url)) return '';

  // Cap descriptors at the source's natural width when known and smaller than
  // our default top-end. This keeps `descriptor === file actual width` so the
  // browser's intrinsic-size math stays correct (see param docs above).
  let effectiveSizes = sizes;
  if (intrinsicWidth && intrinsicWidth > 0) {
    const maxDefault = sizes[sizes.length - 1];
    if (intrinsicWidth < maxDefault) {
      effectiveSizes = sizes.filter((w) => w < intrinsicWidth);
      effectiveSizes.push(intrinsicWidth);
    }
  }

  try {
    if (isProxyUrl(url)) {
      const baseUrl = url.split('?')[0];
      return effectiveSizes
        .map((width) => `${baseUrl}?width=${width}&quality=${quality} ${width}w`)
        .join(', ');
    }

    const srcsetEntries = effectiveSizes.map((width) => {
      const sizeUrl = new URL(url);
      sizeUrl.searchParams.set('width', width.toString());
      sizeUrl.searchParams.set('quality', quality.toString());
      sizeUrl.searchParams.set('resize', 'cover');
      return `${sizeUrl.toString()} ${width}w`;
    });

    return srcsetEntries.join(', ');
  } catch {
    return '';
  }
}

/** Returns the default responsive sizes attribute. */
export function getImageSizes(): string {
  return '100vw';
}

// Semantic layer names whose descendant images are almost never the LCP
// (logos, menus, footer marks). Tracked via ancestor walk in
// `findLcpCandidateLayerId` so we don't accidentally prioritize a header
// logo over the actual hero image.
const NON_LCP_ANCESTOR_NAMES = new Set(['header', 'footer', 'nav']);

/**
 * Heuristic: is this resolved asset a vector graphic (SVG)?
 * SVGs are used overwhelmingly for logos / icons and should never be picked
 * as the LCP candidate. We trust `mimeType` when present and fall back to a
 * URL extension sniff for older callers that only pass `{ url, width }`.
 */
function isSvgAsset(asset: { mimeType?: string | null; url?: string | null } | undefined): boolean {
  if (!asset) return false;
  if (asset.mimeType && asset.mimeType.toLowerCase().includes('svg')) return true;
  if (asset.url) return isSvgUrl(asset.url);
  return false;
}

/** Cheap extension sniff: does the URL path end in `.svg`? */
function isSvgUrl(url: string): boolean {
  const path = url.split('?')[0].split('#')[0].toLowerCase();
  return path.endsWith('.svg');
}

/**
 * Best-effort URL extraction from an image layer's `src` variable when the
 * variable is a raw URL string (`dynamic_text` / `static_text`) rather than
 * an `AssetVariable`. Lets the LCP heuristic skip SVG logos that the user
 * pasted as a URL instead of selecting from the asset library.
 *
 * Returns undefined for variable shapes we can't resolve cheaply (e.g. CMS
 * field bindings) — those fall through to the existing checks.
 */
function getInlineImageUrl(srcVar: unknown): string | undefined {
  if (!srcVar || typeof srcVar !== 'object') return undefined;
  const v = srcVar as { type?: string; data?: { content?: unknown } };
  if (v.type !== 'dynamic_text' && v.type !== 'static_text') return undefined;
  const content = v.data?.content;
  return typeof content === 'string' ? content : undefined;
}

export interface LcpCandidate {
  layerId: string;
  /** Asset id of the candidate image, when backed by a static asset variable. */
  assetId?: string;
}

/**
 * Find the LCP (Largest Contentful Paint) candidate for a given page tree.
 * Walks the tree in render order and returns the first `image`-named layer that:
 *   - is NOT a descendant of a `header`, `footer`, or `nav` layer (logos),
 *   - is NOT backed by an SVG asset (vector logos / icons), and
 *   - has an effective intrinsic width unknown or at least `minWidth` pixels.
 *
 * Width resolution order:
 *   1. `layer.attributes.width` (parsed as int)
 *   2. Asset record width via `resolvedAssets[assetId]`
 *   3. Unknown — treat as candidate (best effort)
 *
 * Returns null if no qualifying image exists in the tree.
 */
export function findLcpCandidate(
  layers: Layer[],
  resolvedAssets?: Record<string, { width?: number | null; mimeType?: string | null; url?: string | null }>,
  minWidth: number = 200
): LcpCandidate | null {
  const parseWidth = (value: unknown): number | null => {
    if (typeof value === 'number' && !isNaN(value)) return value;
    if (typeof value !== 'string') return null;
    const match = value.match(/^\s*(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const n = parseFloat(match[1]);
    return isNaN(n) ? null : n;
  };

  const visit = (layer: Layer, inNonLcpAncestor: boolean): LcpCandidate | null => {
    const inNonLcp = inNonLcpAncestor || NON_LCP_ANCESTOR_NAMES.has(layer.name);

    if (layer.name === 'image' && !inNonLcp) {
      const srcVar = layer.variables?.image?.src;
      const assetId = isAssetVariable(srcVar) ? getAssetId(srcVar) : undefined;
      const asset = assetId ? resolvedAssets?.[assetId] : undefined;

      // Some pages store the image URL directly as a `dynamic_text` /
      // `static_text` variable (e.g. pasted logo URL) rather than an
      // `AssetVariable`. Sniff the inline URL so SVG logos in that shape
      // are still skipped.
      const inlineUrl = !assetId ? getInlineImageUrl(srcVar) : undefined;

      // SVGs are vector logos / icons in practice — never the hero image.
      const isSvg = isSvgAsset(asset) || (inlineUrl ? isSvgUrl(inlineUrl) : false);

      if (!isSvg) {
        let width = parseWidth(layer.attributes?.width);
        if (width === null && asset?.width) {
          width = asset.width as number;
        }

        if (width === null || width >= minWidth) {
          return { layerId: layer.id, assetId: assetId || undefined };
        }
      }
    }

    if (layer.children) {
      for (const child of layer.children) {
        const found = visit(child, inNonLcp);
        if (found) return found;
      }
    }

    return null;
  };

  for (const layer of layers) {
    const found = visit(layer, false);
    if (found) return found;
  }

  return null;
}

/** @deprecated Use {@link findLcpCandidate}. Kept for callers that only need the id. */
export function findLcpCandidateLayerId(
  layers: Layer[],
  resolvedAssets?: Record<string, { width?: number | null; mimeType?: string | null; url?: string | null }>,
  minWidth: number = 200
): string | null {
  return findLcpCandidate(layers, resolvedAssets, minWidth)?.layerId ?? null;
}

// ==========================================
// Re-export folder utilities for backward compatibility
// ==========================================

export {
  flattenAssetFolderTree,
  hasChildFolders,
  rebuildAssetFolderTree,
  buildAssetFolderPath,
  isDescendantAssetFolder,
  type FlattenedAssetFolderNode,
} from './asset-folder-utils';

/**
 * Collect all asset IDs from a layer tree, including assets from:
 * - Layer variables (image, video, audio, icon, background image)
 * - Components embedded in rich-text content
 * - Component variable default values
 * - Component override values
 */
export function collectLayerAssetIds(
  layers: Layer[],
  components: Component[],
): Set<string> {
  const assetIds = new Set<string>();

  const addAssetId = (id: unknown) => {
    if (typeof id !== 'string' || !id) return;
    if (isValidUUID(id)) {
      assetIds.add(id);
    }
  };

  const addAssetVar = (v: any) => {
    if (isAssetVariable(v)) {
      const id = getAssetId(v);
      addAssetId(id);
    }
  };

  /** Find componentOverrides for a specific componentId within a Tiptap tree. */
  const findOverrides = (node: any, targetId: string): Layer['componentOverrides'] | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === 'richTextComponent' && node.attrs?.componentId === targetId) {
      return node.attrs.componentOverrides ?? undefined;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        const found = findOverrides(child, targetId);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  /** Scan component overrides directly for asset IDs. */
  const scanOverrideAssets = (overrides: Layer['componentOverrides'], ancestors: Set<string>): void => {
    if (!overrides) return;
    for (const category of ['text', 'rich_text'] as const) {
      const textOverrides = overrides[category];
      if (!textOverrides) continue;
      for (const val of Object.values(textOverrides)) {
        const content = (val as any)?.data?.content;
        if (content && typeof content === 'object') {
          scanRichTextMarks(content);
          scanRichTextComponents(content, ancestors);
        }
      }
    }
    for (const category of ['image', 'icon', 'audio', 'video'] as const) {
      const overrideMap = overrides[category];
      if (!overrideMap) continue;
      for (const val of Object.values(overrideMap)) {
        const v = val as any;
        addAssetVar(v?.src);
        addAssetVar(v?.poster);
      }
    }
    if (overrides.link) {
      for (const val of Object.values(overrides.link)) {
        const v = val as any;
        addAssetId(v?.asset?.id);
      }
    }
  };

  /** Scan Tiptap JSON for embedded richTextComponent nodes and collect their asset IDs. */
  const scanRichTextComponents = (node: any, ancestors: Set<string>): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'richTextComponent' && node.attrs?.componentId) {
      const cid = node.attrs.componentId as string;
      if (!ancestors.has(cid)) {
        const childAncestors = new Set(ancestors);
        childAncestors.add(cid);
        const overrides = node.attrs.componentOverrides ?? undefined;
        scanOverrideAssets(overrides, childAncestors);

        // Use pre-resolved layers when available (SSR path with slimmed components)
        if (node.attrs._resolvedLayers?.length) {
          (node.attrs._resolvedLayers as any[]).forEach(l => scanLayer(l, childAncestors));
        } else {
          const comp = components.find(c => c.id === cid);
          if (comp?.layers?.length) {
            const resolved = applyComponentOverrides(comp.layers, overrides, comp.variables);
            resolved.forEach(l => scanLayer(l, childAncestors));
            scanVariableDefaults(comp.variables, childAncestors);
          }
        }
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        scanRichTextComponents(child, ancestors);
      }
    }
  };

  /** Scan rich-text marks for asset links and richTextImage nodes for asset IDs. */
  const scanRichTextMarks = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'richTextImage' && node.attrs?.assetId) {
      addAssetId(node.attrs.assetId);
    }
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark.type === 'richTextLink') {
          addAssetId(mark.attrs?.asset?.id);
        }
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) scanRichTextMarks(child);
    }
  };

  /** Scan component variable default values for asset references. */
  const scanVariableDefaults = (variables: ComponentVariable[] | undefined, ancestors: Set<string>): void => {
    if (!variables?.length) return;
    for (const variable of variables) {
      const def = variable.default_value as any;
      if (!def) continue;
      addAssetVar(def.src);
      addAssetVar(def.poster);
      const content = def.data?.content;
      if (content && typeof content === 'object') {
        scanRichTextComponents(content, ancestors);
      }
    }
  };

  /** Recursively scan a single layer for asset IDs. */
  const scanLayer = (layer: Layer, ancestors?: Set<string>): void => {
    addAssetVar(layer.variables?.image?.src);
    addAssetVar(layer.variables?.video?.src);
    addAssetVar(layer.variables?.video?.poster);
    addAssetVar(layer.variables?.audio?.src);
    addAssetVar(layer.variables?.icon?.src);
    addAssetVar(layer.variables?.backgroundImage?.src);

    // Direct asset link
    const linkAssetId = layer.variables?.link?.asset?.id;
    addAssetId(linkAssetId);

    // Lightbox file assets
    if (layer.settings?.lightbox?.files) {
      for (const fileId of layer.settings.lightbox.files) {
        if (fileId && !fileId.startsWith('http') && !fileId.startsWith('/')) {
          addAssetId(fileId);
        }
      }
    }

    // Rich-text content: scan for asset links and embedded component assets
    const textVar = layer.variables?.text;
    if (textVar && 'data' in textVar && (textVar as any).data?.content) {
      const content = (textVar as any).data.content;
      scanRichTextMarks(content);
      scanRichTextComponents(content, ancestors ?? new Set<string>());
    }

    // Component override values
    scanOverrideAssets(layer.componentOverrides, ancestors ?? new Set<string>());

    // Component variable defaults
    if (layer.componentId) {
      const comp = components.find(c => c.id === layer.componentId);
      if (comp?.variables) {
        scanVariableDefaults(comp.variables, ancestors ?? new Set<string>());
      }
    }

    // Collection item values on resolved collection layers
    if (layer._collectionItemValues) {
      for (const value of Object.values(layer._collectionItemValues)) {
        if (typeof value === 'string') {
          if (isValidUUID(value)) {
            assetIds.add(value);
          } else if (value.startsWith('{')) {
            try {
              const parsed = JSON.parse(value);
              if (parsed?.type === 'asset' && parsed?.asset?.id && isValidUUID(parsed.asset.id)) {
                assetIds.add(parsed.asset.id);
              }
            } catch { /* not valid JSON, skip */ }
          }
        }
        // Scan rich_text values (Tiptap JSON) for embedded image assets
        if (value && typeof value === 'object' && (value as any).type === 'doc') {
          scanRichTextMarks(value);
        }
      }
    }

    if (layer.children) {
      layer.children.forEach(child => scanLayer(child, ancestors));
    }
  };

  layers.forEach(layer => scanLayer(layer));
  return assetIds;
}
