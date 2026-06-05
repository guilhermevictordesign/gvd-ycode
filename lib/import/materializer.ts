/**
 * Import materializer.
 *
 * Owns the side-effecting, deduplicated creation of the persistent entities an
 * import needs: layer styles, components, assets and fonts. A single instance
 * lives for the duration of one paste so that a class/url/font referenced by
 * hundreds of nodes is only created once (promise-cached).
 *
 * Generalised from the Figma materializer so both importers can share it.
 */

import type { Asset, Component, ComponentVariable, Font, Layer, LayerStyle } from '@/types';
import { useLayerStylesStore } from '@/stores/useLayerStylesStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useFontsStore } from '@/stores/useFontsStore';
import { buildDesign } from '@/lib/import/design';
import type { ImportStyleRef } from '@/lib/import/types';

/**
 * Stable identity for "same style": name plus its declarations, order-agnostic
 * (the class set, not its written order, defines equality). Lets re-pasted
 * combos reuse a previously created style instead of duplicating it.
 */
function contentKey(name: string, classes: string): string {
  const sorted = classes.split(/\s+/).filter(Boolean).sort().join(' ');
  return `${name}\u0000${sorted}`;
}

/** Mutable counters surfaced in the post-import summary toast. */
export interface MaterializerCounts {
  styles: number;
  components: number;
  assets: number;
  fonts: number;
}

export class ImportMaterializer {
  readonly counts: MaterializerCounts = { styles: 0, components: 0, assets: 0, fonts: 0 };

  /** Source label (e.g. "Webflow") used to tag re-hosted assets. */
  private readonly group: string;

  /** Dedupe caches keyed by a stable identity. */
  private readonly styleCache = new Map<string, Promise<LayerStyle | null>>();
  private readonly assetCache = new Map<string, Promise<string | null>>();
  private readonly fontCache = new Map<string, Promise<Font | null>>();

  /** Names already taken (existing styles + ones created this run). */
  private readonly usedStyleNames: Set<string>;

  /** Existing styles keyed by `name\u0000<sorted classes>` for cross-paste reuse. */
  private readonly stylesByContent = new Map<string, LayerStyle>();

  constructor(group: string) {
    this.group = group;
    const existing = useLayerStylesStore.getState().styles ?? [];
    this.usedStyleNames = new Set(existing.map((s) => s.name));
    for (const style of existing) {
      this.stylesByContent.set(contentKey(style.name, style.classes), style);
    }
  }

  /**
   * Create (or reuse) a `LayerStyle` for a reusable class reference.
   *
   * Reuse is two-tiered: by the ref's stable key within one paste, and by
   * name + content across pastes/existing styles — so re-pasting a `Button`
   * combo links to the same style instead of spawning `Button 2`, `Button 3`.
   */
  getOrCreateStyle(ref: ImportStyleRef): Promise<LayerStyle | null> {
    const cached = this.styleCache.get(ref.key);
    if (cached) return cached;

    const promise = (async () => {
      const classes = ref.classes.join(' ').trim();
      if (!classes) return null;

      const name = ref.name || 'Imported';

      // Reuse an existing style with the same name and identical declarations.
      const key = contentKey(name, classes);
      const existing = this.stylesByContent.get(key);
      if (existing) return existing;

      const design = buildDesign(classes);
      // Leave imported styles ungrouped so they always surface in the layer
      // style picker (grouped styles only show when that group is selected).
      const style = await useLayerStylesStore.getState().createStyle(this.uniqueStyleName(name), classes, design);
      if (style) {
        this.counts.styles += 1;
        // Register under both the requested name and the (possibly suffixed)
        // created name so later refs in this run can still reuse it.
        this.stylesByContent.set(key, style);
        this.stylesByContent.set(contentKey(style.name, style.classes), style);
      }
      return style;
    })();

    this.styleCache.set(ref.key, promise);
    return promise;
  }

  /** Re-host a remote image and return its Ycode asset id (null on failure). */
  uploadAsset(url: string): Promise<string | null> {
    const cached = this.assetCache.get(url);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        const filename = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'image');
        const file = new File([blob], filename, { type: blob.type || 'image/png' });

        const formData = new FormData();
        formData.append('file', file);
        formData.append('source', `${this.group.toLowerCase()}-import`);

        const uploadResponse = await fetch('/ycode/api/files/upload', {
          method: 'POST',
          body: formData,
        });
        if (!uploadResponse.ok) return null;

        const data = await uploadResponse.json();
        const asset: Asset | undefined = data?.data;
        if (!asset?.id) return null;

        useAssetsStore.getState().addAsset(asset);
        this.counts.assets += 1;
        return asset.id;
      } catch {
        // CORS or network failure — caller falls back to the remote URL.
        return null;
      }
    })();

    this.assetCache.set(url, promise);
    return promise;
  }

  /** Install a Google Font matching `family` (no-op if unavailable/installed). */
  installFont(family: string): Promise<Font | null> {
    const key = family.toLowerCase();
    const cached = this.fontCache.get(key);
    if (cached) return cached;

    const promise = (async () => {
      const fonts = useFontsStore.getState();
      const existing = fonts.getFontByFamily(family);
      if (existing) return existing;

      const match = fonts.googleFontsCatalog.find((f) => f.family.toLowerCase() === key);
      if (!match) return null;

      const installed = await fonts.addGoogleFont(match);
      if (installed) this.counts.fonts += 1;
      return installed;
    })();

    this.fontCache.set(key, promise);
    return promise;
  }

  /**
   * Create a reusable component (optionally with variables) and register it in
   * the components store so it resolves immediately on the canvas.
   */
  async createComponent(
    name: string,
    layers: Layer[],
    variables?: ComponentVariable[],
  ): Promise<Component | null> {
    try {
      const response = await fetch('/ycode/api/components', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, layers, variables }),
      });
      const result = await response.json();
      if (result.error || !result.data) return null;

      const component: Component = result.data;
      useComponentsStore.setState((state) => ({ components: [component, ...state.components] }));
      this.counts.components += 1;
      return component;
    } catch {
      return null;
    }
  }

  private uniqueStyleName(base: string): string {
    let name = base.trim() || 'Imported';
    if (!this.usedStyleNames.has(name)) {
      this.usedStyleNames.add(name);
      return name;
    }
    let i = 2;
    while (this.usedStyleNames.has(`${base} ${i}`)) i += 1;
    name = `${base} ${i}`;
    this.usedStyleNames.add(name);
    return name;
  }
}
