export const YCODE_FIGMA_SIGNATURE = '__ycode_figma__';

export type YcodeNodeClass = 'FrameNode' | 'TextNode' | 'ImageNode' | 'SvgNode';

/**
 * Absolute positioning for children that live inside a non-auto-layout parent.
 * Offsets are in px relative to the parent's top-left.
 */
export interface YcodeNodePosition {
  type: 'absolute';
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/**
 * Semantic hints emitted by the plugin. The converter decides the final HTML
 * tag (`settings.tag`) using these hints plus heuristics.
 */
export interface YcodeSemanticHints {
  isLink?: boolean;
  linkUrl?: string;
  looksLikeButton?: boolean;
  headingLevel?: number; // 1-6 when inferable from a text style name / hierarchy
}

/**
 * Maps a node design property to a token id in `payload.tokens`. The converter
 * replaces the literal value with `var(--<colorVariableId>)` after the token is
 * materialized.
 */
export interface YcodeBoundVariables {
  fillColor?: string; // token id
  borderColor?: string; // token id
  textColor?: string; // token id
}

export type YcodeOverrideValue =
  | { type: 'text'; value: string }
  | { type: 'richText'; html: string }
  | { type: 'image'; imageData: string }
  | { type: 'variant'; variantId: string }
  | { type: 'boolean'; value: boolean };

/** Reference to a component instance (Phase 2). */
export interface YcodeComponentInstanceRef {
  componentId: string; // -> payload.components[id]
  variantId?: string;
  overrides?: Record<string, YcodeOverrideValue>; // propertyKey -> value
}

export interface YcodeNode {
  __class: YcodeNodeClass;
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  width: number;
  height: number;
  widthType: 'fixed' | 'fill' | 'hug';
  heightType: 'fixed' | 'fill' | 'hug';
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  aspectRatio?: number | null;
  rotation?: number;
  opacity: number;
  fillEnabled: boolean;
  fillType: 'color' | 'gradient' | 'image' | 'none';
  fillColor?: string;
  fillGradient?: string;
  borderEnabled: boolean;
  borderWidth: number;
  borderColor?: string;
  borderStyle: string;
  borderPerSide: boolean;
  borderTop?: number;
  borderRight?: number;
  borderBottom?: number;
  borderLeft?: number;
  borderAlign?: string; // INSIDE | OUTSIDE | CENTER (Figma strokeAlign)
  radius: number;
  radiusPerCorner: boolean;
  radiusValue?: string;
  radiusTopLeft?: number;
  radiusTopRight?: number;
  radiusBottomRight?: number;
  radiusBottomLeft?: number;
  boxShadow?: string;
  blur?: number;
  backdropBlur?: number;
  blendMode?: string;
  overflow: 'visible' | 'hidden' | 'auto' | 'scroll';
  overflowX?: 'auto' | 'scroll';
  overflowY?: 'auto' | 'scroll';
  display?: 'flex' | 'grid' | 'block';
  flexDirection?: 'row' | 'column';
  flexWrap?: 'nowrap' | 'wrap';
  justifyContent?: string;
  alignItems?: string;
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  textVerticalAlignment?: 'top' | 'center' | 'bottom';
  lineClamp?: number;
  html?: string;
  imageData?: string;
  svgData?: string;
  children?: YcodeNode[];

  // ─── v3 additions ─────────────────────────────────────────────────────────
  // Phase 1: structure & semantics
  position?: YcodeNodePosition;
  semantic?: YcodeSemanticHints;
  // Phase 2: components
  isInstance?: boolean; // node was a Figma component instance
  instanceOf?: YcodeComponentInstanceRef;
  // Phase 3: styles & tokens
  textStyleId?: string; // -> payload.styles
  fillStyleId?: string; // -> payload.styles
  effectStyleId?: string; // -> payload.styles
  strokeStyleId?: string; // -> payload.styles
  boundVariables?: YcodeBoundVariables;
}

// ─── Payload-level design-system tables (v3) ──────────────────────────────────

export type FigmaStyleType = 'text' | 'fill' | 'effect' | 'stroke';

export interface FigmaStyleEntry {
  id: string;
  name: string;
  type: FigmaStyleType;
  /** Text styles: CSS-ish typography map (font-family, font-size, ...). */
  typography?: Record<string, string>;
  /** Fill / stroke styles: resolved CSS color. */
  color?: string;
  /** Effect styles: resolved CSS box-shadow. */
  boxShadow?: string;
}

export interface FigmaTokenEntry {
  id: string;
  name: string; // Figma variable name (e.g. "Brand/Primary")
  /** Value in Ycode color-variable stored format: `#hex` or `#hex/opacity`. */
  value: string;
}

export type FigmaComponentPropertyType = 'TEXT' | 'BOOLEAN' | 'INSTANCE_SWAP' | 'VARIANT';

export interface FigmaComponentPropertyEntry {
  key: string;
  name: string;
  type: FigmaComponentPropertyType;
}

export interface FigmaComponentVariantEntry {
  id: string;
  name: string;
  nodes: YcodeNode[];
}

export interface FigmaComponentEntry {
  id: string;
  name: string;
  variants: FigmaComponentVariantEntry[];
  properties: FigmaComponentPropertyEntry[];
}

export interface YcodeImportOptions {
  createComponents?: boolean;
  extractStyles?: boolean;
  syncTokens?: boolean;
  responsive?: boolean;
  aggressiveResponsive?: boolean;
}

export const YCODE_FIGMA_VERSION = 3;

export interface YcodeFigmaPayload {
  signature: typeof YCODE_FIGMA_SIGNATURE;
  version: typeof YCODE_FIGMA_VERSION;
  source: 'figma-plugin';
  nodes: YcodeNode[];
  styles?: Record<string, FigmaStyleEntry>;
  tokens?: Record<string, FigmaTokenEntry>;
  components?: Record<string, FigmaComponentEntry>;
  options?: YcodeImportOptions;
}

export function isYcodeFigmaPayload(data: unknown): data is YcodeFigmaPayload {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.signature === YCODE_FIGMA_SIGNATURE &&
    obj.version === YCODE_FIGMA_VERSION &&
    obj.source === 'figma-plugin' &&
    Array.isArray(obj.nodes)
  );
}
