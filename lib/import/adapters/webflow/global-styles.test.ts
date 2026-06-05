import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGlobalStylesheet,
  ruleToClasses,
  kebabClassName,
} from '@/lib/import/adapters/webflow/global-styles';

test('kebabClassName lowercases and hyphenates a display name', () => {
  assert.equal(kebabClassName('Text Secondary'), 'text-secondary');
  assert.equal(kebabClassName('  Background  Primary Soft '), 'background-primary-soft');
});

test('indexes single-class and resolves :root vars', () => {
  const css = `
    :root { --brand: #605dba; }
    .text-brand { color: var(--brand); }
  `;
  const sheet = parseGlobalStylesheet(css);
  const rule = sheet.classByName.get('text-brand');
  assert.ok(rule, 'class should be indexed');
  assert.match(rule!.base, /#605dba/, 'var() should be resolved to its value');
});

test('expanded tag allow-list captures ul/ol/strong/figure/button', () => {
  const css = `
    ul { margin: 0; }
    ol { padding: 0; }
    strong { font-weight: 700; }
    figure { margin: 0; }
    button { cursor: pointer; }
    section { display: block; }
  `;
  const sheet = parseGlobalStylesheet(css);
  for (const tag of ['ul', 'ol', 'strong', 'figure', 'button']) {
    assert.ok(sheet.tagRules.has(tag), `${tag} should be indexed`);
  }
  // Non-allowlisted tags are still skipped.
  assert.equal(sheet.tagRules.has('section'), false);
});

test('state pseudo selectors become hover:/focus: variants', () => {
  const css = `
    .btn { color: #000; }
    .btn:hover { color: #fff; }
    a:focus { color: #f00; }
  `;
  const sheet = parseGlobalStylesheet(css);

  const btn = sheet.classByName.get('btn');
  assert.ok(btn?.variants && btn.variants['hover:'], 'hover variant captured');
  assert.ok(
    ruleToClasses(btn!).some((c) => c.startsWith('hover:')),
    'flattened classes include a hover: utility',
  );

  const a = sheet.tagRules.get('a');
  assert.ok(a?.variants && a.variants['focus:'], 'focus variant captured on tag rule');
});

test('@media max-width blocks map to desktop-first breakpoint variants', () => {
  const css = `
    h1 { font-size: 48px; }
    @media (max-width: 767px) { h1 { font-size: 24px; } }
    @media (max-width: 991px) { h1 { font-size: 36px; } }
  `;
  const sheet = parseGlobalStylesheet(css);
  const h1 = sheet.tagRules.get('h1');
  assert.ok(h1, 'h1 indexed');
  assert.ok(h1!.variants?.['max-md:'], 'max-width 767 → max-md:');
  assert.ok(h1!.variants?.['max-lg:'], 'max-width 991 → max-lg:');

  const flattened = ruleToClasses(h1!);
  assert.ok(flattened.some((c) => c.startsWith('max-md:')), 'flattened includes max-md:');
  assert.ok(flattened.some((c) => c.startsWith('max-lg:')), 'flattened includes max-lg:');
});

test('min-width @media is skipped (no Ycode tier)', () => {
  const css = `
    .wrap { width: 100%; }
    @media (min-width: 1280px) { .wrap { width: 1200px; } }
  `;
  const sheet = parseGlobalStylesheet(css);
  const wrap = sheet.classByName.get('wrap');
  assert.ok(wrap, 'wrap indexed');
  assert.equal(wrap!.variants, undefined, 'min-width should not produce a variant');
});

test('@media combined with a state pseudo nests both prefixes', () => {
  const css = `
    @media (max-width: 767px) { .btn:hover { color: #fff; } }
  `;
  const sheet = parseGlobalStylesheet(css);
  const btn = sheet.classByName.get('btn');
  assert.ok(btn?.variants && btn.variants['max-md:hover:'], 'breakpoint+state prefix combined');
});

test('duplicate properties collapse to the last value (cascade)', () => {
  const css = `
    blockquote { border-left: 5px solid #000; }
    blockquote { border-left: 0; }
  `;
  const sheet = parseGlobalStylesheet(css);
  const bq = sheet.tagRules.get('blockquote');
  assert.ok(bq, 'blockquote indexed');
  // Only one border-left declaration should survive, the later one.
  const matches = bq!.base.match(/border-left/g) ?? [];
  assert.equal(matches.length, 1, 'border-left deduped');
  assert.match(bq!.base, /border-left:\s*0/, 'last value wins');
});

test('custom-property dumps and gradient-text clip are not emitted as classes', () => {
  // Mirrors a real Webflow export: the class re-declares the whole token set and
  // uses the gradient-text technique. Only the resolved, renderable utilities
  // should survive — never `[--token:value]` floods or `[background-clip:text]`.
  const css = `
    :root { --font-size--h1: 4rem; --text-primary: white; }
    .heading-h1 {
      background-image: linear-gradient(90deg, #fff 21%, #ddc3a5);
      color: var(--text-primary);
      font-size: var(--font-size--h1);
      -webkit-text-fill-color: transparent;
      -webkit-background-clip: text;
      background-clip: text;
      --font-size--h1: 4rem;
      --line-height--xxl: 150%;
      --text-font-size--regular: 1rem;
    }
  `;
  const sheet = parseGlobalStylesheet(css);
  const rule = sheet.classByName.get('heading-h1');
  assert.ok(rule, 'heading-h1 indexed');

  const classes = ruleToClasses(rule!);
  assert.equal(
    classes.some((c) => c.includes('--font-size--h1') || c.includes('--line-height') || c.includes('--text-font-size')),
    false,
    'no custom-property declarations leak through as classes',
  );
  assert.equal(
    classes.some((c) => c.includes('background-clip')),
    false,
    'background-clip: text is dropped',
  );
  assert.ok(
    classes.some((c) => c.includes('4rem')),
    'resolved font-size still maps to a utility',
  );
});

test('compound / id / descendant selectors are skipped', () => {
  const css = `
    .a .b { color: red; }
    #hero { color: blue; }
    .card > .title { color: green; }
  `;
  const sheet = parseGlobalStylesheet(css);
  assert.equal(sheet.classByName.size, 0, 'no single-class rules to index');
});
