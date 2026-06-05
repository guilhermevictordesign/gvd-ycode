/**
 * Webflow class → reusable style resolution.
 *
 * Each Webflow class becomes one `ImportStyleRef` whose `classes` already
 * include responsive (`max-lg:` / `max-md:`) and state (`hover:` / `active:` /
 * `focus:`) prefixes derived from the class's `variants`. Combo classes
 * (`comb === '&'`) are flagged so the converter stacks them as overrides.
 */

import type { ImportStyleRef } from '@/lib/import/types';
import { cssToClasses } from '@/lib/import/css';
import { getAffectedProperties } from '@/lib/tailwind-class-mapper';
import { splitVariant } from '@/lib/layer-style-resolve';
import type { XscpAsset, XscpStyle } from '@/lib/import/adapters/webflow/xscp-types';
import { kebabClassName, ruleToClasses, type GlobalStylesheet } from '@/lib/import/adapters/webflow/global-styles';

/**
 * Webflow breakpoints are desktop-first. Map each to Ycode's desktop-first
 * Tailwind prefixes. Ycode has no dedicated "tiny" tier, so it folds into
 * mobile (`max-md:`).
 */
const BREAKPOINT_PREFIX: Record<string, string> = {
  main: '',
  medium: 'max-lg:',
  small: 'max-md:',
  tiny: 'max-md:',
};

const STATE_PREFIX: Record<string, string> = {
  hover: 'hover:',
  active: 'active:',
  pressed: 'active:',
  focus: 'focus:',
};

const BREAKPOINTS = new Set(Object.keys(BREAKPOINT_PREFIX));

/**
 * Turn a variant key (e.g. `medium_hover`) into a Tailwind variant prefix.
 * Returns null for variants Ycode can't represent (e.g. `*_current`).
 */
function variantPrefix(key: string): string | null {
  const parts = key.split('_');
  let bp = 'main';
  let state: string | undefined;

  if (BREAKPOINTS.has(parts[0])) {
    bp = parts[0];
    state = parts[1];
  } else {
    state = parts[0];
  }

  const bpPrefix = BREAKPOINT_PREFIX[bp] ?? '';
  if (!state) return bpPrefix;

  const statePrefix = STATE_PREFIX[state];
  if (!statePrefix) return null; // Unsupported state (e.g. current/visited).
  return `${bpPrefix}${statePrefix}`;
}

/**
 * Webflow embeds asset references in CSS as an "@img_<assetId>" token (e.g. a
 * background-image whose value is "@img_6a1e..."). Rewrite that token to a real
 * "url(<href>)" value so the CSS-to-Tailwind mapper can emit a working
 * background-image utility. Unknown assets collapse to "none" rather than
 * leaking a broken reference.
 *
 * The url() is intentionally UNQUOTED. Tailwind v4 escapes quotes inside an
 * arbitrary value to a backslash-quote, which is invalid CSS and makes the
 * bundler's css-loader treat the URL as a relative module (-> "Module not
 * found"). Unquoted absolute URLs compile cleanly and are left untouched by the
 * loader, and Tailwind preserves underscores inside url() (no space corruption).
 *
 * NOTE: never write a literal arbitrary background utility (the bracketed
 * bg-url form) in comments here — Tailwind v4 scans source comments and would
 * compile the placeholder into a broken url() rule.
 */
function replaceAssetRefs(css: string, resolveAssetUrl: (assetId: string) => string | undefined): string {
  return css.replace(/@img_([A-Za-z0-9]+)/g, (_match, id: string) => {
    const url = resolveAssetUrl(id);
    return url ? `url(${url})` : 'none';
  });
}

/** Build the full prefixed class list for a Webflow style. */
function resolveStyleClasses(style: XscpStyle, resolveAssetUrl: (assetId: string) => string | undefined): string[] {
  const classes: string[] = cssToClasses(replaceAssetRefs(style.styleLess || '', resolveAssetUrl));

  for (const [key, variant] of Object.entries(style.variants ?? {})) {
    if (!variant?.styleLess) continue;
    const prefix = variantPrefix(key);
    if (prefix === null) continue;
    for (const cls of cssToClasses(replaceAssetRefs(variant.styleLess, resolveAssetUrl))) {
      classes.push(`${prefix}${cls}`);
    }
  }

  return classes;
}

/** The set of resolvers the Webflow parser threads through `WebflowParseContext`. */
export interface WebflowStyleResolvers {
  /** Resolve a Webflow class `_id` to a reusable style ref. */
  byId: (classId: string) => ImportStyleRef | null;
  /** Resolve a Webflow class *name* to a reusable style ref (for `xattr` classes). */
  byName: (className: string) => ImportStyleRef | null;
  /** Resolve a Webflow asset id to its absolute CDN URL. */
  resolveAssetUrl: (assetId: string) => string | undefined;
}

/**
 * Build resolvers mapping Webflow class ids/names to reusable style refs and
 * asset ids to CDN URLs. Style resolution is memoised so each class is
 * converted once per paste, regardless of how it is referenced.
 */
export function buildStyleResolvers(
  styles: XscpStyle[],
  assets: XscpAsset[] = [],
  globalStyles?: GlobalStylesheet,
): WebflowStyleResolvers {
  const assetUrlById = new Map<string, string>();
  for (const asset of assets) {
    if (asset._id && asset.cdnUrl) assetUrlById.set(asset._id, asset.cdnUrl);
  }
  const resolveAssetUrl = (assetId: string): string | undefined => assetUrlById.get(assetId);

  // A class "has content" if it would yield any declarations. Webflow dedupes
  // repeated classes: a combo-applied instance often arrives with an empty
  // `styleLess` while a same-named twin carries the real declarations.
  const hasContent = (style: XscpStyle): boolean =>
    !!style.styleLess?.trim() ||
    Object.values(style.variants ?? {}).some((v) => v?.styleLess?.trim());

  const styleById = new Map<string, XscpStyle>();
  const styleByName = new Map<string, XscpStyle>();
  for (const style of styles) {
    styleById.set(style._id, style);
    if (!style.name) continue;
    // Prefer the richest definition for a name, so an empty combo copy never
    // shadows the twin that actually holds the declarations.
    const existing = styleByName.get(style.name);
    if (!existing || (!hasContent(existing) && hasContent(style))) {
      styleByName.set(style.name, style);
    }
  }

  const cache = new Map<string, ImportStyleRef | null>();

  const refFor = (style: XscpStyle | undefined): ImportStyleRef | null => {
    if (!style) return null;
    if (cache.has(style._id)) return cache.get(style._id) ?? null;

    let classes = resolveStyleClasses(style, resolveAssetUrl);
    // Empty copy of a class whose declarations live on a same-named twin
    // (e.g. a "Text Gradient" combo reference) — recover them from the twin.
    if (classes.length === 0 && style.name) {
      const twin = styleByName.get(style.name);
      if (twin && twin._id !== style._id) {
        classes = resolveStyleClasses(twin, resolveAssetUrl);
      }
    }
    // Backfill from the site's global stylesheet, matched by kebab-cased name.
    // Webflow strips variable-backed declarations on copy, so a class can arrive
    // empty ("Text Secondary") *or* partially populated ("Background Dark" keeps
    // `color: white` but loses `background-color: var(--dark)`). We therefore
    // merge the global rule UNDER the clipboard's own declarations: only
    // properties the clipboard doesn't already set are filled, so the resolved
    // clipboard values stay authoritative and nothing is duplicated.
    if (style.name && globalStyles) {
      const globalRule = globalStyles.classByName.get(kebabClassName(style.name));
      if (globalRule) {
        // Track which properties the clipboard already sets *per variant*: a
        // hover-only color (e.g. a combo's `main_hover`) must not block the
        // resting-state backfill, and vice versa. Otherwise a class like
        // "Link White" — whose base color lives only in the global stylesheet —
        // resolves with no resting color and falls through to the `a` tag rule.
        const presentByVariant = new Map<string, Set<string>>();
        for (const cls of classes) {
          const { prefix, base } = splitVariant(cls);
          const set = presentByVariant.get(prefix) ?? new Set<string>();
          for (const p of getAffectedProperties(base)) set.add(p);
          presentByVariant.set(prefix, set);
        }
        const additions = ruleToClasses(globalRule).filter((cls) => {
          if (classes.includes(cls)) return false;
          const { prefix, base } = splitVariant(cls);
          const props = getAffectedProperties(base);
          if (props.length === 0) return false; // unknown/arbitrary — skip to avoid noise
          const present = presentByVariant.get(prefix);
          return props.every((p) => !present?.has(p));
        });
        if (additions.length > 0) classes = [...additions, ...classes];
      }
    }

    const ref: ImportStyleRef = {
      key: style._id,
      name: style.name || 'Imported',
      classes,
      combo: style.comb === '&',
    };
    cache.set(style._id, ref);
    return ref;
  };

  return {
    byId: (classId: string) => refFor(styleById.get(classId)),
    byName: (className: string) => refFor(styleByName.get(className)),
    resolveAssetUrl,
  };
}

/** Extract referenced font families from all styles (for installation). */
export function extractFontFamilies(styles: XscpStyle[]): string[] {
  const families = new Set<string>();
  const generic = new Set(['inherit', 'initial', 'unset', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

  for (const style of styles) {
    const sources = [style.styleLess, ...Object.values(style.variants ?? {}).map((v) => v?.styleLess ?? '')];
    for (const css of sources) {
      const match = css.match(/font-family:\s*([^;]+)/i);
      if (!match) continue;
      const family = match[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
      if (family && !generic.has(family.toLowerCase())) families.add(family);
    }
  }

  return [...families];
}
