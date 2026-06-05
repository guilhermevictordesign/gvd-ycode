/**
 * Layer style resolution.
 *
 * Ycode renders from the flat `layer.classes` string, but a layer can reference
 * an ordered stack of reusable `LayerStyle`s (`styleIds`, low -> high priority)
 * plus per-layer `styleOverrides` (highest). This module is the single place
 * that flattens that stack into the conflict-free string the renderer prints —
 * the same property-aware, variant-scoped merge the importer uses, so live
 * editing and paste-import stay consistent.
 *
 * Resolving to ONE utility per property (rather than concatenating every
 * style's classes) sidesteps Tailwind's source-order precedence: the winner is
 * decided here, by stack order, not by where a class lands in the compiled CSS.
 */

import type { Layer, LayerStyle } from '@/types';
import { getAffectedProperties, removeConflictingClasses } from '@/lib/tailwind-class-mapper';
import { buildDesign } from '@/lib/import/design';

/** Breakpoint + state prefix on a Tailwind class (empty for base desktop/neutral). */
const CLASS_PREFIX_RE = /^((?:max-lg:|max-md:|lg:|md:)?(?:hover:|focus:|active:|disabled:|visited:|current:)?)/;

function classPrefix(cls: string): string {
  return cls.match(CLASS_PREFIX_RE)?.[1] ?? '';
}

/**
 * Collapse an ordered class stack (base first, combos/overrides last) into a
 * conflict-free list where later classes win per property — scoped to the same
 * breakpoint/state group.
 *
 * Webflow resolves a base class + combo classes by source order (the combo
 * wins). Stacking two utilities for the same property (e.g. base `bg-[#f3f4f6]`
 * and combo `bg-[#19292a]`) doesn't cascade by attribute order in the compiled
 * stylesheet, so the wrong one can win. We therefore drop the earlier
 * conflicting class, keeping the later one. Reuses Ycode's own property-aware
 * conflict detection, which (unlike tailwind-merge) correctly separates
 * background-color vs background-image, font-size vs text-color, etc.
 */
export function mergeClassStack(orderedClasses: string[]): string[] {
  const merged: string[] = [];
  for (const cls of orderedClasses) {
    const props = getAffectedProperties(cls);
    if (props.length > 0) {
      const prefix = classPrefix(cls);
      for (let i = merged.length - 1; i >= 0; i -= 1) {
        if (classPrefix(merged[i]) !== prefix) continue;
        const conflicts = props.some((prop) => removeConflictingClasses([merged[i]], prop).length === 0);
        if (conflicts) merged.splice(i, 1);
      }
    }
    if (!merged.includes(cls)) merged.push(cls);
  }
  return merged;
}

/**
 * Split a Tailwind class into its variant prefix (responsive/state, e.g.
 * `max-lg:hover:`) and the bare utility. Colons inside `[…]` arbitrary values
 * are ignored, so `hover:text-[#605dba]` splits only at the variant colon.
 */
export function splitVariant(cls: string): { prefix: string; base: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) cut = i;
  }
  return cut === -1
    ? { prefix: '', base: cls }
    : { prefix: cls.slice(0, cut + 1), base: cls.slice(cut + 1) };
}

/** A layer's applied style stack, low -> high priority. Migrates the legacy single `styleId`. */
export function getStyleIds(layer: Pick<Layer, 'styleId' | 'styleIds'>): string[] {
  if (layer.styleIds && layer.styleIds.length > 0) return layer.styleIds;
  return layer.styleId ? [layer.styleId] : [];
}

type StyleLookup = Map<string, LayerStyle> | ((id: string) => LayerStyle | undefined);

function lookup(styles: StyleLookup): (id: string) => LayerStyle | undefined {
  return typeof styles === 'function' ? styles : (id: string) => styles.get(id);
}

function splitClasses(classes: string | string[] | undefined): string[] {
  if (!classes) return [];
  const str = Array.isArray(classes) ? classes.join(' ') : classes;
  return str.split(/\s+/).filter(Boolean);
}

type ResolvableLayer = Pick<
  Layer,
  'styleId' | 'styleIds' | 'styleOverrides' | 'styleOverridesByStyle'
>;

/**
 * The effective class string contributed by a single style in a layer's stack:
 * the layer's per-chip override for that style if present, otherwise the shared
 * style's own classes. This is what the design panel shows when the chip is the
 * active one, and what each style contributes to the flattened cascade.
 */
export function chipClasses(
  layer: Pick<Layer, 'styleOverridesByStyle'>,
  styleId: string,
  styles: StyleLookup,
): string {
  const override = layer.styleOverridesByStyle?.[styleId];
  if (override?.classes !== undefined) return override.classes;
  return lookup(styles)(styleId)?.classes ?? '';
}

/** Whether a layer carries a per-chip override for the given style id. */
export function hasChipOverride(
  layer: Pick<Layer, 'styleOverridesByStyle'>,
  styleId: string,
): boolean {
  return !!layer.styleOverridesByStyle?.[styleId];
}

/**
 * Flatten a layer's style stack (+ overrides) into the conflict-free class
 * string the renderer prints. Styles are applied low -> high priority. Each
 * style contributes either its own classes or this layer's per-chip override
 * for it (`styleOverridesByStyle`), so a customization stays scoped to one chip
 * yet still cascades against the others. The legacy single `styleOverrides`
 * blob, if present, is applied last (highest). Unknown style ids are skipped.
 */
export function resolveLayerClasses(
  layer: ResolvableLayer,
  styles: StyleLookup,
): string {
  const stack: string[] = [];
  for (const id of getStyleIds(layer)) {
    stack.push(...splitClasses(chipClasses(layer, id, styles)));
  }
  if (layer.styleOverrides?.classes) {
    stack.push(...splitClasses(layer.styleOverrides.classes));
  }
  return mergeClassStack(stack).join(' ').trim();
}

/** The structured design for a resolved layer, derived from its flattened classes. */
export function resolveLayerDesign(
  layer: ResolvableLayer,
  styles: StyleLookup,
): Layer['design'] {
  return buildDesign(resolveLayerClasses(layer, styles));
}
