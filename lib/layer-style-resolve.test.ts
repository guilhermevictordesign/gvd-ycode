import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Layer, LayerStyle } from '@/types';
import {
  getStyleIds,
  resolveLayerClasses,
  chipClasses,
  hasChipOverride,
} from '@/lib/layer-style-resolve';
import { detachStyleFromLayers } from '@/lib/layer-style-utils';

function style(id: string, classes: string): LayerStyle {
  return {
    id,
    name: id,
    classes,
    is_published: false,
    created_at: '',
    updated_at: '',
  };
}

test('getStyleIds prefers styleIds, falls back to legacy styleId', () => {
  assert.deepEqual(getStyleIds({ styleIds: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(getStyleIds({ styleId: 'a' }), ['a']);
  assert.deepEqual(getStyleIds({ styleIds: ['a'], styleId: 'b' }), ['a']);
  assert.deepEqual(getStyleIds({}), []);
});

test('resolveLayerClasses: later styles win per property (combo over base)', () => {
  const styles = new Map([
    ['base', style('base', 'bg-red-500 p-2')],
    ['combo', style('combo', 'bg-blue-500')],
  ]);
  const result = resolveLayerClasses({ styleIds: ['base', 'combo'] }, styles).split(' ');
  assert.ok(result.includes('bg-blue-500'), 'combo background wins');
  assert.ok(!result.includes('bg-red-500'), 'base background dropped');
  assert.ok(result.includes('p-2'), 'non-conflicting base class kept');
});

test('resolveLayerClasses: variant buckets resolve independently', () => {
  const styles = new Map([
    ['base', style('base', 'text-black')],
    ['combo', style('combo', 'hover:text-white')],
  ]);
  const result = resolveLayerClasses({ styleIds: ['base', 'combo'] }, styles).split(' ');
  assert.ok(result.includes('text-black'), 'base color survives');
  assert.ok(result.includes('hover:text-white'), 'hover color is a separate bucket');
});

test('resolveLayerClasses: styleOverrides take highest priority', () => {
  const styles = new Map([['base', style('base', 'text-black')]]);
  const result = resolveLayerClasses(
    { styleIds: ['base'], styleOverrides: { classes: 'text-red-500' } },
    styles,
  ).split(' ');
  assert.ok(result.includes('text-red-500'), 'override wins');
  assert.ok(!result.includes('text-black'), 'base color overridden');
});

test('resolveLayerClasses: single legacy styleId resolves identically', () => {
  const styles = new Map([['only', style('only', 'flex gap-2')]]);
  const viaLegacy = resolveLayerClasses({ styleId: 'only' }, styles);
  const viaArray = resolveLayerClasses({ styleIds: ['only'] }, styles);
  assert.equal(viaLegacy, viaArray);
});

test('chipClasses: per-chip override replaces that style for the layer only', () => {
  const styles = new Map([
    ['base', style('base', 'text-black p-2')],
    ['combo', style('combo', 'text-white')],
  ]);
  const layer = {
    styleIds: ['base', 'combo'],
    styleOverridesByStyle: { base: { classes: 'text-blue-500 p-2' } },
  };
  assert.equal(chipClasses(layer, 'base', styles), 'text-blue-500 p-2', 'override used for base');
  assert.equal(chipClasses(layer, 'combo', styles), 'text-white', 'unchanged chip uses style');
  assert.equal(hasChipOverride(layer, 'base'), true);
  assert.equal(hasChipOverride(layer, 'combo'), false);
});

test('resolveLayerClasses: per-chip override cascades within the stack', () => {
  const styles = new Map([
    ['base', style('base', 'text-black p-2')],
    ['combo', style('combo', 'text-white')],
  ]);
  // Override the BASE chip's text color; the higher combo still wins for color,
  // but the base override's non-conflicting class (p-4) survives.
  const result = resolveLayerClasses(
    {
      styleIds: ['base', 'combo'],
      styleOverridesByStyle: { base: { classes: 'text-blue-500 p-4' } },
    },
    styles,
  ).split(' ');
  assert.ok(result.includes('text-white'), 'higher combo color still wins');
  assert.ok(!result.includes('text-blue-500'), 'base override color is overridden by combo');
  assert.ok(result.includes('p-4'), 'base override spacing applied');
  assert.ok(!result.includes('p-2'), 'original base spacing replaced by override');
});

test('resolveLayerClasses: top chip override beats lower styles', () => {
  const styles = new Map([
    ['base', style('base', 'text-black')],
    ['combo', style('combo', 'text-white')],
  ]);
  const result = resolveLayerClasses(
    {
      styleIds: ['base', 'combo'],
      styleOverridesByStyle: { combo: { classes: 'text-green-500' } },
    },
    styles,
  ).split(' ');
  assert.ok(result.includes('text-green-500'), 'override on highest chip wins');
  assert.ok(!result.includes('text-white'), 'overridden combo color dropped');
  assert.ok(!result.includes('text-black'), 'base color dropped');
});

test('detachStyleFromLayers (delete): combo re-resolves remaining, dropping the deleted style', () => {
  // Shared client+server delete path. Deleting one style of a combo keeps the
  // remaining stack and re-flattens — the deleted style's contribution is gone.
  const styles = new Map([
    ['base', style('base', 'text-black p-2')],
    ['combo', style('combo', 'bg-blue-500')],
  ]);
  const layers: Layer[] = [{
    id: 'l1', name: 'div',
    classes: 'text-black p-2 bg-blue-500',
    styleIds: ['base', 'combo'],
  }];
  const [out] = detachStyleFromLayers(layers, 'combo', styles);
  assert.deepEqual(out.styleIds, ['base'], 'deleted style removed from stack');
  const cls = (out.classes as string).split(' ');
  assert.ok(cls.includes('text-black') && cls.includes('p-2'), 'remaining style kept');
  assert.ok(!cls.includes('bg-blue-500'), 'deleted style contribution dropped');
});

test('detachStyleFromLayers (delete): only-style keeps the rendered look as plain classes', () => {
  const styles = new Map([['only', style('only', 'flex gap-2')]]);
  const layers: Layer[] = [{
    id: 'l1', name: 'div', classes: 'flex gap-2', styleIds: ['only'],
  }];
  const [out] = detachStyleFromLayers(layers, 'only', styles);
  assert.equal(out.styleIds, undefined, 'no style links remain');
  assert.equal(out.styleId, undefined);
  assert.equal(out.classes, 'flex gap-2', 'rendered look kept as plain classes');
});

test('detachStyleFromLayers (delete): prunes the deleted chip override, keeps others', () => {
  const styles = new Map([
    ['base', style('base', 'text-black')],
    ['combo', style('combo', 'text-white')],
  ]);
  const layers: Layer[] = [{
    id: 'l1', name: 'div', classes: '',
    styleIds: ['base', 'combo'],
    styleOverridesByStyle: { base: { classes: 'text-red-500' }, combo: { classes: 'text-green-500' } },
  }];
  const [out] = detachStyleFromLayers(layers, 'combo', styles);
  assert.deepEqual(out.styleOverridesByStyle, { base: { classes: 'text-red-500' } }, 'deleted chip override pruned, base kept');
});

test('findAffectedPages invariant: styleIds are discoverable in serialized layers', () => {
  // findAffectedPages detects references via `text.includes(styleId)` over the
  // serialized layer JSON. A layer that uses only the new `styleIds` array (no
  // legacy `styleId`) must still serialize the id so detection keeps working.
  const layer: Layer = {
    id: 'lyr_1',
    name: 'div',
    classes: 'flex',
    styleIds: ['sty_combo_123'],
  };
  const text = JSON.stringify([layer]);
  assert.ok(text.includes('sty_combo_123'), 'style id present in serialized layers');
});
