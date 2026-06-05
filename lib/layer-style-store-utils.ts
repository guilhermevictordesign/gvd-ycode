import { useComponentsStore } from '@/stores/useComponentsStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { useLayerStylesStore } from '@/stores/useLayerStylesStore';
import type { Layer, LayerStyle } from '@/types';

/**
 * Snapshot the layer-styles store as an id -> style map. Multi-class layers
 * need every style in their stack (not just the changed one) to re-flatten.
 */
function buildStylesById(): Map<string, LayerStyle> {
  const map = new Map<string, LayerStyle>();
  for (const style of useLayerStylesStore.getState().styles) {
    map.set(style.id, style);
  }
  return map;
}

/**
 * Update all layers using a style across pages and components.
 *
 * `newClasses`/`newDesign` reflect the just-saved style; we overlay them on the
 * store snapshot so propagation works even if the incoming update hasn't landed
 * in the store yet (e.g. a remote collaborator's change).
 */
export function updateStyleAcrossStores(
  styleId: string,
  newClasses: string,
  newDesign?: Layer['design']
): void {
  const stylesById = buildStylesById();
  const existing = stylesById.get(styleId);
  stylesById.set(styleId, {
    ...(existing ?? {
      id: styleId,
      name: '',
      is_published: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    classes: newClasses,
    design: newDesign,
  });

  const { updateStyleOnLayers } = usePagesStore.getState();
  const { updateStyleOnLayers: updateStyleOnComponentLayers } = useComponentsStore.getState();

  updateStyleOnLayers(styleId, stylesById);
  updateStyleOnComponentLayers(styleId, stylesById);
}

/**
 * Detach a style from all layers across pages and components.
 * Call after the style has been removed from the styles store so the snapshot
 * used to re-flatten combo stacks excludes it.
 */
export function detachStyleAcrossStores(styleId: string): void {
  const stylesById = buildStylesById();

  const { detachStyleFromAllLayers } = usePagesStore.getState();
  const { detachStyleFromAllLayers: detachStyleFromAllComponentLayers } = useComponentsStore.getState();

  detachStyleFromAllLayers(styleId, stylesById);
  detachStyleFromAllComponentLayers(styleId, stylesById);
}
