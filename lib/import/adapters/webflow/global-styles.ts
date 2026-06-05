/**
 * Webflow site stylesheet → resolved global-style index.
 *
 * The clipboard (XSCP) omits the site's global stylesheet: tag selectors
 * (`h1`–`h6`, `body`, `blockquote`, …), site-wide class definitions, and the
 * `:root` design tokens that classes reference via `var(--token)`. That's why
 * classes like `Background Primary Soft` or `Text Secondary` arrive with an
 * empty `styleLess` — their only declaration is a variable reference Webflow
 * strips on copy.
 *
 * This parser takes the published `*.webflow.shared.*.css` and produces a
 * lookup the importer can join against by class *name* (kebab-cased to match
 * Webflow's selector convention) and by tag. All `var(--token)` references are
 * resolved to concrete values up front so the result feeds straight into the
 * shared CSS → Tailwind mapper.
 *
 * Each rule is stored as a {@link ResolvedRule}: a base (resting / desktop)
 * declaration block plus optional variant blocks keyed by Tailwind variant
 * prefix (`hover:`, `focus:`, `max-lg:`, `max-lg:hover:`, …). State pseudos
 * (`:hover`/`:focus`/`:active`) and width-based `@media` blocks are captured so
 * interactive states and global responsive overrides survive the import. Use
 * {@link ruleToClasses} to flatten a rule into prefixed Tailwind classes.
 *
 * Scope (deliberately conservative):
 *   - top-level `:root` variables, single-class selectors (`.foo-bar`), a fixed
 *     set of tag selectors, each optionally with one trailing state pseudo,
 *   - `@font-face` family names (for installation),
 *   - `@media (max-width: …)` blocks mapped to Ycode's desktop-first tiers,
 *   - compound / descendant / id selectors, `min-width` media and `@keyframes`
 *     are skipped.
 */

import { cssToClasses } from '@/lib/import/css';

/** A resolved global rule: a base declaration block plus variant overrides. */
export interface ResolvedRule {
  /** Resting, main-breakpoint declaration block. */
  base: string;
  /**
   * Variant declaration blocks keyed by Tailwind variant prefix
   * (e.g. `hover:`, `max-lg:`, `max-lg:hover:`). Each value is a resolved CSS
   * declaration block the consumer tokenises and prefixes.
   */
  variants?: Record<string, string>;
}

export interface GlobalStylesheet {
  /** kebab class name (no leading dot) → resolved rule. */
  classByName: Map<string, ResolvedRule>;
  /** tag name (`h1`–`h6`, `body`, `p`, `ul`, …) → resolved rule. */
  tagRules: Map<string, ResolvedRule>;
  /** Font families referenced by `@font-face` / the body class (for install). */
  fontFamilies: string[];
  /** The `.body` base declaration block, applied as the document's base text style. */
  bodyDecl?: string;
}

interface RawRule {
  selector: string;
  body: string;
  atRule?: string;
}

/** Mutable accumulator collected during parsing, finalised into a ResolvedRule. */
interface RuleAccum {
  base: string;
  variants: Map<string, string>;
}

/**
 * Split a stylesheet into top-level rules, tracking balanced braces so nested
 * at-rules (`@media`, `@keyframes`) are captured as a single block rather than
 * mis-split. Comments are assumed already stripped.
 */
function tokenizeRules(css: string): RawRule[] {
  const rules: RawRule[] = [];
  let i = 0;
  const len = css.length;

  while (i < len) {
    const braceOpen = css.indexOf('{', i);
    if (braceOpen === -1) break;

    const prelude = css.slice(i, braceOpen).trim();

    // Find the matching close brace, accounting for nesting (@media/@keyframes).
    let depth = 1;
    let j = braceOpen + 1;
    while (j < len && depth > 0) {
      const ch = css[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    const body = css.slice(braceOpen + 1, j - 1);

    if (prelude.startsWith('@')) {
      const atRule = prelude.split(/\s+/)[0].toLowerCase();
      rules.push({ selector: prelude, body, atRule });
    } else {
      rules.push({ selector: prelude, body });
    }

    i = j;
  }

  return rules;
}

/** Parse `--name: value;` pairs out of a `:root` block. */
function parseVars(body: string, into: Map<string, string>): void {
  for (const decl of body.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const name = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();
    if (name.startsWith('--') && value) into.set(name, value);
  }
}

/** Replace `var(--token[, fallback])` with the resolved value (recursively). */
function makeVarResolver(vars: Map<string, string>): (decl: string) => string {
  const resolveOnce = (decl: string): string =>
    decl.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, name: string, fallback?: string) => {
      const v = vars.get(name);
      if (v !== undefined) return v;
      return (fallback ?? '').trim() || 'inherit';
    });

  return (decl: string): string => {
    let prev = decl;
    // Resolve up to a few passes in case a token resolves to another var().
    for (let n = 0; n < 5; n++) {
      const next = resolveOnce(prev);
      if (next === prev) break;
      prev = next;
    }
    return prev;
  };
}

/** Pull the `font-family` value (first family, unquoted) from a declaration block. */
function fontFamilyOf(decl: string | undefined): string | undefined {
  if (!decl) return undefined;
  const m = decl.match(/font-family:\s*([^;]+)/i);
  if (!m) return undefined;
  return m[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
}

const TAG_SELECTORS = /^(h[1-6]|blockquote|p|a|li|ul|ol|strong|em|b|i|small|figure|figcaption|img|button|label|body)$/;
const SINGLE_CLASS = /^\.[a-zA-Z0-9_-]+$/;

/** State pseudo → Tailwind variant prefix. Other pseudos are unsupported. */
const STATE_PSEUDO: Record<string, string> = {
  hover: 'hover:',
  focus: 'focus:',
  active: 'active:',
};

interface SelectorMatch {
  kind: 'class' | 'tag';
  key: string;
  /** Tailwind state prefix from a trailing pseudo (`hover:`), or '' for resting. */
  prefix: string;
}

/**
 * Classify a single selector into a class/tag target plus an optional state
 * prefix. Accepts at most one trailing state pseudo (`.btn:hover`, `a:focus`);
 * anything compound / descendant / id-based returns null and is skipped.
 */
function classifySelector(selector: string): SelectorMatch | null {
  let core = selector;
  let prefix = '';

  const pseudo = selector.match(/^(.*?)(:hover|:focus|:active)$/);
  if (pseudo) {
    prefix = STATE_PSEUDO[pseudo[2].slice(1)] ?? '';
    if (!prefix) return null;
    core = pseudo[1];
  }

  if (SINGLE_CLASS.test(core)) {
    return { kind: 'class', key: core.slice(1).toLowerCase(), prefix };
  }
  if (TAG_SELECTORS.test(core)) {
    return { kind: 'tag', key: core.toLowerCase(), prefix };
  }
  return null;
}

/**
 * Map a Webflow `@media` condition to a Ycode desktop-first breakpoint prefix.
 * Webflow is desktop-first, so only `max-width` queries narrow the design;
 * `min-width` (and other) queries have no Ycode tier and are skipped.
 */
function mediaPrefix(condition: string): string | null {
  if (/min-width/i.test(condition)) return null;
  const m = condition.match(/max-width:\s*(\d+)px/i);
  if (!m) return null;
  const px = Number(m[1]);
  if (px <= 767) return 'max-md:'; // small + tiny fold into mobile
  if (px <= 991) return 'max-lg:'; // medium tablet tier
  return null; // wider than Ycode's tiers represent
}

function getAccum(map: Map<string, RuleAccum>, key: string): RuleAccum {
  let accum = map.get(key);
  if (!accum) {
    accum = { base: '', variants: new Map() };
    map.set(key, accum);
  }
  return accum;
}

/** Append `decl` onto a rule's base or a variant bucket (later wins on merge). */
function appendDecl(accum: RuleAccum, prefix: string, decl: string): void {
  const trimmed = decl.trim().replace(/;?\s*$/, '');
  if (!trimmed) return;
  if (!prefix) {
    accum.base = accum.base ? `${accum.base}; ${trimmed}` : trimmed;
    return;
  }
  const existing = accum.variants.get(prefix);
  accum.variants.set(prefix, existing ? `${existing}; ${trimmed}` : trimmed);
}

/**
 * Collapse a declaration block so each property appears once with its LAST
 * value — mirroring the CSS cascade when the same selector is defined twice
 * (e.g. a normalize `blockquote { border-left: 5px solid … }` followed by a
 * theme `blockquote { border-left: 1px #000 }`, where the later, style-less
 * value resets the border to invisible). Without this, both survive as separate
 * arbitrary utilities and the wrong one wins.
 */
function dedupeDeclarations(block: string): string {
  const order: string[] = [];
  const values = new Map<string, string>();
  for (const decl of block.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!prop || !val) continue;
    if (!values.has(prop)) order.push(prop);
    values.set(prop, val);
  }
  return order.map((p) => `${p}: ${values.get(p)}`).join('; ');
}

/** Finalise accumulators into deduped ResolvedRules. */
function finalize(map: Map<string, RuleAccum>): Map<string, ResolvedRule> {
  const out = new Map<string, ResolvedRule>();
  for (const [key, accum] of map) {
    const rule: ResolvedRule = { base: dedupeDeclarations(accum.base) };
    if (accum.variants.size > 0) {
      const variants: Record<string, string> = {};
      for (const [prefix, block] of accum.variants) {
        const deduped = dedupeDeclarations(block);
        if (deduped) variants[prefix] = deduped;
      }
      if (Object.keys(variants).length > 0) rule.variants = variants;
    }
    out.set(key, rule);
  }
  return out;
}

interface IndexContext {
  classAccum: Map<string, RuleAccum>;
  tagAccum: Map<string, RuleAccum>;
  fontFamilies: Set<string>;
  resolveVars: (decl: string) => string;
}

/**
 * Index one rule into the class/tag accumulators. `mediaPrefixStr` is the
 * breakpoint prefix inherited from an enclosing `@media` block (empty at the
 * top level) and is combined with any per-selector state prefix.
 */
function indexRule(rule: RawRule, mediaPrefixStr: string, ctx: IndexContext): void {
  if (rule.atRule) {
    if (rule.atRule === '@font-face') {
      const family = fontFamilyOf(rule.body);
      if (family) ctx.fontFamilies.add(family);
      return;
    }
    if (rule.atRule === '@media') {
      const prefix = mediaPrefix(rule.selector);
      if (!prefix) return; // min-width / unsupported condition
      for (const inner of tokenizeRules(rule.body)) {
        indexRule(inner, prefix, ctx);
      }
    }
    // @keyframes / @supports / nested @media intentionally skipped.
    return;
  }

  const resolvedBody = ctx.resolveVars(rule.body);

  for (const rawSel of rule.selector.split(',')) {
    const match = classifySelector(rawSel.trim());
    if (!match) continue;
    const prefix = `${mediaPrefixStr}${match.prefix}`;
    const map = match.kind === 'class' ? ctx.classAccum : ctx.tagAccum;
    appendDecl(getAccum(map, match.key), prefix, resolvedBody);
  }
}

export function parseGlobalStylesheet(css: string): GlobalStylesheet {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = tokenizeRules(clean);

  // Pass 1: collect :root variables (top-level only).
  const vars = new Map<string, string>();
  for (const rule of rules) {
    if (rule.atRule) continue;
    if (rule.selector.split(',').some((s) => s.trim() === ':root')) {
      parseVars(rule.body, vars);
    }
  }

  // Pass 2: index class + tag rules (incl. states + @media), collect fonts.
  const ctx: IndexContext = {
    classAccum: new Map(),
    tagAccum: new Map(),
    fontFamilies: new Set(),
    resolveVars: makeVarResolver(vars),
  };
  for (const rule of rules) indexRule(rule, '', ctx);

  const classByName = finalize(ctx.classAccum);
  const tagRules = finalize(ctx.tagAccum);

  const bodyDecl = classByName.get('body')?.base;
  const bodyFamily = fontFamilyOf(bodyDecl);
  if (bodyFamily) ctx.fontFamilies.add(bodyFamily);

  return {
    classByName,
    tagRules,
    fontFamilies: [...ctx.fontFamilies],
    bodyDecl,
  };
}

/**
 * Flatten a resolved rule into Tailwind classes, prefixing each variant block
 * with its variant key (`hover:`, `max-lg:`, …). Base classes come first so
 * the resting state reads naturally.
 */
export function ruleToClasses(rule: ResolvedRule): string[] {
  const classes = cssToClasses(rule.base);
  if (rule.variants) {
    for (const [prefix, block] of Object.entries(rule.variants)) {
      for (const cls of cssToClasses(block)) classes.push(`${prefix}${cls}`);
    }
  }
  return classes;
}

/** Map a Webflow class display name to its CSS selector form ("Text Secondary" → "text-secondary"). */
export function kebabClassName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}
