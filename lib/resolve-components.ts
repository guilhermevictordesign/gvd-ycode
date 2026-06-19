/**
 * Server-side utility to resolve component instances in layer tree
 * Replaces layers with componentId with the actual component layers
 * Applies component variable overrides during resolution
 */

import type { Layer, Component, ComponentVariable, ComponentVariableValue, LayerVariables, VariantSettingsValue } from '@/types';
import { getComponentVariantLayers } from './component-variant-utils';

/**
 * Remap collection_layer_id in a FieldVariable using the ID map.
 * Returns a new object if remapped, or the original if unchanged.
 */
function remapFieldVariable(fv: any, idMap: Map<string, string>): any {
  if (fv?.type !== 'field' || !fv?.data?.collection_layer_id) return fv;
  const mapped = idMap.get(fv.data.collection_layer_id);
  if (!mapped) return fv;
  return { ...fv, data: { ...fv.data, collection_layer_id: mapped } };
}

/**
 * Remap collection_layer_id references in DesignColorVariable fields/stops.
 */
function remapDesignColor(dcv: any, idMap: Map<string, string>): any {
  if (!dcv || dcv.type !== 'color') return dcv;
  let changed = false;
  const result = { ...dcv };
  if (dcv.field) {
    const remapped = remapFieldVariable(dcv.field, idMap);
    if (remapped !== dcv.field) { result.field = remapped; changed = true; }
  }
  for (const key of ['linear', 'radial'] as const) {
    if (dcv[key]?.stops?.length) {
      const newStops = dcv[key].stops.map((s: any) => {
        if (!s.field) return s;
        const rf = remapFieldVariable(s.field, idMap);
        if (rf !== s.field) { changed = true; return { ...s, field: rf }; }
        return s;
      });
      if (changed) result[key] = { ...dcv[key], stops: newStops };
    }
  }
  return changed ? result : dcv;
}

/**
 * Remap collection_layer_id inside inline variable JSON tags and Tiptap rich text nodes.
 */
function remapCollectionLayerIdsInContent(content: any, idMap: Map<string, string>): any {
  if (typeof content === 'string') {
    // Remap in inline variable tags: <ycode-inline-variable>{"...collection_layer_id":"old"...}</ycode-inline-variable>
    return content.replace(
      /<ycode-inline-variable>([\s\S]*?)<\/ycode-inline-variable>/g,
      (match, inner) => {
        try {
          const parsed = JSON.parse(inner.trim());
          const clid = parsed?.data?.collection_layer_id;
          if (clid && idMap.has(clid)) {
            parsed.data.collection_layer_id = idMap.get(clid);
            return `<ycode-inline-variable>${JSON.stringify(parsed)}</ycode-inline-variable>`;
          }
        } catch { /* not valid JSON, leave as-is */ }
        return match;
      }
    );
  }
  // Tiptap JSON: walk nodes and remap dynamicVariable attrs
  if (content && typeof content === 'object') {
    return remapTiptapNodes(content, idMap);
  }
  return content;
}

/** Recursively remap collection_layer_id in Tiptap JSON tree */
function remapTiptapNodes(node: any, idMap: Map<string, string>): any {
  if (!node || typeof node !== 'object') return node;
  let changed = false;
  let result = node;

  if (node.attrs?.variable?.data?.collection_layer_id) {
    const clid = node.attrs.variable.data.collection_layer_id;
    const mapped = idMap.get(clid);
    if (mapped) {
      result = {
        ...node,
        attrs: {
          ...node.attrs,
          variable: {
            ...node.attrs.variable,
            data: { ...node.attrs.variable.data, collection_layer_id: mapped },
          },
        },
      };
      changed = true;
    }
  }

  if (Array.isArray(node.content)) {
    const newContent = node.content.map((child: any) => remapTiptapNodes(child, idMap));
    if (newContent.some((c: any, i: number) => c !== node.content[i])) {
      result = { ...(changed ? result : node), content: newContent };
    }
  }
  return result;
}

/**
 * Remap all collection_layer_id references in a layer's variables.
 * Ensures layerDataMap lookups match transformed collection layer IDs.
 */
function remapVariableCollectionLayerIds(vars: LayerVariables, idMap: Map<string, string>): LayerVariables {
  let changed = false;
  const result: LayerVariables = { ...vars };

  // Text content (inline variables in dynamic_text, Tiptap nodes in dynamic_rich_text)
  if (vars.text) {
    const tv = vars.text as any;
    if (tv.type === 'dynamic_text' && typeof tv.data?.content === 'string' && tv.data.content.includes('collection_layer_id')) {
      const newContent = remapCollectionLayerIdsInContent(tv.data.content, idMap);
      if (newContent !== tv.data.content) {
        result.text = { ...tv, data: { ...tv.data, content: newContent } } as any;
        changed = true;
      }
    } else if (tv.type === 'dynamic_rich_text' && tv.data?.content) {
      const newContent = remapCollectionLayerIdsInContent(tv.data.content, idMap);
      if (newContent !== tv.data.content) {
        result.text = { ...tv, data: { ...tv.data, content: newContent } } as any;
        changed = true;
      }
    }
  }

  // Image src
  if (vars.image?.src) {
    const r = remapFieldVariable(vars.image.src, idMap);
    if (r !== vars.image.src) { result.image = { ...vars.image, src: r }; changed = true; }
  }

  // Audio src
  if (vars.audio?.src) {
    const r = remapFieldVariable(vars.audio.src, idMap);
    if (r !== vars.audio.src) { result.audio = { ...vars.audio, src: r }; changed = true; }
  }

  // Video src + poster
  if (vars.video) {
    let videoChanged = false;
    const newVideo = { ...vars.video };
    if (vars.video.src) {
      const r = remapFieldVariable(vars.video.src, idMap);
      if (r !== vars.video.src) { newVideo.src = r; videoChanged = true; }
    }
    if (vars.video.poster) {
      const r = remapFieldVariable(vars.video.poster, idMap);
      if (r !== vars.video.poster) { newVideo.poster = r; videoChanged = true; }
    }
    if (videoChanged) { result.video = newVideo; changed = true; }
  }

  // Background image src
  if (vars.backgroundImage?.src) {
    const r = remapFieldVariable(vars.backgroundImage.src, idMap);
    if (r !== vars.backgroundImage.src) { result.backgroundImage = { ...vars.backgroundImage, src: r }; changed = true; }
  }

  // Link field
  if (vars.link?.field) {
    const r = remapFieldVariable(vars.link.field, idMap);
    if (r !== vars.link.field) { result.link = { ...vars.link, field: r }; changed = true; }
  }

  // Design color bindings
  if (vars.design) {
    let designChanged = false;
    const newDesign = { ...vars.design };
    for (const key of ['backgroundColor', 'color', 'borderColor', 'divideColor', 'outlineColor', 'textDecorationColor'] as const) {
      if (vars.design[key]) {
        const r = remapDesignColor(vars.design[key], idMap);
        if (r !== vars.design[key]) { (newDesign as any)[key] = r; designChanged = true; }
      }
    }
    if (designChanged) { result.design = newDesign; changed = true; }
  }

  // Conditional visibility conditions targeting a collection by layer ID
  // (e.g. empty-state "has no items" rules inside a component instance)
  if (vars.conditionalVisibility?.groups?.length) {
    const groups = vars.conditionalVisibility.groups;
    const newGroups = groups.map((group) => {
      if (!Array.isArray(group?.conditions)) return group;
      const newConditions = group.conditions.map((cond) => {
        const mapped = cond?.collectionLayerId ? idMap.get(cond.collectionLayerId) : undefined;
        return mapped && mapped !== cond.collectionLayerId ? { ...cond, collectionLayerId: mapped } : cond;
      });
      return newConditions.some((c, i) => c !== group.conditions[i])
        ? { ...group, conditions: newConditions }
        : group;
    });
    if (newGroups.some((g, i) => g !== groups[i])) {
      result.conditionalVisibility = { ...vars.conditionalVisibility, groups: newGroups };
      changed = true;
    }
  }

  return changed ? result : vars;
}

/**
 * Transform layer IDs to be instance-specific to ensure unique IDs per component instance.
 * This enables animations to target the correct elements when multiple instances exist.
 * @param layers - Layers to transform
 * @param instanceLayerId - The component instance's layer ID used as namespace
 * @returns Transformed layers with remapped IDs and interaction references
 */
export function transformLayerIdsForInstance(layers: Layer[], instanceLayerId: string): Layer[] {
  // Build ID map: original ID -> instance-specific ID
  const idMap = new Map<string, string>();

  // First pass: collect all layer IDs and generate new ones
  const collectIds = (layerList: Layer[]) => {
    for (const layer of layerList) {
      const newId = `${instanceLayerId}-${layer.id}`;
      idMap.set(layer.id, newId);
      if (layer.children) {
        collectIds(layer.children);
      }
    }
  };
  collectIds(layers);

  // Second pass: transform layers with new IDs and remapped interactions
  const transformLayer = (layer: Layer): Layer => {
    const newId = idMap.get(layer.id) || layer.id;

    const transformedLayer: Layer = {
      ...layer,
      id: newId,
      _originalLayerId: layer._originalLayerId || layer.id,
    };

    // Remap interaction IDs and tween layer_id references
    // Interaction IDs must be unique per instance to prevent timeline caching issues
    if (layer.interactions && layer.interactions.length > 0) {
      transformedLayer.interactions = layer.interactions.map(interaction => ({
        ...interaction,
        id: `${instanceLayerId}-${interaction.id}`,
        tweens: interaction.tweens.map(tween => ({
          ...tween,
          layer_id: idMap.get(tween.layer_id) || tween.layer_id,
        })),
      }));
    }

    // Remap collection_layer_id references in field variables so
    // layerDataMap lookups match the transformed collection layer IDs
    if (layer.variables) {
      transformedLayer.variables = remapVariableCollectionLayerIds(layer.variables, idMap);
    }

    // Recursively transform children
    if (layer.children) {
      transformedLayer.children = layer.children.map(transformLayer);
    }

    return transformedLayer;
  };

  return layers.map(transformLayer);
}

type OverrideCategory = Exclude<keyof NonNullable<Layer['componentOverrides']>, 'variableLinks'>;

const OVERRIDE_CATEGORIES: OverrideCategory[] = [
  'text',
  'rich_text',
  'image',
  'link',
  'audio',
  'video',
  'icon',
  'variant',
];

function findOverrideByVariableId(
  overrides: Layer['componentOverrides'] | undefined,
  variableId: string,
): { category: OverrideCategory; value: ComponentVariableValue } | undefined {
  if (!overrides) return undefined;

  for (const category of OVERRIDE_CATEGORIES) {
    const categoryOverrides = overrides[category];
    if (categoryOverrides?.[variableId] !== undefined) {
      return { category, value: categoryOverrides[variableId] };
    }
  }

  return undefined;
}

/**
 * Resolve variableLinks on a component instance's overrides using the parent context.
 * Returns new overrides with linked values resolved from the parent's overrides/defaults.
 */
export function resolveVariableLinks(
  instanceOverrides: Layer['componentOverrides'] | undefined,
  parentOverrides: Layer['componentOverrides'] | undefined,
  parentVariables: ComponentVariable[] | undefined,
): Layer['componentOverrides'] | undefined {
  const links = instanceOverrides?.variableLinks;
  if (!links || Object.keys(links).length === 0) return instanceOverrides;

  const resolved = { ...instanceOverrides };

  for (const [childVarId, parentVarId] of Object.entries(links)) {
    const parentVar = parentVariables?.find(v => v.id === parentVarId);
    let resolvedCategory: OverrideCategory | undefined;
    let resolvedValue: ComponentVariableValue | undefined;

    if (parentVar) {
      const category = (parentVar.type || 'text') as OverrideCategory;
      resolvedCategory = category;
      resolvedValue = parentOverrides?.[category]?.[parentVarId] ?? parentVar.default_value;
    } else {
      const overrideMatch = findOverrideByVariableId(parentOverrides, parentVarId);
      if (overrideMatch) {
        resolvedCategory = overrideMatch.category;
        resolvedValue = overrideMatch.value;
      }
    }

    if (resolvedCategory && resolvedValue !== undefined) {
      resolved[resolvedCategory] = {
        ...(resolved[resolvedCategory] ?? {}),
        [childVarId]: resolvedValue,
      };
    }
  }

  return resolved;
}

/**
 * Apply component variable overrides (or defaults) to layers
 * Recursively finds layers with linked variables and applies override or default values
 */
export function applyComponentOverrides(
  layers: Layer[],
  overrides?: Layer['componentOverrides'],
  componentVariables?: ComponentVariable[]
): Layer[] {
  return layers.map(layer => {
    let updatedLayer = { ...layer };

    // If this nested-component instance has its variant choice driven by a
    // parent component variable, resolve the variant id from the parent's
    // override (or the variable's default) and stamp it on `componentVariantId`
    // before `resolveComponents` reads it. The parent variable is generic — it
    // doesn't carry a target component id — so the variant id might not exist
    // on this layer's referenced component; in that case
    // `getComponentVariantLayers` falls back to the first variant.
    if (layer.componentVariantVariableId) {
      const variableId = layer.componentVariantVariableId;
      const variableDef = componentVariables?.find(v => v.id === variableId);
      const overrideValue = overrides?.variant?.[variableId];
      const value = (overrideValue ?? variableDef?.default_value) as VariantSettingsValue | undefined;
      if (value && typeof value === 'object' && 'variant_id' in value && value.variant_id) {
        updatedLayer = { ...updatedLayer, componentVariantId: value.variant_id };
      }
    }

    // Check if this layer has a text variable linked
    const linkedTextVariableId = layer.variables?.text?.id;
    if (linkedTextVariableId) {
      const variableDef = componentVariables?.find(v => v.id === linkedTextVariableId);
      const overrideCategory = (variableDef?.type === 'rich_text' ? 'rich_text' : 'text') as OverrideCategory;
      const overrideValue = overrides?.[overrideCategory]?.[linkedTextVariableId];
      const valueToApply = overrideValue ?? variableDef?.default_value;

      // Only apply if it's a text variable (has 'type' property, not ImageSettingsValue)
      if (valueToApply && 'type' in valueToApply) {
        // Apply the value to this layer's text variable. Mark layers whose
        // text came from an instance override so `injectTranslatedText`
        // doesn't clobber the (already page-scope-translated) override value
        // with the component-scope default translation.
        updatedLayer = {
          ...updatedLayer,
          variables: {
            ...updatedLayer.variables,
            text: valueToApply as any,
          },
          ...(overrideValue !== undefined ? { _textFromOverride: true } as any : {}),
        };
      }
    }

    // Check if this layer has an image variable linked
    const linkedImageVariableId = (layer.variables?.image?.src as any)?.id;
    if (linkedImageVariableId) {
      // Check for override first, then fall back to variable's default value
      const overrideValue = overrides?.image?.[linkedImageVariableId];
      const variableDef = componentVariables?.find(v => v.id === linkedImageVariableId);
      const imageValue = (overrideValue ?? variableDef?.default_value) as any;

      if (imageValue) {
        // Apply the value to this layer's image variable
        updatedLayer = {
          ...updatedLayer,
          variables: {
            ...updatedLayer.variables,
            image: {
              ...updatedLayer.variables?.image,
              // Apply src from value, keeping the variable ID for reference
              src: imageValue.src ? { ...imageValue.src, id: linkedImageVariableId } : updatedLayer.variables?.image?.src,
              // Apply alt from value if present
              alt: imageValue.alt ?? updatedLayer.variables?.image?.alt,
            },
          },
          // Apply width/height attributes from value if present
          attributes: {
            ...updatedLayer.attributes,
            ...(imageValue.width && { width: imageValue.width }),
            ...(imageValue.height && { height: imageValue.height }),
            ...(imageValue.loading && { loading: imageValue.loading }),
          },
          ...(overrideValue !== undefined ? { _imageFromOverride: true } as any : {}),
        };
      }
    }

    // Check if this layer has a link variable linked
    const linkedLinkVariableId = (layer.variables?.link as any)?.variable_id;
    if (linkedLinkVariableId) {
      const overrideValue = overrides?.link?.[linkedLinkVariableId];
      const variableDef = componentVariables?.find(v => v.id === linkedLinkVariableId);

      // Only resolve when the link variable belongs to THIS component's scope
      // (an override exists here or a matching variable is defined). A link that
      // was already resolved for a nested component instance keeps its
      // `variable_id` for reference — skipping out-of-scope ids stops an outer
      // component pass from stripping a valid nested link it doesn't own.
      if (overrideValue !== undefined || variableDef) {
        // Use `!== undefined` (not `??`) so an explicit `null` override (user cleared
        // the link via "No link") is respected instead of reverting to the default.
        const linkValue = (overrideValue !== undefined ? overrideValue : variableDef?.default_value) as any;

        if (linkValue) {
          // Apply the value to this layer's link variable, keeping the variable_id for reference
          updatedLayer = {
            ...updatedLayer,
            variables: {
              ...updatedLayer.variables,
              link: { ...linkValue, variable_id: linkedLinkVariableId },
            },
          };
        } else {
          // Explicit "No link" — strip any inherited link settings from the layer
          // so the rendered element has no href / link wrapper.
          const { link: _ignored, ...restVariables } = updatedLayer.variables ?? {};
          updatedLayer = { ...updatedLayer, variables: restVariables };
        }
      }
    }

    // Check if this layer has an audio variable linked
    const linkedAudioVariableId = (layer.variables?.audio?.src as any)?.id;
    if (linkedAudioVariableId) {
      const overrideValue = overrides?.audio?.[linkedAudioVariableId];
      const variableDef = componentVariables?.find(v => v.id === linkedAudioVariableId);
      const audioValue = (overrideValue ?? variableDef?.default_value) as any;

      if (audioValue) {
        const audioAttributes: Record<string, unknown> = {};
        if (audioValue.controls !== undefined) audioAttributes.controls = audioValue.controls;
        if (audioValue.loop !== undefined) audioAttributes.loop = audioValue.loop;
        if (audioValue.muted !== undefined) audioAttributes.muted = audioValue.muted;
        if (audioValue.volume !== undefined) audioAttributes.volume = String(audioValue.volume);

        updatedLayer = {
          ...updatedLayer,
          variables: {
            ...updatedLayer.variables,
            audio: {
              ...updatedLayer.variables?.audio,
              src: audioValue.src ? { ...audioValue.src, id: linkedAudioVariableId } : updatedLayer.variables?.audio?.src,
            },
          },
          ...(Object.keys(audioAttributes).length > 0 && {
            attributes: { ...updatedLayer.attributes, ...audioAttributes },
          }),
        };
      }
    }

    // Check if this layer has a video variable linked
    const linkedVideoVariableId = (layer.variables?.video?.src as any)?.id;
    if (linkedVideoVariableId) {
      const overrideValue = overrides?.video?.[linkedVideoVariableId];
      const variableDef = componentVariables?.find(v => v.id === linkedVideoVariableId);
      const videoValue = (overrideValue ?? variableDef?.default_value) as any;

      if (videoValue) {
        const videoAttributes: Record<string, unknown> = {};
        if (videoValue.controls !== undefined) videoAttributes.controls = videoValue.controls;
        if (videoValue.loop !== undefined) videoAttributes.loop = videoValue.loop;
        if (videoValue.muted !== undefined) videoAttributes.muted = videoValue.muted;
        if (videoValue.autoplay !== undefined) videoAttributes.autoplay = videoValue.autoplay;
        if (videoValue.youtubePrivacyMode !== undefined) videoAttributes.youtubePrivacyMode = videoValue.youtubePrivacyMode;

        updatedLayer = {
          ...updatedLayer,
          variables: {
            ...updatedLayer.variables,
            video: {
              ...updatedLayer.variables?.video,
              src: videoValue.src ? { ...videoValue.src, id: linkedVideoVariableId } : updatedLayer.variables?.video?.src,
              poster: videoValue.poster ?? updatedLayer.variables?.video?.poster,
            },
          },
          ...(Object.keys(videoAttributes).length > 0 && {
            attributes: { ...updatedLayer.attributes, ...videoAttributes },
          }),
        };
      }
    }

    // Check if this layer has an icon variable linked
    const linkedIconVariableId = (layer.variables?.icon?.src as any)?.id;
    if (linkedIconVariableId) {
      const overrideValue = overrides?.icon?.[linkedIconVariableId];
      const variableDef = componentVariables?.find(v => v.id === linkedIconVariableId);
      const iconValue = (overrideValue ?? variableDef?.default_value) as any;

      if (iconValue) {
        updatedLayer = {
          ...updatedLayer,
          variables: {
            ...updatedLayer.variables,
            icon: {
              ...updatedLayer.variables?.icon,
              src: iconValue.src ? { ...iconValue.src, id: linkedIconVariableId } : updatedLayer.variables?.icon?.src,
            },
          },
        };
      }
    }

    // Resolve variableLinks on nested component overrides
    if (updatedLayer.componentOverrides?.variableLinks) {
      updatedLayer = {
        ...updatedLayer,
        componentOverrides: resolveVariableLinks(
          updatedLayer.componentOverrides,
          overrides,
          componentVariables,
        ),
      };
    }

    // Recursively process children
    if (updatedLayer.children) {
      updatedLayer.children = applyComponentOverrides(updatedLayer.children, overrides, componentVariables);
    }

    return updatedLayer;
  });
}

/**
 * Tag layers with their master component ID for translation lookups
 */
function tagLayersWithComponentId(layers: Layer[], componentId: string): Layer[] {
  return layers.map(layer => ({
    ...layer,
    _masterComponentId: componentId,
    children: layer.children
      ? tagLayersWithComponentId(layer.children, componentId)
      : undefined,
  }));
}

/**
 * Recursively resolve component instances in a layer tree
 * @param layers - The layer tree to process
 * @param components - Array of available components
 * @param parentComponentVariables - Variables of the parent component (for variableLinks resolution)
 * @param parentOverrides - Overrides from the parent component instance (for variableLinks resolution)
 * @param _visitedComponentIds - Internal: tracks component IDs in the current resolution chain to prevent circular references
 * @returns Layer tree with components resolved
 */
export function resolveComponents(
  layers: Layer[],
  components: Component[],
  parentComponentVariables?: ComponentVariable[],
  parentOverrides?: Layer['componentOverrides'],
  _visitedComponentIds?: Set<string>,
): Layer[] {
  // Resolve variableLinks at this level first so nested instances
  // get the correct overrides before their children are resolved
  const effectiveLayers = parentComponentVariables?.length
    ? applyComponentOverrides(layers, parentOverrides, parentComponentVariables)
    : layers;

  const visited = _visitedComponentIds ?? new Set<string>();

  return effectiveLayers.map(layer => {
    // If this layer is a component instance, populate its children from the component
    if (layer.componentId) {
      // Circular reference guard: skip if this component is already being resolved up the chain
      if (visited.has(layer.componentId)) {
        console.warn('[resolveComponents] Circular component reference detected, skipping:', layer.componentId);
        return { ...layer, children: [] };
      }

      const component = components.find(c => c.id === layer.componentId);

      // Pick the layer tree for the variant this instance is bound to. Falls
      // back to the first variant when the requested variant no longer exists
      // (silent fallback for deleted variants) or to the legacy `layers` field
      // for components stored before the variants migration.
      const variantLayers = component ? getComponentVariantLayers(component, layer.componentVariantId) : [];

      if (component && variantLayers.length) {
        // Track this component in the resolution chain
        const innerVisited = new Set(visited);
        innerVisited.add(layer.componentId);

        // The variant's first layer is the actual content (Section, etc.)
        const componentContent = variantLayers[0];

        // Recursively resolve nested components, passing current component's
        // variables and this instance's overrides so nested variableLinks resolve correctly
        const nestedResolved = componentContent.children
          ? resolveComponents(componentContent.children, components, component.variables, layer.componentOverrides, innerVisited)
          : [];

        // Apply component variable overrides (or defaults) before tagging
        const overriddenChildren = applyComponentOverrides(
          nestedResolved,
          layer.componentOverrides,
          component.variables
        );

        // Also apply overrides to the root layer itself (for root-level link/text/image variables)
        // Process without children since they're already handled above
        const [overriddenRoot] = applyComponentOverrides(
          [{ ...componentContent, children: undefined }],
          layer.componentOverrides,
          component.variables
        );

        // Tag with master component ID for translation lookups
        const taggedChildren = overriddenChildren.length
          ? tagLayersWithComponentId(overriddenChildren, component.id)
          : [];

        // Transform layer IDs to be instance-specific
        // This ensures each component instance has unique IDs for proper animation targeting
        const resolvedChildren = taggedChildren.length
          ? transformLayerIdsForInstance(taggedChildren, layer.id)
          : [];

        // Remap root layer interactions to reference transformed child IDs
        // Without this, tween.layer_id still points to original IDs that no longer exist in the DOM
        let resolvedInteractions = overriddenRoot.interactions;
        if (resolvedInteractions?.length) {
          resolvedInteractions = resolvedInteractions.map(interaction => ({
            ...interaction,
            id: `${layer.id}-${interaction.id}`,
            tweens: interaction.tweens.map(tween => ({
              ...tween,
              layer_id: tween.layer_id === componentContent.id
                ? layer.id
                : `${layer.id}-${tween.layer_id}`,
            })),
          }));
        }

        // Merge component content with instance layer, keeping instance ID
        // IMPORTANT: Keep componentId so LayerRenderer knows this is a component instance
        // _originalLayerId is the component's root template ID — translations on the
        // component's root wrapper (text/media) are stored under this ID, while the
        // runtime ID becomes the page-instance ID.
        return {
          ...layer,
          ...overriddenRoot,
          id: layer.id,
          componentId: layer.componentId, // Keep the original componentId
          _masterComponentId: component.id,
          _originalLayerId: componentContent.id,
          children: resolvedChildren,
          interactions: resolvedInteractions,
        };
      }

      console.warn('[resolveComponents] Component not found or has no layers:', layer.componentId);
    }

    // Recursively process children for non-component layers
    if (layer.children?.length) {
      return {
        ...layer,
        children: resolveComponents(layer.children, components, parentComponentVariables, parentOverrides, visited),
      };
    }

    return layer;
  });
}
