import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConditionalVisibility, VisibilityCondition } from '@/types';
import { evaluateCondition, evaluateVisibility, type VisibilityContext } from '@/lib/layer-utils';

const TAG_A = 'tag-aaaa';
const TAG_B = 'tag-bbbb';

function refCondition(overrides: Partial<VisibilityCondition> = {}): VisibilityCondition {
  return {
    id: 'c1',
    source: 'collection_field',
    fieldId: 'posts-tags-field',
    fieldType: 'multi_reference',
    referenceCollectionId: 'tags-collection',
    operator: 'is_one_of',
    value: '[]',
    valueMode: 'current_page',
    ...overrides,
  };
}

function ctx(overrides: Partial<VisibilityContext> = {}): VisibilityContext {
  return {
    collectionLayerData: {},
    pageCollectionData: null,
    pageCollectionItemId: TAG_A,
    ...overrides,
  };
}

test('current_page reference: matches a post that references the current tag (multi_reference JSON array)', () => {
  const cond = refCondition();
  const context = ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_A, TAG_B]) },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, context), true);
});

test('current_page reference: excludes a post that does NOT reference the current tag', () => {
  const cond = refCondition();
  const context = ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_B]) },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, context), false);
});

test('current_page reference: single reference stored as bare UUID matches', () => {
  const cond = refCondition({ fieldType: 'reference' });
  const context = ctx({
    collectionLayerData: { 'posts-tags-field': TAG_A },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, context), true);
});

test('current_page reference: works even if fieldType is missing (operator-based detection)', () => {
  const cond = refCondition({ fieldType: undefined });
  const context = ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_A]) },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, context), true);
});

test('current_page reference: no current page item -> condition is skipped (returns true)', () => {
  const cond = refCondition();
  const context = ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_B]) },
    pageCollectionItemId: undefined,
  });
  assert.equal(evaluateCondition(cond, context), true);
});

test('current_page reference: is_not_one_of excludes the current tag', () => {
  const cond = refCondition({ operator: 'is_not_one_of' });
  const matches = ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_A]) },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, matches), false);
  const noMatch = ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_B]) },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, noMatch), true);
});

test('current_page reference: contains_exactly is treated as "contains current item" (multi-tag post matches)', () => {
  // A real post usually has multiple tags. With contains_exactly + a single injected
  // current-page id this would otherwise require the post to have ONLY that tag.
  const cond = refCondition({ operator: 'contains_exactly', value: '[]' });
  const multiTagPost = ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_A, TAG_B]) },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, multiTagPost), true);
  const otherTagPost = ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_B]) },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, otherTagPost), false);
});

test('static contains_exactly is unchanged (still requires exact set match)', () => {
  const cond = refCondition({ operator: 'contains_exactly', valueMode: 'static', value: JSON.stringify([TAG_A]) });
  const exact = ctx({ collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_A]) } });
  assert.equal(evaluateCondition(cond, exact), true);
  const superset = ctx({ collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_A, TAG_B]) } });
  assert.equal(evaluateCondition(cond, superset), false);
});

test('current_page reference: matches when the field value is an ARRAY (SSR cache form)', () => {
  // The SSR collection cache hands multi-reference values as parsed arrays, not
  // JSON strings. `String([...])` used to comma-join them into an unparseable
  // string, dropping every match. Cover the array form explicitly.
  const cond = refCondition({ operator: 'is_one_of', value: '[]' });
  const arrayMatch = ctx({
    collectionLayerData: { 'posts-tags-field': [TAG_A, TAG_B] as unknown as string },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, arrayMatch), true);
  const arrayNoMatch = ctx({
    collectionLayerData: { 'posts-tags-field': [TAG_B] as unknown as string },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, arrayNoMatch), false);
});

test('current_page reference: contains_all_of works with ARRAY field value', () => {
  const cond = refCondition({ operator: 'contains_all_of', value: '[]' });
  const multiTag = ctx({
    collectionLayerData: { 'posts-tags-field': [TAG_A, TAG_B] as unknown as string },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, multiTag), true);
});

test('current_page scalar: matches when page field value equals item field value', () => {
  const cond: VisibilityCondition = {
    id: 'c1',
    source: 'collection_field',
    fieldId: 'posts-category-name',
    fieldType: 'text',
    operator: 'is',
    valueMode: 'current_page',
    currentPageFieldId: 'tags-name-field',
  };
  const match = ctx({
    collectionLayerData: { 'posts-category-name': 'Design' },
    pageCollectionData: { 'tags-name-field': 'Design' },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, match), true);
  const noMatch = ctx({
    collectionLayerData: { 'posts-category-name': 'Marketing' },
    pageCollectionData: { 'tags-name-field': 'Design' },
    pageCollectionItemId: TAG_A,
  });
  assert.equal(evaluateCondition(cond, noMatch), false);
});

test('evaluateVisibility end-to-end: single group with a current_page reference condition', () => {
  const filters: ConditionalVisibility = {
    groups: [{ id: 'g1', conditions: [refCondition()] }],
  };
  const keep = evaluateVisibility(filters, ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_A]) },
    pageCollectionItemId: TAG_A,
  }));
  assert.equal(keep, true);
  const drop = evaluateVisibility(filters, ctx({
    collectionLayerData: { 'posts-tags-field': JSON.stringify([TAG_B]) },
    pageCollectionItemId: TAG_A,
  }));
  assert.equal(drop, false);
});
