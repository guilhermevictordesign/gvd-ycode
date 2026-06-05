'use client';

import type {
  Layer,
  DesignProperties,
  LayoutDesign,
  TypographyDesign,
  SpacingDesign,
  SizingDesign,
  BordersDesign,
  BackgroundsDesign,
  EffectsDesign,
  PositioningDesign,
  ComponentVariable,
  ComponentVariableValue,
  DynamicRichTextVariable,
} from '@/types';
import type {
  YcodeFigmaPayload,
  YcodeNode,
  YcodeImportOptions,
  FigmaStyleEntry,
} from '@/lib/figma/types';
import { generateId } from '@/lib/utils';
import { designToClassString } from '@/lib/tailwind-class-mapper';
import { getStyleIds } from '@/lib/layer-style-resolve';
import { uploadFigmaImage } from '@/lib/figma/image-handler';
import { FigmaMaterializer } from '@/lib/figma/materializer';
import { planResponsive } from '@/lib/figma/responsive';
import { figmaDebug } from '@/lib/figma/debug';
import { useComponentsStore } from '@/stores/useComponentsStore';

// ─── Conversion context ──────────────────────────────────────────────────────

interface ComponentVarBinding {
  id: string;
  kind: 'text' | 'image';
  /** Path (relative to an instance root) of the node whose value drives this variable. */
  path: number[];
}

interface ComponentBuildResult {
  componentId: string;
  variantId: string;
  /** variable id -> binding (own leaves + pass-through links into nested instances) */
  variableMap: Map<string, ComponentVarBinding>;
}

interface ConvertContext {
  payload: YcodeFigmaPayload;
  materializer: FigmaMaterializer;
  options: YcodeImportOptions;
  tokenRefs: Map<string, string>; // figma token id -> var(--id)
  components: Map<string, ComponentBuildResult>; // shape signature -> built result
  responsiveClasses: Map<YcodeNode, string[]>; // node -> max-lg:/max-md: overrides
  // Lowercased family names that actually resolve to an installed/built-in font.
  // When provided, a layer's fontFamily is only set if the family is in this set —
  // otherwise we'd emit a dangling `font-[...]` class with no backing CSS rule,
  // which silently renders as the default font. Undefined = keep every family.
  availableFonts?: Set<string>;
}

const DEDUP_THRESHOLD = 3;
// Figma instances are explicit components: materialize them even when a main
// component only appears once in the selection (matches user expectation).
const COMPONENTIZE_MIN_INSTANCES = 1;

function px(value: number | null | undefined): string | undefined {
  if (value == null || value === 0) return undefined;
  return `${Math.round(value * 100) / 100}px`;
}

function getLayerName(node: YcodeNode): string {
  switch (node.__class) {
    case 'TextNode': return 'text';
    case 'ImageNode': return 'image';
    case 'SvgNode': return 'icon';
    default: return 'div';
  }
}

function sanitizeCustomName(name: string): string {
  return name.trim().slice(0, 100);
}

// ─── Color helpers (CSS -> Ycode stored color format) ────────────────────────

function cssColorToStored(css: string): string | null {
  const c = css.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (/^#[0-9a-fA-F]{8}$/.test(c)) {
    const hex = c.slice(0, 7);
    const alpha = parseInt(c.slice(7, 9), 16) / 255;
    return `${hex}/${Math.round(alpha * 100)}`;
  }
  const rgba = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgba) {
    const r = parseInt(rgba[1], 10);
    const g = parseInt(rgba[2], 10);
    const b = parseInt(rgba[3], 10);
    const a = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    return a >= 1 ? hex : `${hex}/${Math.round(a * 100)}`;
  }
  return null;
}

// ─── Design mappers ──────────────────────────────────────────────────────────

function mapLayout(node: YcodeNode): LayoutDesign | undefined {
  if (node.display !== 'flex' && node.display !== 'grid') return undefined;

  const layout: LayoutDesign = { isActive: true };

  if (node.display === 'flex') {
    layout.display = 'Flex';
    layout.flexDirection = node.flexDirection || 'column';
    if (node.flexWrap === 'wrap') layout.flexWrap = 'wrap';
    if (node.justifyContent) layout.justifyContent = node.justifyContent;
    if (node.alignItems) layout.alignItems = node.alignItems;
    if (node.gap) layout.gap = node.gap + 'px';
    if (node.rowGap != null) {
      layout.rowGap = node.rowGap + 'px';
      layout.gapMode = 'individual';
    }
    if (node.columnGap != null) {
      layout.columnGap = node.columnGap + 'px';
      layout.gapMode = 'individual';
    }
  } else {
    layout.display = 'Grid';
    if (node.justifyContent) layout.justifyContent = node.justifyContent;
    if (node.alignItems) layout.alignItems = node.alignItems;
    if (node.gap) layout.gap = node.gap + 'px';
    if (node.rowGap != null) {
      layout.rowGap = node.rowGap + 'px';
      layout.gapMode = 'individual';
    }
    if (node.columnGap != null) {
      layout.columnGap = node.columnGap + 'px';
      layout.gapMode = 'individual';
    }
  }

  return layout;
}

function mapSpacing(node: YcodeNode): SpacingDesign | undefined {
  const { paddingTop, paddingRight, paddingBottom, paddingLeft } = node;
  if (!paddingTop && !paddingRight && !paddingBottom && !paddingLeft) return undefined;

  const allEqual = paddingTop === paddingRight && paddingRight === paddingBottom && paddingBottom === paddingLeft;

  if (allEqual) {
    return { isActive: true, padding: paddingTop + 'px', paddingMode: 'all' };
  }

  return {
    isActive: true,
    paddingTop: paddingTop + 'px',
    paddingRight: paddingRight + 'px',
    paddingBottom: paddingBottom + 'px',
    paddingLeft: paddingLeft + 'px',
    paddingMode: 'individual',
  };
}

function mapSizing(
  node: YcodeNode,
  parentFlexDir?: string | null,
): { sizing: SizingDesign; extraClasses: string[] } {
  const sizing: SizingDesign = { isActive: true };
  const extraClasses: string[] = [];

  const isMainAxisHorizontal = parentFlexDir === 'row';
  const isMainAxisVertical = parentFlexDir === 'column';

  if (node.widthType === 'fill') {
    if (isMainAxisHorizontal) {
      extraClasses.push('flex-1');
    } else {
      sizing.width = '100%';
    }
  } else if (node.widthType === 'hug') {
    sizing.width = 'fit-content';
  } else {
    sizing.width = Math.round(node.width) + 'px';
  }

  if (node.heightType === 'fill') {
    if (isMainAxisVertical) {
      extraClasses.push('flex-1');
    } else {
      sizing.height = '100%';
    }
  } else if (node.heightType === 'hug') {
    sizing.height = 'fit-content';
  } else {
    sizing.height = Math.round(node.height) + 'px';
  }

  const minW = px(node.minWidth);
  if (minW) sizing.minWidth = minW;

  const maxW = px(node.maxWidth);
  if (maxW) sizing.maxWidth = maxW;

  const minH = px(node.minHeight);
  if (minH) sizing.minHeight = minH;

  const maxH = px(node.maxHeight);
  if (maxH) sizing.maxHeight = maxH;

  if (node.overflow === 'hidden') {
    sizing.overflow = 'hidden';
  } else if (node.overflow === 'auto') {
    sizing.overflow = 'auto';
  } else if (node.overflow === 'scroll') {
    sizing.overflow = 'scroll';
  }

  return { sizing, extraClasses };
}

interface LineSeparator {
  vertical: boolean;
  thickness: string;
}

/**
 * Figma LINE nodes are zero-thickness strokes — they arrive as SvgNodes with a
 * 0 on one axis. Exporting them as an <svg> with a `rotate()` transform breaks
 * layout: a vertical divider is authored as a horizontal line rotated 90°, but
 * CSS rotation is visual-only, so the element still reserves its *unrotated*
 * width as a wide empty column (and the rotated full-height box looks nothing
 * like a line). Detect these and render a real 1px divider instead, deriving the
 * orientation from the geometry + rotation so layout reserves the right space.
 */
function asLineSeparator(node: YcodeNode): LineSeparator | null {
  if (node.__class !== 'SvgNode') return null;

  const w = Math.round(node.width ?? 0);
  const h = Math.round(node.height ?? 0);
  if (w !== 0 && h !== 0) return null; // not a degenerate line

  const rotated = node.rotation === 90 || node.rotation === 270 || node.rotation === -90;
  // The unrotated line is horizontal when its height is the zero axis.
  const unrotatedHorizontal = h === 0;
  const vertical = rotated ? unrotatedHorizontal : !unrotatedHorizontal;

  const thickness = `${Math.max(1, Math.round(node.borderWidth ?? 1))}px`;
  return { vertical, thickness };
}

function mapBackgrounds(node: YcodeNode): BackgroundsDesign | undefined {
  if (!node.fillEnabled) return undefined;

  const backgrounds: BackgroundsDesign = { isActive: true };
  let hasValue = false;

  if (node.fillColor) {
    backgrounds.backgroundColor = node.fillColor;
    hasValue = true;
  }

  if (node.fillGradient) {
    backgrounds.backgroundImage = node.fillGradient;
    hasValue = true;
  }

  return hasValue ? backgrounds : undefined;
}

function mapBorders(node: YcodeNode): BordersDesign | undefined {
  const borders: BordersDesign = {};
  let hasValue = false;

  if (node.borderEnabled) {
    if (node.borderColor) borders.borderColor = node.borderColor;
    borders.borderStyle = node.borderStyle || 'solid';

    if (node.borderPerSide) {
      if (node.borderTop != null) borders.borderTopWidth = node.borderTop + 'px';
      if (node.borderRight != null) borders.borderRightWidth = node.borderRight + 'px';
      if (node.borderBottom != null) borders.borderBottomWidth = node.borderBottom + 'px';
      if (node.borderLeft != null) borders.borderLeftWidth = node.borderLeft + 'px';
      borders.borderWidthMode = 'individual';
    } else {
      borders.borderWidth = node.borderWidth + 'px';
      borders.borderWidthMode = 'all';
    }
    hasValue = true;
  }

  if (node.radiusValue) {
    borders.borderRadius = node.radiusValue;
    hasValue = true;
  } else if (node.radiusPerCorner) {
    if (node.radiusTopLeft != null) borders.borderTopLeftRadius = node.radiusTopLeft + 'px';
    if (node.radiusTopRight != null) borders.borderTopRightRadius = node.radiusTopRight + 'px';
    if (node.radiusBottomRight != null) borders.borderBottomRightRadius = node.radiusBottomRight + 'px';
    if (node.radiusBottomLeft != null) borders.borderBottomLeftRadius = node.radiusBottomLeft + 'px';
    borders.borderRadiusMode = 'individual';
    hasValue = true;
  } else if (node.radius) {
    borders.borderRadius = node.radius + 'px';
    hasValue = true;
  }

  if (!hasValue) return undefined;

  borders.isActive = true;
  return borders;
}

function mapEffects(node: YcodeNode): EffectsDesign | undefined {
  const effects: EffectsDesign = {};
  let hasValue = false;

  if (node.boxShadow) {
    effects.boxShadow = node.boxShadow;
    hasValue = true;
  }

  if (node.blur) {
    effects.blur = node.blur + 'px';
    hasValue = true;
  }

  if (node.backdropBlur) {
    effects.backdropBlur = node.backdropBlur + 'px';
    hasValue = true;
  }

  if (node.opacity < 1) {
    effects.opacity = String(Math.round(node.opacity * 100) / 100);
    hasValue = true;
  }

  if (node.blendMode) {
    effects.mixBlendMode = node.blendMode;
    hasValue = true;
  }

  if (!hasValue) return undefined;

  effects.isActive = true;
  return effects;
}

function mapPositioning(node: YcodeNode): PositioningDesign | undefined {
  if (!node.position || node.position.type !== 'absolute') return undefined;
  const positioning: PositioningDesign = { isActive: true, position: 'absolute' };
  if (node.position.top != null) positioning.top = node.position.top + 'px';
  if (node.position.right != null) positioning.right = node.position.right + 'px';
  if (node.position.bottom != null) positioning.bottom = node.position.bottom + 'px';
  if (node.position.left != null) positioning.left = node.position.left + 'px';
  return positioning;
}

// ─── Semantic tag inference ──────────────────────────────────────────────────

function inferTag(node: YcodeNode): string | undefined {
  const hints = node.semantic;
  if (hints?.isLink) return 'a';
  if (node.__class === 'TextNode') {
    if (hints?.headingLevel && hints.headingLevel >= 1 && hints.headingLevel <= 6) {
      return `h${hints.headingLevel}`;
    }
    const level = headingLevelFromHtml(node.html);
    if (level) return `h${level}`;
    return 'p';
  }
  if (node.__class === 'FrameNode') {
    if (hints?.looksLikeButton) return undefined; // buttons stay div; link handled above
    const name = node.name.toLowerCase();
    if (/\b(section|hero|footer|header|nav)\b/.test(name)) {
      if (name.includes('nav')) return 'nav';
      if (name.includes('footer')) return 'footer';
      if (name.includes('header')) return 'header';
      return 'section';
    }
  }
  return undefined;
}

/** Rough heading inference from the largest font-size found in the node HTML. */
function headingLevelFromHtml(html?: string): number | null {
  if (!html) return null;
  let max = 0;
  const re = /font-size:\s*(\d+(?:\.\d+)?)px/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = parseFloat(m[1]);
    if (v > max) max = v;
  }
  if (max >= 40) return 1;
  if (max >= 32) return 2;
  if (max >= 26) return 3;
  if (max >= 22) return 4;
  if (max >= 19) return 5;
  return null;
}

// ─── Text / HTML Parsing ────────────────────────────────────────────────────

interface TipTapMark {
  type: string;
}

interface TipTapTextNode {
  type: 'text';
  text: string;
  marks?: TipTapMark[];
}

interface TipTapParagraph {
  type: 'paragraph';
  content?: TipTapTextNode[];
}

interface TipTapDoc {
  type: 'doc';
  content: TipTapParagraph[];
}

function parseInlineStyle(style: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (key && value) props[key] = value;
  }
  return props;
}

/** The inline style of the `<span>` that covers the most characters. */
function dominantSpanStyle(html: string): string | null {
  const re = /<span[^>]*style="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g;
  const lengthByStyle = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const style = m[1];
    const textLen = m[2].replace(/<[^>]+>/g, '').length;
    lengthByStyle.set(style, (lengthByStyle.get(style) || 0) + textLen);
  }
  let best: string | null = null;
  let bestLen = -1;
  for (const [style, len] of lengthByStyle.entries()) {
    if (len > bestLen) { bestLen = len; best = style; }
  }
  return best;
}

function parseHtmlToTypographyAndTipTap(
  html: string,
  availableFonts?: Set<string>,
): {
  typography: TypographyDesign;
  tiptapContent: TipTapDoc;
} {
  const typography: TypographyDesign = { isActive: true };

  // Use the style of the span covering the most characters, not just the first
  // one — otherwise a short differently-styled lead-in (e.g. a colored word)
  // would set the whole layer's font/colour incorrectly.
  const dominantStyle = dominantSpanStyle(html);
  if (dominantStyle) {
    const styles = parseInlineStyle(dominantStyle);

    if (styles['font-family']) {
      const family = styles['font-family'].replace(/['"]/g, '');
      // Only assign the font if it actually resolves to an installed/built-in
      // font. Otherwise leave it unset so the layer cleanly inherits the default
      // rather than carrying a font name that Ycode can't render.
      if (!availableFonts || availableFonts.has(family.toLowerCase())) {
        typography.fontFamily = family;
      }
    }
    if (styles['font-weight']) typography.fontWeight = styles['font-weight'];
    if (styles['font-size']) typography.fontSize = styles['font-size'];
    if (styles['line-height']) typography.lineHeight = styles['line-height'];
    if (styles['letter-spacing']) typography.letterSpacing = styles['letter-spacing'];
    if (styles['text-align']) typography.textAlign = styles['text-align'];
    if (styles['text-decoration']) typography.textDecoration = styles['text-decoration'];
    if (styles['text-transform']) typography.textTransform = styles['text-transform'];
    if (styles['color']) typography.color = styles['color'];
  }

  const pMatch = html.match(/<p[^>]*style="([^"]*)"[^>]*>/);
  if (pMatch) {
    const pStyles = parseInlineStyle(pMatch[1]);
    if (pStyles['line-height'] && !typography.lineHeight) typography.lineHeight = pStyles['line-height'];
    if (pStyles['font-size'] && !typography.fontSize) typography.fontSize = pStyles['font-size'];
    if (pStyles['text-align'] && !typography.textAlign) typography.textAlign = pStyles['text-align'];
  }

  const tiptapContent = htmlToTipTap(html);

  return { typography, tiptapContent };
}

function htmlToTipTap(html: string): TipTapDoc {
  const paragraphs: TipTapParagraph[] = [];

  const pBlocks = html.match(/<p[^>]*>([\s\S]*?)<\/p>/g);
  if (!pBlocks || pBlocks.length === 0) {
    const plainText = html.replace(/<[^>]+>/g, '').trim();
    if (plainText) {
      paragraphs.push({ type: 'paragraph', content: [{ type: 'text', text: plainText }] });
    } else {
      paragraphs.push({ type: 'paragraph' });
    }
    return { type: 'doc', content: paragraphs };
  }

  for (const pBlock of pBlocks) {
    const inner = pBlock.replace(/<\/?p[^>]*>/g, '');
    const textNodes = parseSpansToTextNodes(inner);
    paragraphs.push({
      type: 'paragraph',
      content: textNodes.length > 0 ? textNodes : undefined,
    });
  }

  return { type: 'doc', content: paragraphs };
}

function parseSpansToTextNodes(html: string): TipTapTextNode[] {
  const nodes: TipTapTextNode[] = [];
  const spanRegex = /<span[^>]*(?:style="([^"]*)")?[^>]*>([\s\S]*?)<\/span>/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = spanRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const between = html.slice(lastIndex, match.index).replace(/<[^>]+>/g, '');
      if (between) nodes.push({ type: 'text', text: between });
    }

    const styleStr = match[1] || '';
    const text = match[2].replace(/<[^>]+>/g, '');
    if (!text) { lastIndex = spanRegex.lastIndex; continue; }

    const marks: TipTapMark[] = [];
    const styles = parseInlineStyle(styleStr);
    const weight = parseInt(styles['font-weight'] || '400', 10);
    if (weight >= 700) marks.push({ type: 'bold' });
    if (styles['text-decoration']?.includes('underline')) marks.push({ type: 'underline' });
    if (styles['text-decoration']?.includes('line-through')) marks.push({ type: 'strike' });
    if (styles['font-style'] === 'italic') marks.push({ type: 'italic' });

    const node: TipTapTextNode = { type: 'text', text };
    if (marks.length > 0) node.marks = marks;
    nodes.push(node);
    lastIndex = spanRegex.lastIndex;
  }

  if (lastIndex < html.length) {
    const remaining = html.slice(lastIndex).replace(/<[^>]+>/g, '');
    if (remaining) nodes.push({ type: 'text', text: remaining });
  }

  return nodes;
}

function richTextValueFromHtml(html: string): DynamicRichTextVariable {
  const { tiptapContent } = parseHtmlToTypographyAndTipTap(html);
  return { type: 'dynamic_rich_text', data: { content: tiptapContent } } as DynamicRichTextVariable;
}

// ─── Token + style application ───────────────────────────────────────────────

async function applyBoundTokens(
  node: YcodeNode,
  design: DesignProperties,
  ctx: ConvertContext,
): Promise<void> {
  if (ctx.options.syncTokens === false) return;

  const fillRef = await resolveColorRef(ctx, node.boundVariables?.fillColor, node.fillStyleId);
  if (fillRef && design.backgrounds?.backgroundColor) {
    design.backgrounds.backgroundColor = fillRef;
  }

  const borderRef = await resolveColorRef(ctx, node.boundVariables?.borderColor, node.strokeStyleId);
  if (borderRef && design.borders?.borderColor) {
    design.borders.borderColor = borderRef;
  }

  if (node.boundVariables?.textColor && design.typography) {
    const ref = ctx.tokenRefs.get(node.boundVariables.textColor);
    if (ref) design.typography.color = ref;
  }
}

/**
 * Resolve a color reference from either a bound Figma variable (preferred) or a
 * Figma color style. Returns a `var(--id)` reference or null.
 */
async function resolveColorRef(
  ctx: ConvertContext,
  tokenId: string | undefined,
  styleId: string | undefined,
): Promise<string | null> {
  if (tokenId && ctx.tokenRefs.has(tokenId)) {
    return ctx.tokenRefs.get(tokenId) || null;
  }
  if (styleId && ctx.payload.styles) {
    const style = ctx.payload.styles[styleId];
    if (style && (style.type === 'fill' || style.type === 'stroke') && style.color) {
      const stored = cssColorToStored(style.color);
      if (stored) {
        return ctx.materializer.getOrCreateColorVariableRef(styleName(style), stored);
      }
    }
  }
  return null;
}

function styleName(style: FigmaStyleEntry): string {
  return style.name.replace(/\//g, ' / ').trim() || 'Figma color';
}

/** Apply a Figma text style to a text layer via a reusable Ycode layer style. */
async function applyTextStyle(
  node: YcodeNode,
  layer: Layer,
  design: DesignProperties,
  ctx: ConvertContext,
): Promise<boolean> {
  if (ctx.options.extractStyles === false) return false;
  if (!node.textStyleId || !ctx.payload.styles) return false;
  const style = ctx.payload.styles[node.textStyleId];
  if (!style || style.type !== 'text' || !style.typography) return false;

  const typography: TypographyDesign = { isActive: true, ...style.typography } as TypographyDesign;
  // Drop a font the editor can't render, same as the inline-style path, so the
  // shared layer style doesn't carry a dangling font-[...] class.
  if (
    typography.fontFamily &&
    ctx.availableFonts &&
    !ctx.availableFonts.has(typography.fontFamily.toLowerCase())
  ) {
    delete typography.fontFamily;
  }
  const styleDesign: DesignProperties = { typography };
  const classes = designToClassString(styleDesign);

  const created = await ctx.materializer.getOrCreateLayerStyle(
    `text:${node.textStyleId}`,
    styleName(style),
    classes,
    styleDesign,
    'text',
  );
  if (!created) return false;

  layer.styleId = created.id;
  layer.styleIds = [created.id];
  // Figma text styles carry typography (font/size/weight/line-height) but never
  // a fill colour — colour lives on the layer's fill. Preserve the node's own
  // colour as a local override so applying the style doesn't strip it. Clone so
  // we don't mutate the (colour-less) typography stored on the shared style.
  const nodeColor = design.typography?.color;
  design.typography = { ...typography };
  if (nodeColor && !design.typography.color) design.typography.color = nodeColor;
  return true;
}

// ─── Component generation (Phase 2) ──────────────────────────────────────────

interface LeafPath {
  path: number[];
  kind: 'text' | 'image';
}

/**
 * Structural shape of a node: class + child-count tree, ignoring names and
 * text content (which vary across instances). Instances of the same Figma
 * component share this signature even when their main component is a remote
 * library component we cannot access.
 */
function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function shapeSignature(node: YcodeNode): string {
  const children = node.children || [];
  const childSigs = children.map(shapeSignature).join(',');
  // Fold SVG content into the signature: icons are baked into the component
  // body (not parameterized), so two structurally-identical icons with
  // different glyphs must NOT collapse into one shared component. Image content
  // is deliberately excluded — images become per-instance variables instead.
  const leaf = node.__class === 'SvgNode' && node.svgData ? `#${hashString(node.svgData)}` : '';
  return `${node.__class}:${children.length}${leaf}(${childSigs})`;
}

interface InstanceGroup {
  nodes: YcodeNode[];
  depth: number; // deepest occurrence, so nested components build before their containers
}

/**
 * Collect every component instance at all nesting levels, grouped by shape.
 * Unlike a flat collection, this descends *into* instances so nested instances
 * (e.g. an Author inside a Testimonial) are discovered and grouped too.
 */
function collectAllInstanceGroups(
  nodes: YcodeNode[],
  depth: number,
  groups: Map<string, InstanceGroup>,
): void {
  for (const node of nodes) {
    if (node.isInstance) {
      const key = shapeSignature(node);
      const entry = groups.get(key) || { nodes: [], depth };
      entry.nodes.push(node);
      entry.depth = Math.max(entry.depth, depth);
      groups.set(key, entry);
    }
    if (node.children?.length) collectAllInstanceGroups(node.children, depth + 1, groups);
  }
}

function isBuiltInstance(node: YcodeNode, ctx: ConvertContext): boolean {
  return !!node.isInstance && ctx.components.has(shapeSignature(node));
}

/** Leaf paths owned by this node, stopping at nested built-component boundaries. */
function collectOwnLeafPaths(node: YcodeNode, ctx: ConvertContext, prefix: number[] = []): LeafPath[] {
  const out: LeafPath[] = [];
  (node.children || []).forEach((child, i) => {
    const path = [...prefix, i];
    if (isBuiltInstance(child, ctx)) return; // belongs to the nested component
    if (child.__class === 'TextNode' && child.html) out.push({ path, kind: 'text' });
    else if (child.__class === 'ImageNode' && child.imageData) out.push({ path, kind: 'image' });
    if (child.children?.length) out.push(...collectOwnLeafPaths(child, ctx, path));
  });
  return out;
}

interface NestedInstance {
  path: number[];
  node: YcodeNode;
  built: ComponentBuildResult;
}

/** Descendant instances that have a built component, not descending into them. */
function collectNestedInstancePaths(node: YcodeNode, ctx: ConvertContext, prefix: number[] = []): NestedInstance[] {
  const out: NestedInstance[] = [];
  (node.children || []).forEach((child, i) => {
    const path = [...prefix, i];
    if (isBuiltInstance(child, ctx)) {
      out.push({ path, node: child, built: ctx.components.get(shapeSignature(child))! });
      return;
    }
    if (child.children?.length) out.push(...collectNestedInstancePaths(child, ctx, path));
  });
  return out;
}

function nodeAtPath(node: YcodeNode, path: number[]): YcodeNode | null {
  let current: YcodeNode | undefined = node;
  for (const idx of path) {
    current = current?.children?.[idx];
    if (!current) return null;
  }
  return current || null;
}

function layerAtPath(layer: Layer, path: number[]): Layer | null {
  let current: Layer | undefined = layer;
  for (const idx of path) {
    current = current?.children?.[idx];
    if (!current) return null;
  }
  return current || null;
}

function leafValue(node: YcodeNode | null, kind: 'text' | 'image'): string {
  if (!node) return '';
  return kind === 'text' ? (node.html || '') : (node.imageData || node.name || '');
}

function deriveVariableName(node: YcodeNode | null, kind: 'text' | 'image'): string {
  if (node?.name) return sanitizeCustomName(node.name);
  return kind === 'text' ? 'Text' : 'Image';
}

interface PassThrough {
  outerPath: number[]; // path of the nested instance in the outer template
  childVarId: string; // variable id inside the nested component
  parentVarId: string; // new variable id on the outer component
  kind: 'text' | 'image';
  valuePath: number[]; // full path (outer root -> leaf) used to read each instance's value
}

async function imageSettingsFromNode(node: YcodeNode | null): Promise<ComponentVariableValue> {
  const name = node?.name || '';
  const assetId = node?.imageData ? await uploadFigmaImage(node.imageData, imageFilename(node)) : null;
  const src = assetId
    ? { type: 'asset', data: { asset_id: assetId } }
    : { type: 'dynamic_text', data: { content: node?.imageData || '' } };
  return { src, alt: { type: 'dynamic_text', data: { content: name } } } as unknown as ComponentVariableValue;
}

async function buildComponentForGroup(
  figmaId: string,
  group: YcodeNode[],
  parentFlexDir: string | null,
  ctx: ConvertContext,
): Promise<ComponentBuildResult | null> {
  const template = group[0];
  const componentName = sanitizeCustomName(template.name) || 'Component';

  // Own varying leaves (excluding regions owned by nested components).
  const varyingOwn = collectOwnLeafPaths(template, ctx)
    .filter((leaf) => {
      const values = group.map((inst) => leafValue(nodeAtPath(inst, leaf.path), leaf.kind));
      return !values.every((v) => v === values[0]);
    })
    .map((leaf) => ({ leaf, variableId: generateId('cmpvr') }));

  // Pass-through: nested-component variables whose value varies across the
  // group are exposed as outer-component variables and linked via variableLinks.
  const nested = collectNestedInstancePaths(template, ctx);
  const passThroughs: PassThrough[] = [];
  for (const ni of nested) {
    for (const binding of ni.built.variableMap.values()) {
      const valuePath = [...ni.path, ...binding.path];
      const values = group.map((inst) => leafValue(nodeAtPath(inst, valuePath), binding.kind));
      if (!values.every((v) => v === values[0])) {
        passThroughs.push({
          outerPath: ni.path,
          childVarId: binding.id,
          parentVarId: generateId('cmpvr'),
          kind: binding.kind,
          valuePath,
        });
      }
    }
  }

  const variableMap = new Map<string, ComponentVarBinding>();
  const variables: ComponentVariable[] = [];

  const result = await ctx.materializer.createComponentOnce(figmaId, componentName, async () => {
    // inlineThisInstance=true: build the instance's own tree as the component
    // body; descendant instances still resolve to nested component references.
    const rootLayer = await convertNode(template, ctx, parentFlexDir, false, true);

    // A component's absolute placement belongs to each instance, not the
    // component itself. If the template was absolutely positioned, baking that
    // onto the root would stack every instance at the template's coordinates,
    // so strip it (relative — used as a positioning context — is kept).
    if (rootLayer.design?.positioning?.position === 'absolute') {
      delete rootLayer.design.positioning;
      rootLayer.classes = classesText(rootLayer.classes)
        .split(/\s+/)
        .filter((c) => c && c !== 'absolute' && !/^(top|left|right|bottom|inset)-/.test(c))
        .join(' ');
    }

    for (const { leaf, variableId } of varyingOwn) {
      const node = nodeAtPath(template, leaf.path);
      const targetLayer = layerAtPath(rootLayer, leaf.path);
      if (!node || !targetLayer) continue;

      if (leaf.kind === 'text') {
        const value = richTextValueFromHtml(node.html || '');
        variables.push({
          id: variableId,
          name: deriveVariableName(node, 'text'),
          type: 'rich_text',
          default_value: value as ComponentVariableValue,
        });
        targetLayer.variables = {
          ...targetLayer.variables,
          text: { id: variableId, type: 'dynamic_rich_text', data: (value as DynamicRichTextVariable).data },
        };
      } else {
        const existing = targetLayer.variables?.image;
        const baseSrc = existing?.src || { type: 'dynamic_text', data: { content: node.imageData || '' } };
        const alt = existing?.alt || { type: 'dynamic_text', data: { content: node.name } };
        const linkedSrc = { ...(baseSrc as object), id: variableId } as typeof baseSrc;
        targetLayer.variables = {
          ...targetLayer.variables,
          image: { src: linkedSrc, alt } as NonNullable<Layer['variables']>['image'],
        };
        variables.push({
          id: variableId,
          name: deriveVariableName(node, 'image'),
          type: 'image',
          default_value: { src: baseSrc, alt } as unknown as ComponentVariableValue,
        });
      }
      variableMap.set(variableId, { id: variableId, kind: leaf.kind, path: leaf.path });
    }

    for (const pt of passThroughs) {
      const tmplNode = nodeAtPath(template, pt.valuePath);
      if (pt.kind === 'text') {
        const value = richTextValueFromHtml(tmplNode?.html || '');
        variables.push({
          id: pt.parentVarId,
          name: deriveVariableName(tmplNode, 'text'),
          type: 'rich_text',
          default_value: value as ComponentVariableValue,
        });
      } else {
        variables.push({
          id: pt.parentVarId,
          name: deriveVariableName(tmplNode, 'image'),
          type: 'image',
          default_value: await imageSettingsFromNode(tmplNode),
        });
      }
      variableMap.set(pt.parentVarId, { id: pt.parentVarId, kind: pt.kind, path: pt.valuePath });

      // Link the nested instance's variable to this outer variable.
      const nestedLayer = layerAtPath(rootLayer, pt.outerPath);
      if (nestedLayer) {
        const ov = nestedLayer.componentOverrides || {};
        ov.variableLinks = ov.variableLinks || {};
        ov.variableLinks[pt.childVarId] = pt.parentVarId;
        nestedLayer.componentOverrides = ov;
      }
    }

    return [rootLayer];
  });

  if (!result) return null;

  const variantId = result.variants?.[0]?.id || generateId('cmpvar');
  if (variables.length) {
    // The store create call does not accept variables; attach them in a
    // follow-up update so each instance can override them (keeps store in sync).
    await useComponentsStore.getState().updateComponent(result.id, { variables } as never);
  }

  return { componentId: result.id, variantId, variableMap };
}

function imageFilename(node: YcodeNode): string {
  return `${node.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
}

async function buildInstanceLayer(
  node: YcodeNode,
  built: ComponentBuildResult,
): Promise<Layer> {
  const overrides: NonNullable<Layer['componentOverrides']> = {};

  for (const info of built.variableMap.values()) {
    const leafNode = nodeAtPath(node, info.path);
    if (!leafNode) continue;

    if (info.kind === 'text' && leafNode.html) {
      overrides.rich_text = overrides.rich_text || {};
      overrides.rich_text[info.id] = richTextValueFromHtml(leafNode.html) as ComponentVariableValue;
    } else if (info.kind === 'image') {
      const assetId = leafNode.imageData ? await uploadFigmaImage(leafNode.imageData, imageFilename(leafNode)) : null;
      const imgVal = assetId
        ? { src: { type: 'asset', data: { asset_id: assetId } }, alt: { type: 'dynamic_text', data: { content: leafNode.name } } }
        : { src: { type: 'dynamic_text', data: { content: leafNode.imageData || '' } }, alt: { type: 'dynamic_text', data: { content: leafNode.name } } };
      overrides.image = overrides.image || {};
      overrides.image[info.id] = imgVal as unknown as ComponentVariableValue;
    }
  }

  const layer: Layer = {
    id: generateId('lyr'),
    name: getLayerName(node),
    customName: sanitizeCustomName(node.name),
    classes: '',
    componentId: built.componentId,
    componentVariantId: built.variantId,
  };
  if (Object.keys(overrides).length > 0) layer.componentOverrides = overrides;
  if (!node.visible) layer.settings = { ...layer.settings, hidden: true };
  return layer;
}

// ─── Node Conversion ────────────────────────────────────────────────────────

/** Minimal placeholder so one unconvertible node can't abort the whole paste. */
function fallbackLayer(node: YcodeNode): Layer {
  return {
    id: generateId('lyr'),
    name: getLayerName(node),
    customName: sanitizeCustomName(node.name),
    classes: '',
  };
}

/**
 * Convert a node, isolating failures: a single bad node degrades to an empty
 * placeholder (and logs which node failed) instead of failing the entire
 * import. This keeps the layer tree shape (one layer per node) intact so
 * component path lookups still line up.
 */
async function convertNodeSafe(
  node: YcodeNode,
  ctx: ConvertContext,
  parentFlexDir?: string | null,
  isRoot = false,
  inlineThisInstance = false,
): Promise<Layer> {
  try {
    return await convertNode(node, ctx, parentFlexDir, isRoot, inlineThisInstance);
  } catch (err) {
    console.warn(
      '[FigmaPaste] failed to convert node',
      `"${node.name}"`,
      `(${node.__class} ${node.id})`,
      err,
    );
    return fallbackLayer(node);
  }
}

async function convertNode(
  node: YcodeNode,
  ctx: ConvertContext,
  parentFlexDir?: string | null,
  isRoot = false,
  inlineThisInstance = false,
): Promise<Layer> {
  // Component instance: emit a reference instead of inlining the tree. The
  // `inlineThisInstance` flag is set only for a component's own root (so we
  // don't recurse into the component we're currently building); descendant
  // instances still resolve to nested component references.
  if (!inlineThisInstance && node.isInstance) {
    const built = ctx.components.get(shapeSignature(node));
    if (built) {
      return buildInstanceLayer(node, built);
    }
  }

  const id = generateId('lyr');
  const design: DesignProperties = {};

  const layout = mapLayout(node);
  if (layout) design.layout = layout;

  const spacing = mapSpacing(node);
  if (spacing) design.spacing = spacing;

  const lineSeparator = asLineSeparator(node);

  const { sizing, extraClasses } = mapSizing(node, parentFlexDir);
  if (isRoot) {
    sizing.width = '100%';
    sizing.height = 'fit-content';
  }
  if (lineSeparator) {
    // Collapse the divider to a 1px line on its thin axis; keep the long axis
    // (fill/length) from mapSizing so it spans its container.
    if (lineSeparator.vertical) sizing.width = lineSeparator.thickness;
    else sizing.height = lineSeparator.thickness;
  }
  design.sizing = sizing;

  // Vector/SVG nodes already encode their fill and stroke inside the exported
  // SVG path. Re-applying them as a CSS background/border would draw a box
  // around the icon (the stroke becomes an outline rectangle), which doesn't
  // exist in Figma — so skip them for SVG layers.
  const isSvg = node.__class === 'SvgNode';

  let backgrounds = isSvg ? undefined : mapBackgrounds(node);
  if (backgrounds) design.backgrounds = backgrounds;

  const borders = isSvg ? undefined : mapBorders(node);
  if (borders) design.borders = borders;

  // A line separator renders as a solid divider, so paint the stroke colour as
  // the background. Prefer a bound token, then a stroke style, then the raw hex.
  if (lineSeparator) {
    const colorRef = await resolveColorRef(ctx, node.boundVariables?.borderColor, node.strokeStyleId);
    const dividerColor = colorRef || node.borderColor;
    if (dividerColor) {
      backgrounds = { isActive: true, backgroundColor: dividerColor };
      design.backgrounds = backgrounds;
    }
  }

  const effects = mapEffects(node);
  if (effects) design.effects = effects;

  const positioning = mapPositioning(node);
  if (positioning) design.positioning = positioning;

  // A line separator bakes its rotation into the divider orientation, so don't
  // also emit a visual rotate() (which wouldn't affect layout and would spin
  // the divider out of place).
  if (node.rotation && !lineSeparator) {
    design.transforms = {
      isActive: true,
      rotate: `${node.rotation}deg`,
    };
  }

  if (node.aspectRatio) {
    const s = design.sizing || { isActive: true };
    s.aspectRatio = `[${node.aspectRatio}]`;
    s.isActive = true;
    design.sizing = s;
  }

  const layerName = lineSeparator ? 'div' : getLayerName(node);
  const layer: Layer = {
    id,
    name: layerName,
    customName: sanitizeCustomName(node.name),
    classes: '',
    design,
  };

  // Semantic HTML tag
  const tag = inferTag(node);
  if (tag) layer.settings = { ...layer.settings, tag };

  if (node.__class === 'TextNode' && node.html) {
    const { typography, tiptapContent } = parseHtmlToTypographyAndTipTap(node.html, ctx.availableFonts);
    if (node.lineClamp) {
      typography.lineClamp = String(node.lineClamp);
    }
    design.typography = typography;

    // Prefer a reusable layer style when the text uses a Figma text style.
    await applyTextStyle(node, layer, design, ctx);

    if (node.textVerticalAlignment === 'center') {
      const l = design.layout || { isActive: true };
      l.display = 'Flex';
      l.alignItems = 'center';
      l.isActive = true;
      design.layout = l;
    } else if (node.textVerticalAlignment === 'bottom') {
      const l = design.layout || { isActive: true };
      l.display = 'Flex';
      l.alignItems = 'flex-end';
      l.isActive = true;
      design.layout = l;
    }

    layer.variables = {
      text: {
        type: 'dynamic_rich_text',
        data: { content: tiptapContent },
      },
    };
    layer.restrictions = { editText: true };
  }

  if (node.__class === 'ImageNode' && node.imageData) {
    const filename = imageFilename(node);
    const assetId = await uploadFigmaImage(node.imageData, filename);
    if (assetId) {
      layer.variables = {
        ...layer.variables,
        image: {
          src: { type: 'asset', data: { asset_id: assetId } },
          alt: { type: 'dynamic_text', data: { content: node.name } },
        },
      };
    } else {
      layer.variables = {
        ...layer.variables,
        image: {
          src: { type: 'dynamic_text', data: { content: node.imageData } },
          alt: { type: 'dynamic_text', data: { content: node.name } },
        },
      };
    }
  }

  if (node.__class === 'SvgNode' && node.svgData && !lineSeparator) {
    layer.variables = {
      ...layer.variables,
      icon: {
        src: { type: 'static_text', data: { content: node.svgData } },
      },
    };
  }

  if (node.__class === 'FrameNode' && node.fillType === 'image' && node.imageData) {
    const filename = `${node.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_bg.png`;
    const assetId = await uploadFigmaImage(node.imageData, filename);
    if (!backgrounds) {
      backgrounds = { isActive: true };
      design.backgrounds = backgrounds;
    }
    backgrounds.backgroundImage = '--bg-img';
    backgrounds.backgroundSize = 'cover';
    backgrounds.backgroundPosition = 'center';
    backgrounds.backgroundRepeat = 'no-repeat';
    if (assetId) {
      layer.variables = {
        ...layer.variables,
        backgroundImage: {
          src: { type: 'asset', data: { asset_id: assetId } },
        },
      };
    } else {
      backgrounds.bgImageVars = { '--bg-img': `url(${node.imageData})` };
    }
  }

  // Rewrite bound colors to design tokens after design is assembled.
  await applyBoundTokens(node, design, ctx);

  if (node.children?.length) {
    const thisFlexDir = node.flexDirection || null;
    const childLayers = await Promise.all(
      node.children.map((child) => convertNodeSafe(child, ctx, thisFlexDir)),
    );
    layer.children = childLayers;
  }

  if (node.overflowX) extraClasses.push(`overflow-x-${node.overflowX}`);
  if (node.overflowY) extraClasses.push(`overflow-y-${node.overflowY}`);

  // If any child is absolutely positioned, anchor it by making this a
  // positioning context (unless this node is itself absolutely positioned).
  if (node.children?.some((c) => c.position?.type === 'absolute')) {
    if (!design.positioning) {
      design.positioning = { isActive: true, position: 'relative' };
    }
    // Absolutely-positioned children contribute no flow height, so a container
    // sized to its content (fit-content — e.g. the forced root, or a hug frame)
    // would collapse and clip them. Keep the frame's own height as a floor so
    // the absolute canvas survives while still allowing content to grow.
    const s = design.sizing;
    if (s && (s.height == null || s.height === 'fit-content') && node.height) {
      s.minHeight = Math.round(node.height) + 'px';
      s.isActive = true;
    }
  }

  // Reliable responsive overrides from a designer-driven multi-frame merge.
  const responsive = ctx.responsiveClasses.get(node);
  if (responsive?.length) extraClasses.push(...responsive);

  // Optional (off by default) aggressive heuristic: stack wide rows on mobile.
  if (
    ctx.options.aggressiveResponsive &&
    node.display === 'flex' &&
    node.flexDirection === 'row' &&
    (node.children?.length || 0) >= 2
  ) {
    extraClasses.push('max-md:flex-col');
  }

  layer.classes = designToClassString(design);
  if (extraClasses.length > 0) {
    layer.classes = layer.classes + ' ' + extraClasses.join(' ');
  }

  if (!node.visible) {
    layer.settings = { ...layer.settings, hidden: true };
  }

  return layer;
}

// ─── Structural layer-style dedup (Phase 1) ──────────────────────────────────

function classesText(classes: string | string[] | undefined): string {
  if (Array.isArray(classes)) return classes.join(' ');
  return classes || '';
}

function styleSignature(layer: Layer): string | null {
  if (layer.componentId) return null; // instances have no own styling
  if (getStyleIds(layer).length > 0) return null; // already styled
  const classes = classesText(layer.classes).trim();
  if (!classes) return null;
  // Exclude layout-positioning-only one-offs from dedup noise.
  return classes;
}

function collectSignatures(layers: Layer[], counts: Map<string, number>): void {
  for (const layer of layers) {
    const sig = styleSignature(layer);
    if (sig) counts.set(sig, (counts.get(sig) || 0) + 1);
    if (layer.children?.length) collectSignatures(layer.children, counts);
  }
}

/**
 * Human-friendly base label for a synthesized layer style. Derived from the
 * layer's semantic role/type — never the Figma layer name, which for text is
 * the text content itself (e.g. a whole quote) and makes terrible style names.
 */
function dedupStyleBase(layer: Layer): string {
  const tag = layer.settings?.tag;
  if (tag && /^h[1-6]$/.test(tag)) return 'Heading';
  if (tag === 'a') return 'Link';
  if (tag === 'nav') return 'Nav';
  if (tag === 'footer') return 'Footer';
  if (tag === 'header') return 'Header';
  if (tag === 'section') return 'Section';
  if (layer.name === 'text' || tag === 'p') return 'Text';
  if (layer.name === 'image') return 'Image';
  if (layer.name === 'icon') return 'Icon';
  return 'Block';
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function convertFigmaToLayers(
  payload: YcodeFigmaPayload,
  materializer: FigmaMaterializer,
  availableFonts?: Set<string>,
): Promise<Layer[]> {
  const options: YcodeImportOptions = payload.options || {};

  const ctx: ConvertContext = {
    payload,
    materializer,
    options,
    tokenRefs: new Map(),
    components: new Map(),
    responsiveClasses: new Map(),
    availableFonts,
  };

  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const countNodes = (nodes: YcodeNode[]): number =>
    nodes.reduce((n, node) => n + 1 + (node.children ? countNodes(node.children) : 0), 0);
  figmaDebug('starting import', {
    topLevel: payload.nodes.length,
    totalNodes: countNodes(payload.nodes),
    options,
  });

  // 0. Plan responsive: merge matched breakpoint frames into base frames.
  let baseNodes = payload.nodes;
  if (options.responsive !== false) {
    const plan = planResponsive(payload.nodes);
    baseNodes = plan.baseNodes;
    ctx.responsiveClasses = plan.responsiveClasses;
  }

  // 1. Materialize color tokens up front.
  if (options.syncTokens !== false && payload.tokens) {
    for (const [tokenId, token] of Object.entries(payload.tokens)) {
      const ref = await materializer.getOrCreateColorVariableRef(token.name, token.value);
      if (ref) ctx.tokenRefs.set(tokenId, ref);
    }
  }

  // 2. Build components from instances at every nesting level. Build deepest
  // first so nested components (e.g. Author) exist before their containers
  // (e.g. Testimonial) reference them.
  if (options.createComponents !== false) {
    const groups = new Map<string, InstanceGroup>();
    collectAllInstanceGroups(baseNodes, 0, groups);
    figmaDebug(
      'instance groups',
      Array.from(groups.values()).map((g) => `${g.nodes[0]?.name} x${g.nodes.length}`),
    );
    const ordered = Array.from(groups.entries()).sort((a, b) => b[1].depth - a[1].depth);
    for (const [sig, group] of ordered) {
      if (group.nodes.length < COMPONENTIZE_MIN_INSTANCES) continue;
      const built = await buildComponentForGroup(sig, group.nodes, null, ctx);
      if (built) ctx.components.set(sig, built);
    }
    figmaDebug('components built', ctx.components.size);
  }

  // 3. Convert the top-level node trees.
  const layers = await Promise.all(
    baseNodes.map((node) => convertNodeSafe(node, ctx, null, true)),
  );
  figmaDebug('converted top-level layers', layers.length);

  // 4. Structural style dedup pass.
  if (options.extractStyles !== false) {
    const counts = new Map<string, number>();
    collectSignatures(layers, counts);
    const eligible = new Map<string, string>();
    // Pre-seed eligible signatures (>= threshold) so applyDedupStyles only
    // creates styles for genuinely repeated structures.
    for (const [sig, count] of counts.entries()) {
      if (count >= DEDUP_THRESHOLD) eligible.set(sig, '');
    }
    if (eligible.size > 0) {
      await applyDedupStylesEligible(layers, eligible, ctx);
    }
  }

  if (t0) {
    figmaDebug('import finished', {
      ms: Math.round(performance.now() - t0),
      summary: materializer.summary,
    });
  }

  return layers;
}

async function applyDedupStylesEligible(
  layers: Layer[],
  eligible: Map<string, string>,
  ctx: ConvertContext,
): Promise<void> {
  const baseCounts = new Map<string, number>();
  const create = async (layer: Layer) => {
    const sig = styleSignature(layer);
    if (sig && eligible.has(sig)) {
      let styleId = eligible.get(sig);
      if (!styleId) {
        const base = dedupStyleBase(layer);
        const n = (baseCounts.get(base) || 0) + 1;
        baseCounts.set(base, n);
        const group = layer.name === 'text' ? 'text' : 'block';
        const created = await ctx.materializer.getOrCreateLayerStyle(
          `dedup:${sig}`,
          `Figma / ${base} ${n}`,
          classesText(layer.classes),
          layer.design,
          group,
        );
        styleId = created?.id || '';
        eligible.set(sig, styleId);
      }
      if (styleId) {
        layer.styleId = styleId;
        layer.styleIds = [styleId];
      }
    }
    if (layer.children?.length) {
      for (const child of layer.children) await create(child);
    }
  };
  for (const layer of layers) await create(layer);
}

export function extractFontFamilies(payload: YcodeFigmaPayload): string[] {
  const families = new Set<string>();

  function walk(node: YcodeNode) {
    if (node.html) {
      const regex = /font-family:\s*'([^']+)'/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(node.html)) !== null) {
        families.add(m[1]);
      }
    }
    node.children?.forEach(walk);
  }

  payload.nodes.forEach(walk);

  // Text styles carry their own fontFamily that may not appear in any node's
  // inline HTML — include them so they get installed/reported too.
  if (payload.styles) {
    for (const style of Object.values(payload.styles)) {
      const family = style?.typography?.fontFamily;
      if (family) families.add(family);
    }
  }

  return Array.from(families);
}
