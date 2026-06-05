/**
 * Shared CSS → Tailwind class mapper.
 *
 * This is the single source of truth for turning a raw CSS declaration block
 * (an inline `style` attribute, or a Webflow `styleLess` string) into Tailwind
 * utility classes. It generalises the original `styleToClasses` from
 * `html-layer-converter.ts` and adds:
 *   - a punch-list of frequent Webflow-isms (grid gaps, per-side borders,
 *     transition-*, transform, mix-blend), and
 *   - a Tailwind arbitrary-property fallback (`[prop:value]`) so that nothing
 *     is silently dropped.
 *
 * `html-layer-converter.styleToClasses` delegates here so the existing HTML
 * import benefits from the wider coverage too.
 */

export interface CssToClassesOptions {
  /**
   * Emit a Tailwind arbitrary-property class (`[prop:value]`) for declarations
   * that have no dedicated mapping. Defaults to `true`.
   */
  arbitraryFallback?: boolean;
}

function parseSpacingShorthand(val: string, prefix: string, sides: [string, string, string, string]): string[] {
  const parts = val.split(/\s+/);
  if (parts.length === 1) return [`${prefix}-[${parts[0]}]`];
  if (parts.length === 2) return [
    `${sides[0]}-[${parts[0]}]`, `${sides[1]}-[${parts[1]}]`,
    `${sides[2]}-[${parts[0]}]`, `${sides[3]}-[${parts[1]}]`,
  ];
  if (parts.length === 3) return [
    `${sides[0]}-[${parts[0]}]`, `${sides[1]}-[${parts[1]}]`,
    `${sides[2]}-[${parts[2]}]`, `${sides[3]}-[${parts[1]}]`,
  ];
  return [
    `${sides[0]}-[${parts[0]}]`, `${sides[1]}-[${parts[1]}]`,
    `${sides[2]}-[${parts[2]}]`, `${sides[3]}-[${parts[3]}]`,
  ];
}

const DISPLAY_MAP: Record<string, string> = {
  flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid',
  'inline-grid': 'inline-grid', block: 'block', 'inline-block': 'inline-block',
  inline: 'inline', none: 'hidden',
};
const FLEX_DIR_MAP: Record<string, string> = {
  row: 'flex-row', 'row-reverse': 'flex-row-reverse',
  column: 'flex-col', 'column-reverse': 'flex-col-reverse',
};
const FLEX_WRAP_MAP: Record<string, string> = {
  wrap: 'flex-wrap', 'wrap-reverse': 'flex-wrap-reverse', nowrap: 'flex-nowrap',
};
const JUSTIFY_MAP: Record<string, string> = {
  'flex-start': 'justify-start', start: 'justify-start',
  'flex-end': 'justify-end', end: 'justify-end',
  center: 'justify-center', 'space-between': 'justify-between',
  'space-around': 'justify-around', 'space-evenly': 'justify-evenly',
  stretch: 'justify-stretch',
};
const ALIGN_ITEMS_MAP: Record<string, string> = {
  'flex-start': 'items-start', start: 'items-start',
  'flex-end': 'items-end', end: 'items-end',
  center: 'items-center', baseline: 'items-baseline', stretch: 'items-stretch',
};
const ALIGN_SELF_MAP: Record<string, string> = {
  auto: 'self-auto', 'flex-start': 'self-start', start: 'self-start',
  'flex-end': 'self-end', end: 'self-end',
  center: 'self-center', stretch: 'self-stretch', baseline: 'self-baseline',
};
const ALIGN_CONTENT_MAP: Record<string, string> = {
  'flex-start': 'content-start', start: 'content-start',
  'flex-end': 'content-end', end: 'content-end',
  center: 'content-center', 'space-between': 'content-between',
  'space-around': 'content-around', 'space-evenly': 'content-evenly',
  stretch: 'content-stretch',
};
const TEXT_ALIGN_MAP: Record<string, string> = {
  left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify',
};
const TEXT_DECO_MAP: Record<string, string> = {
  underline: 'underline', 'line-through': 'line-through', none: 'no-underline',
};
const TEXT_TRANSFORM_MAP: Record<string, string> = {
  uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case',
};
const WHITESPACE_MAP: Record<string, string> = {
  nowrap: 'whitespace-nowrap', pre: 'whitespace-pre',
  'pre-wrap': 'whitespace-pre-wrap', 'pre-line': 'whitespace-pre-line',
  normal: 'whitespace-normal',
};
const POSITION_MAP: Record<string, string> = {
  relative: 'relative', absolute: 'absolute', fixed: 'fixed', sticky: 'sticky', static: 'static',
};
const OVERFLOW_MAP: Record<string, string> = {
  hidden: 'overflow-hidden', auto: 'overflow-auto', scroll: 'overflow-scroll', visible: 'overflow-visible',
};
const CURSOR_MAP: Record<string, string> = {
  pointer: 'cursor-pointer', default: 'cursor-default', move: 'cursor-move',
  text: 'cursor-text', wait: 'cursor-wait', help: 'cursor-help',
  'not-allowed': 'cursor-not-allowed', grab: 'cursor-grab', grabbing: 'cursor-grabbing',
};
const OBJECT_FIT_MAP: Record<string, string> = {
  contain: 'object-contain', cover: 'object-cover', fill: 'object-fill',
  none: 'object-none', 'scale-down': 'object-scale-down',
};
const BORDER_STYLE_VALUES = new Set(['solid', 'dashed', 'dotted', 'double', 'none']);
const SIDE_ABBR: Record<string, string> = { top: 't', right: 'r', bottom: 'b', left: 'l' };

export function sanitizeCssValue(val: string): string {
  let v = val.replace(/\s*!important\s*$/i, '').trim();
  v = v.replace(/,\s+/g, ',');
  return v;
}

/** Underscore-escape a value for use inside a Tailwind arbitrary bracket. */
function arb(val: string): string {
  return val.replace(/\s+/g, '_');
}

/** Map a single `prop: value` declaration to zero or more Tailwind classes. */
function mapDeclaration(prop: string, val: string): string[] {
  const out: string[] = [];

  // Gradient text: `background-clip: text` only reveals the gradient if the
  // text fill is transparent. Emit the full Tailwind recipe so it's visible —
  // a bare `background-clip: text` leaves the gradient hidden behind the text.
  if ((prop === 'background-clip' || prop === '-webkit-background-clip') && val === 'text') {
    return ['bg-clip-text', 'text-transparent'];
  }

  const mapped =
    prop === 'display' ? DISPLAY_MAP[val] :
      prop === 'flex-direction' ? FLEX_DIR_MAP[val] :
        prop === 'flex-wrap' ? FLEX_WRAP_MAP[val] :
          prop === 'justify-content' ? JUSTIFY_MAP[val] :
            prop === 'align-items' ? ALIGN_ITEMS_MAP[val] :
              prop === 'align-self' ? ALIGN_SELF_MAP[val] :
                prop === 'align-content' ? ALIGN_CONTENT_MAP[val] :
                  prop === 'text-align' ? TEXT_ALIGN_MAP[val] :
                    prop === 'text-decoration' || prop === 'text-decoration-line' ? TEXT_DECO_MAP[val] :
                      prop === 'text-transform' ? TEXT_TRANSFORM_MAP[val] :
                        prop === 'white-space' ? WHITESPACE_MAP[val] :
                          prop === 'position' ? POSITION_MAP[val] :
                            prop === 'overflow' ? OVERFLOW_MAP[val] :
                              prop === 'cursor' ? CURSOR_MAP[val] :
                                prop === 'object-fit' ? OBJECT_FIT_MAP[val] :
                                  prop === 'font-style' && val === 'italic' ? 'italic' :
                                    prop === 'font-style' && val === 'normal' ? 'not-italic' :
                                      prop === 'pointer-events' && val === 'none' ? 'pointer-events-none' :
                                        prop === 'pointer-events' && val === 'auto' ? 'pointer-events-auto' :
                                          prop === 'word-break' && val === 'break-all' ? 'break-all' :
                                            prop === 'overflow-wrap' && val === 'break-word' ? 'break-words' :
                                              null;

  if (mapped) { out.push(mapped); return out; }

  // Per-side border width (border-top-width → border-t-[…]).
  const sideBorderWidth = prop.match(/^border-(top|right|bottom|left)-width$/);
  if (sideBorderWidth) { out.push(`border-${SIDE_ABBR[sideBorderWidth[1]]}-[${val}]`); return out; }

  switch (prop) {
    case 'gap': out.push(`gap-[${val}]`); break;
    case 'row-gap': case 'grid-row-gap': out.push(`gap-y-[${val}]`); break;
    case 'column-gap': case 'grid-column-gap': out.push(`gap-x-[${val}]`); break;
    case 'grid-gap': out.push(`gap-[${arb(val)}]`); break;
    case 'grid-template-columns': out.push(`grid-cols-[${arb(val)}]`); break;
    case 'grid-template-rows': out.push(`grid-rows-[${arb(val)}]`); break;
    case 'padding':
      out.push(...parseSpacingShorthand(val, 'p', ['pt', 'pr', 'pb', 'pl']));
      break;
    case 'padding-top': out.push(`pt-[${val}]`); break;
    case 'padding-right': out.push(`pr-[${val}]`); break;
    case 'padding-bottom': out.push(`pb-[${val}]`); break;
    case 'padding-left': out.push(`pl-[${val}]`); break;
    case 'margin':
      out.push(...parseSpacingShorthand(val, 'm', ['mt', 'mr', 'mb', 'ml']));
      break;
    case 'margin-top': out.push(`mt-[${val}]`); break;
    case 'margin-right': out.push(`mr-[${val}]`); break;
    case 'margin-bottom': out.push(`mb-[${val}]`); break;
    case 'margin-left': out.push(`ml-[${val}]`); break;
    case 'width':
      out.push(val === '100%' ? 'w-full' : `w-[${val}]`);
      break;
    case 'height':
      out.push(val === '100%' ? 'h-full' : val === 'auto' ? 'h-auto' : `h-[${val}]`);
      break;
    case 'min-width': out.push(`min-w-[${val}]`); break;
    case 'min-height': out.push(`min-h-[${val}]`); break;
    case 'max-width': out.push(`max-w-[${val}]`); break;
    case 'max-height': out.push(`max-h-[${val}]`); break;
    case 'font-size': out.push(`text-[${val}]`); break;
    case 'font-weight': out.push(`font-[${val}]`); break;
    case 'font-family':
      out.push(`font-[${val.replace(/,\s*/g, ',').replace(/\s+/g, '_')}]`);
      break;
    case 'color': out.push(`text-[${val}]`); break;
    case 'line-height': out.push(`leading-[${val}]`); break;
    case 'letter-spacing': out.push(`tracking-[${val}]`); break;
    case 'background-color': out.push(`bg-[${val}]`); break;
    case 'border-radius': out.push(`rounded-[${val}]`); break;
    case 'border-top-left-radius': out.push(`rounded-tl-[${val}]`); break;
    case 'border-top-right-radius': out.push(`rounded-tr-[${val}]`); break;
    case 'border-bottom-right-radius': out.push(`rounded-br-[${val}]`); break;
    case 'border-bottom-left-radius': out.push(`rounded-bl-[${val}]`); break;
    case 'border-width': out.push(`border-[${val}]`); break;
    case 'border-color': out.push(`border-[${val}]`); break;
    case 'border-style':
      if (BORDER_STYLE_VALUES.has(val)) out.push(`border-${val}`);
      break;
    case 'border': {
      const m = val.match(/^(\S+)\s+(solid|dashed|dotted|double|none)\s+(.+)$/);
      if (m) { out.push(`border-[${m[1]}]`, `border-${m[2]}`, `border-[${m[3]}]`); }
      else if (val === 'none') out.push('border-none');
      break;
    }
    case 'opacity': out.push(`opacity-[${val}]`); break;
    case 'top': out.push(`top-[${val}]`); break;
    case 'right': out.push(`right-[${val}]`); break;
    case 'bottom': out.push(`bottom-[${val}]`); break;
    case 'left': out.push(`left-[${val}]`); break;
    case 'z-index': out.push(`z-[${val}]`); break;
    case 'overflow-x':
      if (['hidden', 'auto', 'scroll', 'visible'].includes(val)) out.push(`overflow-x-${val}`);
      break;
    case 'overflow-y':
      if (['hidden', 'auto', 'scroll', 'visible'].includes(val)) out.push(`overflow-y-${val}`);
      break;
    case 'aspect-ratio':
      out.push(val === 'auto' ? 'aspect-auto' : `aspect-[${val.replace(/\s*\/\s*/g, '/')}]`);
      break;
    case 'box-shadow': out.push(`shadow-[${arb(val)}]`); break;
    case 'background-image': out.push(`bg-[${arb(val)}]`); break;
    case 'flex-grow': out.push(val === '0' ? 'grow-0' : 'grow'); break;
    case 'flex-shrink': out.push(val === '0' ? 'shrink-0' : 'shrink'); break;
    case 'flex-basis': out.push(val === 'auto' ? 'basis-auto' : `basis-[${val}]`); break;
    case 'order': out.push(`order-[${val}]`); break;
    // ── Punch-list: frequent Webflow-isms ──
    case 'transition-duration': out.push(`duration-[${arb(val)}]`); break;
    case 'transition-delay': out.push(`delay-[${arb(val)}]`); break;
    case 'transition-timing-function': out.push(`ease-[${arb(val)}]`); break;
    case 'transform': out.push(`[transform:${arb(val)}]`); break;
    case 'mix-blend-mode': out.push(`mix-blend-${val}`); break;
  }

  return out;
}

/**
 * A CSS property name we are willing to render via the arbitrary fallback.
 *
 * Custom properties (`--token: value`) are deliberately excluded: Webflow's
 * exported stylesheet dumps its *entire* design-token set as `--var` declarations
 * onto class rules (e.g. `.heading-h1` carries 100+ `--font-size--h1: 4rem` style
 * lines). Those are token *definitions*, not utilities — every `var(--token)`
 * reference is already resolved to a concrete value up front — so emitting them
 * as `[--token:value]` classes only floods the layer with meaningless styling.
 */
function isRenderableProp(prop: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(prop);
}

/**
 * Convert a CSS declaration block into Tailwind classes.
 */
export function cssToClasses(style: string, options?: CssToClassesOptions): string[] {
  const arbitraryFallback = options?.arbitraryFallback ?? true;
  const classes: string[] = [];
  const decls = style.split(';').map(d => d.trim()).filter(Boolean);

  for (const decl of decls) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const val = sanitizeCssValue(decl.slice(colonIdx + 1));
    if (!val) continue;

    // Gradient-text technique (`background-clip: text` + `-webkit-text-fill-color:
    // transparent`) can't be reproduced faithfully — we drop the `-webkit-*`
    // halves, and a lone `background-clip: text` would clip the background to the
    // glyphs while the text keeps a solid colour, which tends to blank the text.
    // Skip it so the element keeps its resolved colour and stays visible.
    if ((prop === 'background-clip' || prop === '-webkit-background-clip') && val === 'text') {
      continue;
    }

    const declClasses = mapDeclaration(prop, val);

    if (declClasses.length === 0 && arbitraryFallback && isRenderableProp(prop)) {
      declClasses.push(`[${prop}:${arb(val)}]`);
    }

    classes.push(...declClasses);
  }

  return classes;
}
