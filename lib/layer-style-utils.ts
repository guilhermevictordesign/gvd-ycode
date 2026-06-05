/**
 * Layer Style Utilities
 *
 * Core logic for applying, detaching, and managing layer styles
 */

import type { Layer, LayerStyle, TextStyle } from '@/types';
import { buildDesign } from '@/lib/import/design';
import { getStyleIds, resolveLayerClasses } from '@/lib/layer-style-resolve';

export { getStyleIds } from '@/lib/layer-style-resolve';

/**
 * Apply a style to a layer
 * Replaces the layer's style stack with this single style and its values.
 * Clears any previous style overrides.
 *
 * `styleId` is dual-written alongside `styleIds` so legacy readers keep working
 * during the migration to multi-class stacks.
 */
export function applyStyleToLayer(layer: Layer, style: LayerStyle): Layer {
  return {
    ...layer,
    classes: style.classes,
    design: style.design,
    styleId: style.id,
    styleIds: [style.id],
    styleOverrides: undefined, // Clear any previous overrides
    styleOverridesByStyle: undefined, // Clear per-chip overrides
  };
}

/**
 * Detach style from a layer
 * Copies the current effective styling (style + overrides) to the layer's own classes/design
 * Then removes the style link and overrides
 */
export function detachStyleFromLayer(layer: Layer, style?: LayerStyle): Layer {
  // The layer's current classes/design already reflect the full resolved stack
  // (styles + overrides), so flattening just drops every style link and keeps
  // the rendered look.
  const { styleId, styleIds, styleOverrides, styleOverridesByStyle, ...rest } = layer;

  return {
    ...rest,
    classes: layer.classes || '',
    design: layer.design,
  } as Layer;
}

/**
 * Check if layer has any style applied
 */
export function hasStyle(layer: Layer): boolean {
  return getStyleIds(layer).length > 0;
}

/**
 * Update a styled layer
 * Tracks changes as overrides when a style is applied
 * If no style is applied, updates normally
 */
export function updateStyledLayer(
  layer: Layer,
  updates: { classes?: string; design?: Layer['design'] }
): Layer {
  // Check if the layer has any style applied
  const hasValidStyleId = getStyleIds(layer).length > 0;

  if (!hasValidStyleId) {
    // No style applied, just update normally
    return { ...layer, ...updates };
  }

  // Style is applied - track as overrides
  return {
    ...layer,
    ...updates,
    styleOverrides: {
      classes: updates.classes !== undefined ? updates.classes : layer.styleOverrides?.classes,
      design: updates.design !== undefined ? updates.design : layer.styleOverrides?.design,
    },
  };
}

/**
 * Build a partial update that routes classes/design through the style system.
 * Extra fields (e.g. variables) are passed through unchanged.
 * Use this for atomic updates that combine style-tracked and non-tracked fields.
 */
export function buildStyledUpdate(
  layer: Layer,
  updates: Partial<Layer>,
): Partial<Layer> {
  const { classes: rawClasses, design, ...rest } = updates;
  const classes = Array.isArray(rawClasses) ? rawClasses.join(' ') : rawClasses;

  if (classes === undefined && design === undefined) {
    return updates;
  }

  const styledLayer = updateStyledLayer(layer, { classes, design });
  const result: Partial<Layer> = {
    ...rest,
    design: styledLayer.design,
    classes: styledLayer.classes,
  };

  if (styledLayer.styleOverrides !== layer.styleOverrides) {
    result.styleOverrides = styledLayer.styleOverrides;
  }

  return result;
}

/**
 * Update textStyles entries that reference a given style.
 * Only updates entries WITHOUT overrides (overridden entries keep their custom values).
 */
function updateTextStylesWithStyle(
  textStyles: Record<string, TextStyle>,
  styleId: string,
  newClasses: string,
  newDesign?: Layer['design']
): Record<string, TextStyle> | null {
  let changed = false;
  const updated: Record<string, TextStyle> = {};

  for (const [key, ts] of Object.entries(textStyles)) {
    if (ts.styleId === styleId && !ts.styleOverrides) {
      updated[key] = { ...ts, classes: newClasses, design: newDesign };
      changed = true;
    } else {
      updated[key] = ts;
    }
  }

  return changed ? updated : null;
}

/**
 * Detach a style from all textStyles entries.
 * Keeps current classes/design but removes the style link.
 */
function detachStyleFromTextStyles(
  textStyles: Record<string, TextStyle>,
  styleId: string,
): Record<string, TextStyle> | null {
  let changed = false;
  const updated: Record<string, TextStyle> = {};

  for (const [key, ts] of Object.entries(textStyles)) {
    if (ts.styleId === styleId) {
      const { styleId: _, styleOverrides: __, ...rest } = ts;
      updated[key] = rest;
      changed = true;
    } else {
      updated[key] = ts;
    }
  }

  return changed ? updated : null;
}

/**
 * Update all layers using a specific style
 * Recursively traverses layer tree and updates layers that have the style applied
 * Also updates textStyles entries that reference the style
 * Only updates layers/entries WITHOUT overrides (overridden ones keep their custom values)
 */
export function updateLayersWithStyle(
  layers: Layer[],
  changedStyleId: string,
  stylesById: Map<string, LayerStyle>,
): Layer[] {
  const changed = stylesById.get(changedStyleId);
  const newClasses = changed?.classes ?? '';
  const newDesign = changed?.design;

  return layers.map(layer => {
    let updatedLayer = layer;

    // Re-derive this layer if it references the changed style. Re-flatten the
    // whole stack so the changed style merges back in at its cascade position;
    // `resolveLayerClasses` honors per-chip overrides, so a chip the layer has
    // locally customized keeps its value while the others follow the style.
    // The legacy single-blob `styleOverrides` still freezes the whole layer.
    const ids = getStyleIds(layer);
    if (ids.includes(changedStyleId) && !layer.styleOverrides) {
      const classes = resolveLayerClasses(layer, stylesById);
      updatedLayer = { ...updatedLayer, classes, design: buildDesign(classes) };
    }

    // Update textStyles entries that reference this style (single-style only)
    if (layer.textStyles) {
      const updatedTextStyles = updateTextStylesWithStyle(layer.textStyles, changedStyleId, newClasses, newDesign);
      if (updatedTextStyles) {
        updatedLayer = updatedLayer === layer
          ? { ...layer, textStyles: updatedTextStyles }
          : { ...updatedLayer, textStyles: updatedTextStyles };
      }
    }

    // Recursively update children
    if (layer.children && layer.children.length > 0) {
      const updatedChildren = updateLayersWithStyle(layer.children, changedStyleId, stylesById);
      if (updatedChildren !== layer.children) {
        updatedLayer = updatedLayer === layer
          ? { ...layer, children: updatedChildren }
          : { ...updatedLayer, children: updatedChildren };
      }
    }

    return updatedLayer;
  });
}

/**
 * Detach a style from all layers
 * Used when a style is deleted
 * Keeps current classes/design values but removes the style link
 * Also detaches from textStyles entries that reference the style
 */
export function detachStyleFromLayers(
  layers: Layer[],
  removedStyleId: string,
  stylesById?: Map<string, LayerStyle>,
): Layer[] {
  return layers.map(layer => {
    let updatedLayer = layer;

    // Remove the style from this layer's stack.
    const ids = getStyleIds(layer);
    if (ids.includes(removedStyleId)) {
      const remaining = ids.filter(id => id !== removedStyleId);
      if (remaining.length === 0) {
        // Last/only style: keep the current rendered look, drop all links.
        const { styleId: _s, styleIds: _ss, styleOverrides: _so, styleOverridesByStyle: _sm, ...rest } = layer;
        updatedLayer = rest as Layer;
      } else {
        // Combo stack: keep the remaining styles (and their per-chip overrides),
        // drop the removed style's override, and re-flatten.
        const prevMap = layer.styleOverridesByStyle ?? {};
        const map: NonNullable<Layer['styleOverridesByStyle']> = {};
        for (const id of remaining) if (prevMap[id]) map[id] = prevMap[id];
        const hasMap = Object.keys(map).length > 0;
        const next: Layer = {
          ...layer,
          styleIds: remaining,
          styleId: remaining[0],
          styleOverridesByStyle: hasMap ? map : undefined,
        };
        if (stylesById && !layer.styleOverrides) {
          const classes = resolveLayerClasses(next, stylesById);
          next.classes = classes;
          next.design = buildDesign(classes);
        }
        updatedLayer = next;
      }
    }

    // Detach from textStyles entries
    if (layer.textStyles) {
      const updatedTextStyles = detachStyleFromTextStyles(layer.textStyles, removedStyleId);
      if (updatedTextStyles) {
        updatedLayer = updatedLayer === layer
          ? { ...layer, textStyles: updatedTextStyles }
          : { ...updatedLayer, textStyles: updatedTextStyles };
      }
    }

    // Recursively detach from children
    if (layer.children && layer.children.length > 0) {
      const updatedChildren = detachStyleFromLayers(layer.children, removedStyleId, stylesById);
      if (updatedChildren !== layer.children) {
        updatedLayer = updatedLayer === layer
          ? { ...layer, children: updatedChildren }
          : { ...updatedLayer, children: updatedChildren };
      }
    }

    return updatedLayer;
  });
}

/**
 * Count how many layers use a specific style
 * Includes both direct layer.styleId and textStyles[*].styleId references
 */
export function countLayersUsingStyle(layers: Layer[], styleId: string): number {
  let count = 0;

  for (const layer of layers) {
    if (getStyleIds(layer).includes(styleId)) {
      count++;
    }

    if (layer.textStyles) {
      for (const ts of Object.values(layer.textStyles)) {
        if (ts.styleId === styleId) {
          count++;
        }
      }
    }

    if (layer.children && layer.children.length > 0) {
      count += countLayersUsingStyle(layer.children, styleId);
    }
  }

  return count;
}

/**
 * Get all layer IDs using a specific style
 * Includes layers that reference the style via textStyles[*].styleId
 */
export function getLayerIdsUsingStyle(layers: Layer[], styleId: string): string[] {
  const ids: string[] = [];

  for (const layer of layers) {
    if (getStyleIds(layer).includes(styleId)) {
      ids.push(layer.id);
    } else if (layer.textStyles) {
      for (const ts of Object.values(layer.textStyles)) {
        if (ts.styleId === styleId) {
          ids.push(layer.id);
          break;
        }
      }
    }

    if (layer.children && layer.children.length > 0) {
      ids.push(...getLayerIdsUsingStyle(layer.children, styleId));
    }
  }

  return ids;
}
