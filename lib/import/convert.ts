/**
 * IR → Ycode `Layer[]` conversion.
 *
 * Walks the neutral `ImportNode` tree and produces real Ycode layers, creating
 * (and linking) shared `LayerStyle`s and re-hosting assets through the
 * materializer along the way.
 */

import type { Layer, LinkSettings } from '@/types';
import { generateId } from '@/lib/utils';
import { buildDesign } from '@/lib/import/design';
import { mergeClassStack } from '@/lib/layer-style-resolve';
import type { ImportMaterializer } from '@/lib/import/materializer';
import type { ImportNode, ImportStyleRef } from '@/lib/import/types';

/** Semantic tags that should be preserved via `settings.tag` on a div layer. */
const SEMANTIC_TAGS = new Set([
  'section', 'nav', 'header', 'footer', 'main', 'aside', 'article',
  'ul', 'ol', 'li', 'figure', 'figcaption', 'blockquote',
]);

interface ResolvedStyling {
  classes: string;
  design: Layer['design'];
  /** Ordered applied styles, low -> high priority (base class first, combos after). */
  styleIds?: string[];
  styleOverrides?: Layer['styleOverrides'];
  /** Per-chip overrides (e.g. one-off classes folded onto the top chip). */
  styleOverridesByStyle?: Layer['styleOverridesByStyle'];
}

/** Build a Tiptap rich-text doc from plain text (newlines become hard breaks). */
function buildTextDoc(text: string): object {
  const parts = text.split('\n');
  const content: Array<Record<string, unknown>> = [];
  parts.forEach((part, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (part) content.push({ type: 'text', text: part });
  });
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

function makeRichTextVariable(text: string) {
  return { type: 'dynamic_rich_text' as const, data: { content: buildTextDoc(text) } };
}

export class ImportConverter {
  /**
   * @param mat        Materializer for deduped styles/assets/components.
   * @param onProgress Called once per converted node (at every nesting level),
   *                   so the caller can drive a "n of total" paste indicator.
   */
  constructor(
    private readonly mat: ImportMaterializer,
    private readonly onProgress?: () => void,
  ) {}

  /** Convert a list of root nodes into Ycode layers. */
  async convertNodes(nodes: ImportNode[]): Promise<Layer[]> {
    const layers: Layer[] = [];
    for (const node of nodes) {
      const layer = await this.convertNode(node);
      if (layer) layers.push(layer);
      this.onProgress?.();
    }
    return layers;
  }

  private async convertNode(node: ImportNode): Promise<Layer | null> {
    switch (node.kind) {
      case 'icon':
        return this.convertIcon(node);
      case 'image':
        return this.convertImage(node);
      case 'text':
      case 'heading':
        return this.convertText(node);
      case 'collection':
        return this.convertCollection(node);
      case 'link':
        return this.convertBox(node, true);
      case 'box':
      default:
        return this.convertBox(node, false);
    }
  }

  /**
   * Resolve a node's reusable styles + extra classes into a styled layer base.
   *
   * Webflow stacks multiple reusable classes on one element (a base class plus
   * combo classes), sitting on top of global tag/HTML-element styles. We mirror
   * that as an ordered `styleIds` stack, lowest priority first: the global
   * underlay styles (tag rules like `h2`/`a`, plus the document `body` style),
   * then the base class, then combo classes — one reusable `LayerStyle` each.
   * The lowest reusable style also absorbs the anonymous framework shims (widget
   * layout / button `inline-block` not in the clipboard). The flat
   * `layer.classes` is derived from the stack, so the render is identical
   * regardless of how it's split. One-off classes (`node.classes`) become
   * `styleOverrides` (highest priority).
   */
  private async resolveStyling(node: ImportNode): Promise<ResolvedStyling> {
    const underlay = node.underlayStyles ?? [];
    const refs = node.styles ?? [];
    const extra = node.classes ?? [];
    // Anonymous layout shims (widget defaults, button `inline-block`) sit at the
    // very bottom of the cascade, folded into the lowest reusable style so they
    // fill gaps without becoming a standalone style.
    const framework = node.frameworkClasses ?? [];

    // Ordered named styles, lowest priority first: global underlay (tag/body)
    // styles, then the base class, then combo classes. Combo/later classes win,
    // matching Webflow precedence and Tailwind's last-wins resolution.
    const base = refs.length > 0 ? (refs.find((r) => !r.combo) ?? refs[0]) : undefined;
    const combos = base ? refs.filter((r) => r !== base) : [];
    const orderedNamed: { ref: ImportStyleRef; foldsFramework: boolean }[] = [];
    for (const u of underlay) orderedNamed.push({ ref: u, foldsFramework: false });
    if (base) {
      orderedNamed.push({ ref: base, foldsFramework: true });
      for (const c of combos) orderedNamed.push({ ref: c, foldsFramework: false });
    }
    // With no base class to absorb them, fold the shims into the lowest named
    // (underlay) style so they persist when the stack is later re-resolved.
    if (!base && framework.length > 0 && orderedNamed.length > 0) {
      orderedNamed[0].foldsFramework = true;
    }

    const styleIds: string[] = [];
    const stackClasses: string[] = [];
    let topStyleId: string | undefined;
    let topStyleClasses = '';

    for (const { ref, foldsFramework } of orderedNamed) {
      const classes = foldsFramework && framework.length > 0
        ? mergeClassStack([...framework, ...ref.classes])
        : mergeClassStack(ref.classes);

      const styleRef: ImportStyleRef = {
        // Fold framework into the style's identity so a base reused with
        // different widget defaults doesn't collapse onto the wrong style.
        key: foldsFramework && framework.length > 0 ? `fw:${framework.join('+')}|${ref.key}` : ref.key,
        name: ref.name,
        classes,
      };

      const style = await this.mat.getOrCreateStyle(styleRef);
      if (style) {
        styleIds.push(style.id);
        stackClasses.push(...style.classes.split(/\s+/).filter(Boolean));
        topStyleId = style.id;
        topStyleClasses = style.classes;
      } else {
        // Empty/failed (e.g. a declaration-less combo): inline its classes so
        // nothing is lost, but don't create a style reference for it.
        stackClasses.push(...classes);
      }
    }

    if (styleIds.length > 0) {
      const merged = mergeClassStack(stackClasses);
      if (extra.length > 0 && topStyleId) {
        // One-off classes override the stack, so they merge in last. Store them
        // as a per-chip override on the TOP chip (not the legacy single-blob
        // `styleOverrides`, which would freeze the layer against style updates
        // and get dropped on the first chip edit). The override replaces the top
        // chip's classes for this layer with the chip's own classes + the extras.
        const full = mergeClassStack([...merged, ...extra]).join(' ');
        const overrideClasses = mergeClassStack([
          ...topStyleClasses.split(/\s+/).filter(Boolean),
          ...extra,
        ]).join(' ');
        return {
          classes: full,
          design: buildDesign(full),
          styleIds,
          styleOverridesByStyle: {
            [topStyleId]: { classes: overrideClasses, design: buildDesign(overrideClasses) },
          },
        };
      }
      const classesStr = merged.join(' ').trim();
      return { classes: classesStr, design: buildDesign(classesStr), styleIds };
    }

    // No reusable style (none present, or creation failed): inline everything,
    // framework + global underlay first so the user's classes still win.
    const all = mergeClassStack([
      ...framework,
      ...underlay.flatMap((u) => u.classes),
      ...refs.flatMap((r) => r.classes),
      ...extra,
    ]).join(' ').trim();
    return { classes: all, design: buildDesign(all) };
  }

  private applyStyling(layer: Layer, styling: ResolvedStyling): void {
    layer.classes = styling.classes;
    if (styling.design) layer.design = styling.design;
    if (styling.styleIds && styling.styleIds.length > 0) {
      layer.styleIds = styling.styleIds;
      layer.styleId = styling.styleIds[0]; // legacy mirror during migration
    }
    if (styling.styleOverrides) layer.styleOverrides = styling.styleOverrides;
    if (styling.styleOverridesByStyle) layer.styleOverridesByStyle = styling.styleOverridesByStyle;
  }

  private async convertBox(node: ImportNode, isLink: boolean): Promise<Layer> {
    const styling = await this.resolveStyling(node);
    const tag = node.tag?.toLowerCase();
    const name = node.button
      ? 'button'
      : tag === 'section' ? 'section' : tag === 'form' ? 'form' : 'div';

    const layer: Layer = { id: generateId('lyr'), name, classes: '' };
    this.applyStyling(layer, styling);

    if (node.displayName) layer.customName = node.displayName;

    if (tag && tag !== name && SEMANTIC_TAGS.has(tag)) {
      layer.settings = { ...layer.settings, tag };
    }

    if (isLink && node.link?.href) {
      const link: LinkSettings = {
        type: 'url',
        url: { type: 'dynamic_text', data: { content: node.link.href } },
      };
      if (node.link.target) link.target = node.link.target as LinkSettings['target'];
      if (node.link.rel) link.rel = node.link.rel;
      layer.variables = { ...layer.variables, link };
    }

    const children = node.children ? await this.convertNodes(node.children) : [];
    if (children.length > 0) {
      layer.children = children;
    } else if (node.text) {
      layer.children = [this.makeTextLayer(node.text)];
    } else {
      layer.children = [];
    }

    return layer;
  }

  private async convertText(node: ImportNode): Promise<Layer> {
    const styling = await this.resolveStyling(node);
    const isHeading = node.kind === 'heading';
    const layer: Layer = {
      id: generateId('lyr'),
      name: isHeading ? 'heading' : 'text',
      classes: '',
      restrictions: { editText: true },
      variables: { text: makeRichTextVariable(node.text ?? '') },
    };
    this.applyStyling(layer, styling);
    if (node.displayName) layer.customName = node.displayName;

    if (isHeading && node.tag && /^h[1-6]$/.test(node.tag)) {
      layer.settings = { ...layer.settings, tag: node.tag };
    }

    return layer;
  }

  private async convertImage(node: ImportNode): Promise<Layer> {
    const styling = await this.resolveStyling(node);
    const img = node.image ?? {};

    let assetId = img.assetId;
    if (!assetId && img.src) {
      assetId = (await this.mat.uploadAsset(img.src)) ?? undefined;
    }

    const src = assetId
      ? { type: 'asset' as const, data: { asset_id: assetId } }
      : { type: 'dynamic_text' as const, data: { content: img.src ?? '' } };

    const layer: Layer = {
      id: generateId('lyr'),
      name: 'image',
      classes: '',
      variables: {
        image: {
          src,
          alt: { type: 'dynamic_text', data: { content: img.alt ?? '' } },
        },
      },
    };
    this.applyStyling(layer, styling);
    if (node.displayName) layer.customName = node.displayName;

    if (img.width || img.height) {
      layer.attributes = {
        ...layer.attributes,
        ...(img.width ? { width: img.width } : {}),
        ...(img.height ? { height: img.height } : {}),
      };
    }

    return layer;
  }

  private async convertIcon(node: ImportNode): Promise<Layer | null> {
    if (!node.svg) return null;
    const styling = await this.resolveStyling(node);
    const layer: Layer = {
      id: generateId('lyr'),
      name: 'icon',
      classes: '',
      variables: { icon: { src: { type: 'static_text', data: { content: node.svg } } } },
    };
    this.applyStyling(layer, styling);
    if (node.displayName) layer.customName = node.displayName;
    return layer;
  }

  private async convertCollection(node: ImportNode): Promise<Layer> {
    const styling = await this.resolveStyling(node);
    const layer: Layer = {
      id: generateId('lyr'),
      name: 'div',
      classes: '',
      // Empty placeholder — the user re-links this to a real Ycode collection.
      variables: { collection: { id: '' } },
    };
    this.applyStyling(layer, styling);
    if (node.displayName) layer.customName = node.displayName;

    const template = node.children ? await this.convertNodes(node.children) : [];
    layer.children = template.length > 0
      ? template
      : [{ id: generateId('lyr'), name: 'div', classes: '', children: [] }];

    return layer;
  }

  private makeTextLayer(text: string): Layer {
    return {
      id: generateId('lyr'),
      name: 'text',
      classes: '',
      restrictions: { editText: true },
      variables: { text: makeRichTextVariable(text) },
    };
  }
}
