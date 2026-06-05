/**
 * Webflow XSCP → neutral import IR.
 *
 * Rebuilds the tree from the flat `nodes[]` array (hierarchy lives in
 * `children: [id]`) and maps each Webflow node type onto an `ImportNode`.
 */

import type { ImportDocument, ImportNode, ImportStyleRef } from '@/lib/import/types';
import { buildStyleResolvers, extractFontFamilies } from '@/lib/import/adapters/webflow/styles';
import { imageFromNode } from '@/lib/import/adapters/webflow/assets';
import { buildCollectionNode, isCollectionWrapper, isDynamoType } from '@/lib/import/adapters/webflow/collections';
import { webflowIconSvg } from '@/lib/import/adapters/webflow/icons';
import { cssToClasses } from '@/lib/import/css';
import { ruleToClasses, type GlobalStylesheet } from '@/lib/import/adapters/webflow/global-styles';
import type { WebflowParseContext, XscpNode, XscpPayload } from '@/lib/import/adapters/webflow/xscp-types';

const HEADING_TAGS = /^h[1-6]$/;

/**
 * Friendly layer-style names for the site stylesheet's global tag rules. These
 * become reusable styles at the bottom of an element's stack (e.g. every `h2`
 * carries the shared "Heading 2" style under its own classes), mirroring
 * Webflow's global tag/HTML-element styles.
 */
const TAG_STYLE_NAMES: Record<string, string> = {
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
  a: 'Link',
  p: 'Paragraph',
  li: 'List item',
  blockquote: 'Blockquote',
  body: 'Body',
};

/**
 * Layout defaults for Webflow widget node types whose layout normally comes
 * from Webflow's built-in framework CSS (`.w-slider`, `.w-tabs`, `.w-nav`, …)
 * rather than the user's own classes. That framework CSS isn't in the clipboard,
 * so without this sliders stack vertically, tab panes pile up, nav links wrap,
 * etc.
 *
 * These are applied as the element's `frameworkClasses` — the lowest layer in
 * the cascade — so they only fill gaps the user's classes don't already set
 * (e.g. a tab link that already has `display:flex` keeps it; we never override).
 *
 * NB: this reproduces the *visual* layout only. Widget behaviour (slide
 * transitions, tab switching, dropdown toggling) comes from Webflow's runtime,
 * which isn't in the clipboard — the user re-wires interactivity in Ycode.
 */
const WEBFLOW_WIDGET_CLASSES: Record<string, string[]> = {
  // Slider (.w-slider / .w-slider-mask / .w-slide) — slides sit in a row.
  SliderWrapper: ['relative'],
  SliderMask: ['flex'],
  SliderSlide: ['shrink-0'],
  // Tabs (.w-tabs / .w-tab-content / .w-tab-link). Inactive panes are hidden
  // separately (see TabsContent handling) to mirror Webflow's single-pane view.
  TabsWrapper: ['relative'],
  TabsContent: ['relative'],
  TabsLink: ['inline-block'],
  // Navbar (.w-nav*). The mobile hamburger (.w-nav-button) is hidden on desktop;
  // brand and links sit inline so the bar reads horizontally.
  NavbarWrapper: ['relative'],
  NavbarBrand: ['inline-block'],
  NavbarLink: ['inline-block'],
  NavbarButton: ['hidden'],
  // Dropdown (.w-dropdown*). The list is collapsed (closed) by default.
  DropdownWrapper: ['inline-block', 'relative'],
  DropdownToggle: ['inline-block', 'relative'],
  DropdownList: ['absolute', 'hidden'],
  // Forms — the success/error messages are hidden until the form is submitted.
  FormSuccessMessage: ['hidden'],
  FormErrorMessage: ['hidden'],
  // Background video (.w-background-video) clips its absolutely-positioned video.
  BackgroundVideoWrapper: ['relative', 'overflow-hidden'],
};

/**
 * Recover the Webflow navigator label for a node.
 *
 * Webflow's layer name is the element's primary (base) class name, which lives
 * in `styles[].name` — its `data.displayName` is almost always blank. So we use
 * an explicit `displayName` when present, otherwise fall back to the base
 * (non-combo) class name. This reproduces labels like "Hero Block" or
 * "Schedule Heading" in Ycode's layer tree.
 */
function resolveDisplayName(node: XscpNode, styles: ImportStyleRef[]): string | undefined {
  const explicit = typeof node.data?.displayName === 'string' ? node.data.displayName.trim() : '';
  if (explicit) return explicit;
  const base = styles.find((s) => !s.combo) ?? styles[0];
  return base?.name || undefined;
}

/**
 * Resolve every style on a node: its Webflow class-id list (base first) plus
 * any class *names* declared as a custom HTML `class` attribute (`xattr`).
 *
 * Webflow's design-system classes (e.g. `text-h2`, which sets the heading's
 * font size and weight) are frequently applied only via `xattr` and are absent
 * from the node's `classes` id list — so without this they'd be dropped and the
 * element would fall back to default typography.
 */
function resolveNodeStyles(node: XscpNode, ctx: WebflowParseContext): ImportStyleRef[] {
  const refs = ctx.resolveStyles(node.classes);
  const seen = new Set(refs.map((r) => r.key));

  for (const entry of node.data?.xattr ?? []) {
    if (entry?.name !== 'class' || typeof entry.value !== 'string') continue;
    for (const name of entry.value.split(/\s+/).filter(Boolean)) {
      const ref = ctx.resolveStyleByName(name);
      if (ref && !seen.has(ref.key)) {
        seen.add(ref.key);
        refs.push(ref);
      }
    }
  }

  return refs;
}

/** Serialize a rebuilt Webflow `DOM` SVG subtree back into inline SVG markup. */
function serializeDomSvg(node: XscpNode, ctx: WebflowParseContext): string {
  const tag = node.data?.tag;
  if (!tag) return '';
  const attrs = (node.data?.attributes ?? [])
    .filter((a) => a?.name)
    .map((a) => `${a.name}="${(a.value ?? '').replace(/"/g, '&quot;')}"`)
    .join(' ');
  const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
  const inner = (node.children ?? [])
    .map((id) => ctx.byId.get(id))
    .filter((n): n is XscpNode => n !== undefined)
    .map((child) => serializeDomSvg(child, ctx))
    .join('');
  return `${open}${inner}</${tag}>`;
}

/**
 * Extract inline SVG markup from a node, if it carries any:
 *   - `HtmlEmbed` nodes hold raw markup (often an `<svg>`) in `v`.
 *   - `DOM` nodes with `data.tag === 'svg'` are a rebuilt SVG element whose
 *     children (`path`, `g`, `defs`, …) are further `DOM` nodes.
 * Returns null when the node isn't an inline SVG (caller treats it normally).
 */
function extractInlineSvg(node: XscpNode, ctx: WebflowParseContext): string | null {
  if (node.type === 'HtmlEmbed') {
    const markup = typeof node.v === 'string' ? node.v : '';
    return markup.includes('<svg') ? markup : null;
  }
  if (node.type === 'DOM' && node.data?.tag === 'svg') {
    return serializeDomSvg(node, ctx);
  }
  return null;
}

/**
 * Flatten a run of inline children into a single string. Descends into inline
 * wrapper elements (e.g. `Span`) so their text isn't lost: Webflow wraps an
 * emphasised word — like a gradient "reasons" inside a heading — in a `Span`
 * whose text lives in a nested leaf, not on the `Span` node itself.
 */
function collectText(childNodes: XscpNode[], ctx: WebflowParseContext): string {
  return childNodes
    .map((n) => {
      if (n.type === 'LineBreak') return '\n';
      if (n.text === true) return n.v ?? '';
      const inner = (n.children ?? [])
        .map((id) => ctx.byId.get(id))
        .filter((c): c is XscpNode => c !== undefined);
      return inner.length > 0 ? collectText(inner, ctx) : (n.v ?? '');
    })
    .join('');
}

/**
 * True when every child is inline text content: a text leaf, a line break, or
 * an inline `Span` wrapper (whose own text is recovered by `collectText`). This
 * keeps headings/paragraphs with emphasised spans as a single text element
 * rather than splitting them into separate layers.
 */
function isTextual(childNodes: XscpNode[]): boolean {
  return childNodes.length > 0
    && childNodes.every((n) => n.text === true || n.type === 'LineBreak' || n.type === 'Span');
}

export function parseWebflow(data: XscpPayload, globalStyles?: GlobalStylesheet): ImportDocument {
  const nodes = data.payload?.nodes ?? [];
  const styles = data.payload?.styles ?? [];
  const assets = data.payload?.assets ?? [];

  const byId = new Map<string, XscpNode>();
  for (const node of nodes) byId.set(node._id, node);

  const resolvers = buildStyleResolvers(styles, assets, globalStyles);
  const resolveStyle = resolvers.byId;
  const resolveStyles = (classIds: string[] | undefined): ImportStyleRef[] =>
    (classIds ?? []).map(resolveStyle).filter((r): r is ImportStyleRef => r !== null);

  // Global tag rules (e.g. `h2` heading color) as named, reusable style refs,
  // memoised per tag. Null when no stylesheet is supplied or the tag has no rule.
  const tagUnderlayCache = new Map<string, ImportStyleRef | null>();
  const tagUnderlay = (tag?: string): ImportStyleRef | null => {
    if (!tag || !globalStyles) return null;
    const key = tag.toLowerCase();
    if (tagUnderlayCache.has(key)) return tagUnderlayCache.get(key) ?? null;
    const rule = globalStyles.tagRules.get(key);
    const classes = rule ? ruleToClasses(rule) : [];
    const ref: ImportStyleRef | null = classes.length > 0
      ? { key: `wf-tag:${key}`, name: TAG_STYLE_NAMES[key] ?? key.toUpperCase(), classes }
      : null;
    tagUnderlayCache.set(key, ref);
    return ref;
  };

  const ctx: WebflowParseContext = {
    byId,
    resolveStyle,
    resolveStyleByName: resolvers.byName,
    resolveStyles,
    resolveAssetUrl: resolvers.resolveAssetUrl,
    tagUnderlay,
    buildNode: (node) => buildNode(node, ctx),
  };

  // Roots = element nodes that are never referenced as someone's child.
  const childIds = new Set<string>();
  for (const node of nodes) {
    for (const childId of node.children ?? []) childIds.add(childId);
  }
  const roots = nodes
    .filter((n) => !childIds.has(n._id) && !n.text)
    .map((n) => buildNode(n, ctx))
    .filter((n): n is ImportNode => n !== null);

  // The site's base text style (`.body`: font-family, color, size) lives on the
  // <body>, which isn't in the clipboard. Apply it to the roots as a shared
  // "Body" style at the very bottom of their stack so the whole paste inherits
  // the right typeface/colour (font-family/color cascade to descendants).
  if (globalStyles?.bodyDecl) {
    const bodyClasses = cssToClasses(globalStyles.bodyDecl);
    if (bodyClasses.length > 0) {
      const bodyRef: ImportStyleRef = { key: 'wf-body', name: 'Body', classes: bodyClasses };
      for (const root of roots) {
        root.underlayStyles = [bodyRef, ...(root.underlayStyles ?? [])];
      }
    }
  }

  const fontFamilies = new Set(extractFontFamilies(styles));
  for (const family of globalStyles?.fontFamilies ?? []) fontFamilies.add(family);
  const fonts = [...fontFamilies].map((family) => ({ family }));

  return { roots, fonts, source: 'Webflow' };
}

function buildNode(node: XscpNode | undefined, ctx: WebflowParseContext): ImportNode | null {
  if (!node) return null;

  // Bare text leaf surfacing as a root.
  if (node.text === true) {
    return { kind: 'text', text: node.v ?? '' };
  }

  const type = node.type;

  // Collection lists.
  if (isDynamoType(type)) {
    if (isCollectionWrapper(type)) return buildCollectionNode(node, ctx);
    return null; // list / item / empty consumed by the wrapper.
  }

  // Webflow built-in widget icons (slider arrows, chevrons, hamburger) carry a
  // named glyph from Webflow's icon font; map the common ones to inline SVG.
  if (type === 'Icon') {
    const svg = webflowIconSvg(node.data?.widget?.icon);
    if (!svg) return null;
    const iconStyles = resolveNodeStyles(node, ctx);
    const icon: ImportNode = { kind: 'icon', styles: iconStyles, svg };
    // Webflow icons inherit size from the widget's defaults (which aren't in the
    // clipboard), so give unstyled icons a sensible default box.
    if (iconStyles.length === 0) icon.classes = ['inline-block', 'w-6', 'h-6'];
    return icon;
  }

  // Inline SVGs (HtmlEmbed raw markup, or a rebuilt DOM <svg> tree). Without
  // this they collapse to empty boxes — e.g. social, arrow and chevron icons.
  const inlineSvg = extractInlineSvg(node, ctx);
  if (inlineSvg) {
    const svgStyles = resolveNodeStyles(node, ctx);
    return { kind: 'icon', styles: svgStyles, svg: inlineSvg, displayName: resolveDisplayName(node, svgStyles) };
  }

  const childNodes = (node.children ?? [])
    .map((id) => ctx.byId.get(id))
    .filter((n): n is XscpNode => n !== undefined);
  const styles = resolveNodeStyles(node, ctx);
  const displayName = resolveDisplayName(node, styles);

  if (type === 'Image') {
    return { kind: 'image', styles, image: imageFromNode(node, ctx.resolveAssetUrl), displayName };
  }

  if (type === 'Link') {
    const href = node.data?.link?.href || node.data?.attr?.href;
    const link = href ? { href } : undefined;
    const base: ImportNode = { kind: 'link', tag: 'a', styles, link, displayName };
    // The site's global `a` rule (color/decoration) becomes a shared "Link"
    // style beneath the element's own classes.
    const linkUnderlay = ctx.tagUnderlay('a');
    if (linkUnderlay) base.underlayStyles = [linkUnderlay];
    // Webflow buttons (`data.button`) rely on the framework's
    // `.w-button { display: inline-block }`, which isn't in the clipboard.
    // Flag them so they become Ycode `button` layers and seed the missing
    // display so they shrink-wrap instead of stretching inside a flex parent.
    const isButton = node.data?.button === true;
    if (isButton) {
      base.button = true;
      base.frameworkClasses = ['inline-block'];
    }
    if (isTextual(childNodes)) {
      base.text = collectText(childNodes, ctx);
    } else {
      base.children = childNodes.map((c) => buildNode(c, ctx)).filter((n): n is ImportNode => n !== null);
    }
    return base;
  }

  if (type === 'Heading') {
    const heading: ImportNode = { kind: 'heading', tag: node.tag, styles, text: collectText(childNodes, ctx), displayName };
    const underlay = ctx.tagUnderlay(node.tag);
    if (underlay) heading.underlayStyles = [underlay];
    return heading;
  }

  if (isTextual(childNodes)) {
    const textNode: ImportNode = { kind: 'text', tag: node.tag, styles, text: collectText(childNodes, ctx), displayName };
    const underlay = ctx.tagUnderlay(node.tag);
    if (underlay) textNode.underlayStyles = [underlay];
    return textNode;
  }

  const children = childNodes.map((c) => buildNode(c, ctx)).filter((n): n is ImportNode => n !== null);

  // Tabs show one pane at a time. The clipboard has no active-pane runtime, so
  // mirror Webflow's default view: keep the first pane visible, hide the rest.
  // The user reveals the others when they re-wire the tabs in Ycode.
  if (type === 'TabsContent') {
    children.forEach((pane, i) => {
      if (i > 0) pane.frameworkClasses = [...(pane.frameworkClasses ?? []), 'hidden'];
    });
  }

  const box: ImportNode = { kind: 'box', tag: node.tag, styles, displayName, children };
  const underlay = ctx.tagUnderlay(node.tag);
  if (underlay) box.underlayStyles = [underlay];
  const widgetClasses = type ? WEBFLOW_WIDGET_CLASSES[type] : undefined;
  if (widgetClasses && widgetClasses.length > 0) box.frameworkClasses = widgetClasses;
  return box;
}
