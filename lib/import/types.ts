/**
 * Source-neutral import intermediate representation (IR).
 *
 * Both the Webflow (XSCP clipboard) and Figma adapters map their native data
 * into this shape, then the shared core (`convert.ts` + `materializer.ts`)
 * turns it into real Ycode layers, layer styles, components, assets and fonts.
 *
 * Keeping the IR free of any source-specific concepts is what lets the two
 * importers share one pipeline (DRY).
 */

/** The kind of node, which determines the Ycode layer that gets produced. */
export type ImportNodeKind =
  | 'box' // generic container (div / section / nav / list item / …)
  | 'text' // text element or text leaf
  | 'heading' // h1–h6
  | 'image'
  | 'icon' // inline SVG / embed
  | 'link' // anchor-style container that carries link settings
  | 'collection'; // collection-list placeholder (CMS re-link required)

/**
 * A reusable style reference resolved by an adapter.
 *
 * `key` is a stable identity (e.g. the Webflow class id) so the materializer
 * can dedupe and create a single shared `LayerStyle` per source class, even
 * when it appears on hundreds of nodes.
 */
export interface ImportStyleRef {
  /** Stable dedupe key (e.g. Webflow class `_id`). */
  key: string;
  /** Human-readable style name (becomes the `LayerStyle` name). */
  name: string;
  /** Fully-resolved Tailwind classes, including responsive/state prefixes. */
  classes: string[];
  /** True for combo / modifier classes that stack on top of a base class. */
  combo?: boolean;
}

export interface ImportImage {
  /** Absolute URL of the image (kept as-is unless re-hosted). */
  src?: string;
  alt?: string;
  /** Optional pre-uploaded Ycode asset id (when re-hosting succeeded). */
  assetId?: string;
  width?: string;
  height?: string;
}

export interface ImportLink {
  href?: string;
  target?: string;
  rel?: string;
}

/**
 * A single node in the neutral import tree.
 */
export interface ImportNode {
  kind: ImportNodeKind;
  /** Semantic HTML tag to preserve (e.g. `section`, `nav`, `h2`). */
  tag?: string;
  /** Reusable style references — base class first, combo classes after. */
  styles?: ImportStyleRef[];
  /**
   * Named global styles applied *beneath* the element's own classes, in order
   * (lowest priority first). These come from the site stylesheet's tag rules
   * (`h2`, `a`, `p`, …) and the document `body` style — global styling that
   * isn't a per-element class. Each becomes its own reusable `LayerStyle` at the
   * bottom of the layer's style stack, mirroring how Webflow's tag/global styles
   * sit under combo classes.
   */
  underlayStyles?: ImportStyleRef[];
  /** Extra one-off classes not tied to a reusable style (highest priority). */
  classes?: string[];
  /**
   * Lowest-priority anonymous layout shims (e.g. a Webflow widget's built-in
   * framework CSS like slider/tab/nav layout, or a button's `inline-block`) that
   * have no meaningful name of their own. Folded into the lowest reusable style
   * so they fill gaps without becoming a standalone style.
   */
  frameworkClasses?: string[];
  /** Plain text (newlines denote hard breaks) for text / heading / link nodes. */
  text?: string;
  image?: ImportImage;
  link?: ImportLink;
  /**
   * Marks a link that the source treats as a button (e.g. Webflow's
   * `data.button`). Converted to a Ycode `button` layer so it shrink-wraps and
   * picks up button defaults instead of rendering as a stretched div-link.
   */
  button?: boolean;
  /** Inline SVG markup for icon nodes. */
  svg?: string;
  /** Friendly name from the source — used when naming recovered components. */
  displayName?: string;
  children?: ImportNode[];
}

/** A font referenced by the imported content that should be installed. */
export interface ImportFont {
  family: string;
}

/**
 * The full payload an adapter produces. The core consumes this to build layers.
 */
export interface ImportDocument {
  /** Root nodes (usually one, but a multi-select copy can yield several). */
  roots: ImportNode[];
  /** Font families referenced by the styles (installed before conversion). */
  fonts?: ImportFont[];
  /** Human label for the source, used in the summary toast. */
  source: string;
}

/** Counts surfaced to the user after an import completes. */
export interface ImportSummary {
  layers: number;
  styles: number;
  components: number;
  assets: number;
  fonts: number;
  collections: number;
}
