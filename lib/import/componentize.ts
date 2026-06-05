/**
 * Structural re-componentization.
 *
 * Webflow strips component (Symbol) identity from the clipboard on copy — the
 * pasted JSON only ever contains flattened plain elements plus an
 * `unlinkedSymbolCount`, never the component reference or definition (that lives
 * in Webflow's internal store, which we can't read). So there is no way to know
 * which elements were "real" Webflow components.
 *
 * The only honest signal we have is *repetition*: we recover reusable components
 * by detecting repeated sibling subtrees with an identical shape and turning the
 * leaves whose content differs between instances into component variables
 * (text / image / link). To stay conservative we only do this for genuinely
 * repeated, small-to-medium blocks (cards, slides, list items) — never whole
 * page regions like sections, which are structure rather than reusable units.
 *
 * The first instance becomes the component definition; every instance is
 * replaced with a thin component-instance layer carrying per-instance
 * `componentOverrides`.
 *
 * Note: this is the shared (Webflow) path only. Figma componentizes off real
 * `isInstance` identity in `lib/figma/converter.ts` and does not use this.
 */

import { cloneDeep } from 'lodash';
import type { ComponentVariable, ComponentVariableValue, Layer } from '@/types';
import { generateId } from '@/lib/utils';
import { cleanLayersForComponentCreation } from '@/lib/layer-utils';
import { getStyleIds } from '@/lib/layer-style-resolve';
import type { ImportMaterializer } from '@/lib/import/materializer';

/** Minimum subtree size (node count) before a repeated shape is worth extracting. */
const MIN_SUBTREE_NODES = 3;

/**
 * Upper subtree size bound. Above this, a repeated shape is almost certainly a
 * coincidental page-region match (whole sections built alike) rather than a
 * reusable component. Real repeated components are small/medium blocks. Tune as
 * needed.
 */
const MAX_SUBTREE_NODES = 40;

/** Page-region tags that are layout structure, not reusable components. */
const REGION_TAGS = new Set(['section', 'header', 'footer', 'nav', 'main', 'aside']);

/** True when a layer is a top-level page region we should never componentize. */
function isPageRegion(layer: Layer): boolean {
  const tag = layer.settings?.tag ?? layer.name;
  return REGION_TAGS.has(tag);
}

/** A structural signature that ignores ids and content but captures shape. */
function shapeSignature(layer: Layer): string {
  const tag = layer.settings?.tag ?? '';
  const ids = getStyleIds(layer);
  const styleSig = ids.length > 0 ? `#${ids.join('#')}` : classSig(layer.classes);
  const roles = [
    layer.variables?.text ? 't' : '',
    layer.variables?.image ? 'i' : '',
    layer.variables?.link ? 'l' : '',
    layer.variables?.icon ? 'c' : '',
  ].join('');
  const children = (layer.children ?? []).map(shapeSignature).join(',');
  return `${layer.name}|${tag}|${styleSig}|${roles}(${children})`;
}

function classSig(classes: string | string[] | undefined): string {
  const str = Array.isArray(classes) ? classes.join(' ') : classes ?? '';
  return str.split(/\s+/).filter(Boolean).sort().join(' ');
}

function countNodes(layer: Layer): number {
  return 1 + (layer.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

function subtreeHasCollection(layer: Layer): boolean {
  if (layer.variables?.collection) return true;
  return (layer.children ?? []).some(subtreeHasCollection);
}

/**
 * Recursively componentize a layer tree, grouping repeated siblings at every
 * level. Mutates/returns a new tree where repeated groups become instances.
 */
export async function componentizeLayers(layers: Layer[], mat: ImportMaterializer): Promise<Layer[]> {
  // Process descendants first so nested repetition is captured before parents.
  for (const layer of layers) {
    if (layer.children && layer.children.length > 0) {
      layer.children = await componentizeLayers(layer.children, mat);
    }
  }

  return groupSiblings(layers, mat);
}

async function groupSiblings(siblings: Layer[], mat: ImportMaterializer): Promise<Layer[]> {
  const groups = new Map<string, Layer[]>();
  for (const layer of siblings) {
    const size = countNodes(layer);
    if (size < MIN_SUBTREE_NODES || size > MAX_SUBTREE_NODES) continue;
    if (isPageRegion(layer)) continue;
    if (subtreeHasCollection(layer)) continue;
    const sig = shapeSignature(layer);
    const list = groups.get(sig) ?? [];
    list.push(layer);
    groups.set(sig, list);
  }

  // Map each layer that belongs to a ≥2 group to its component instance.
  const replacements = new Map<string, Layer>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const instances = await buildComponentFromGroup(group, mat);
    if (!instances) continue;
    group.forEach((member, i) => replacements.set(member.id, instances[i]));
  }

  if (replacements.size === 0) return siblings;
  return siblings.map((layer) => replacements.get(layer.id) ?? layer);
}

/** Plain-text/JSON snapshot of a leaf's content, for cross-instance diffing. */
function contentKey(layer: Layer): { text?: string; image?: string; link?: string } {
  const out: { text?: string; image?: string; link?: string } = {};
  if (layer.variables?.text) out.text = JSON.stringify(layer.variables.text.data);
  if (layer.variables?.image) out.image = JSON.stringify(layer.variables.image.src);
  if (layer.variables?.link) out.link = JSON.stringify(layer.variables.link);
  return out;
}

/**
 * Build a component from a group of identically-shaped subtrees. Returns the
 * per-instance replacement layers, or null if creation failed.
 */
async function buildComponentFromGroup(group: Layer[], mat: ImportMaterializer): Promise<Layer[] | null> {
  const template = cloneDeep(group[0]);
  const variables: ComponentVariable[] = [];
  const overridesPerInstance: NonNullable<Layer['componentOverrides']>[] = group.map(() => ({}));

  // Walk template + all instances in lockstep (guaranteed same shape).
  const walk = (templateNode: Layer, instanceNodes: Layer[]): void => {
    const keys = instanceNodes.map(contentKey);

    // Text variable
    if (templateNode.variables?.text) {
      const distinct = new Set(keys.map((k) => k.text));
      if (distinct.size > 1) {
        const varId = generateId('cvar');
        const tpl = templateNode.variables.text as { id?: string };
        tpl.id = varId;
        variables.push({
          id: varId,
          name: `Text ${variables.length + 1}`,
          type: 'rich_text',
          default_value: cloneDeep(instanceNodes[0].variables!.text) as ComponentVariableValue,
        });
        instanceNodes.forEach((node, i) => {
          (overridesPerInstance[i].rich_text ??= {})[varId] = cloneDeep(node.variables!.text) as ComponentVariableValue;
        });
      }
    }

    // Image variable
    if (templateNode.variables?.image) {
      const distinct = new Set(keys.map((k) => k.image));
      if (distinct.size > 1) {
        const varId = generateId('cvar');
        const src = templateNode.variables.image.src as { id?: string };
        if (src) src.id = varId;
        variables.push({
          id: varId,
          name: `Image ${variables.length + 1}`,
          type: 'image',
          default_value: cloneDeep(instanceNodes[0].variables!.image) as unknown as ComponentVariableValue,
        });
        instanceNodes.forEach((node, i) => {
          (overridesPerInstance[i].image ??= {})[varId] = cloneDeep(node.variables!.image) as unknown as ComponentVariableValue;
        });
      }
    }

    // Link variable
    if (templateNode.variables?.link) {
      const distinct = new Set(keys.map((k) => k.link));
      if (distinct.size > 1) {
        const varId = generateId('cvar');
        (templateNode.variables.link as { variable_id?: string }).variable_id = varId;
        variables.push({
          id: varId,
          name: `Link ${variables.length + 1}`,
          type: 'link',
          default_value: cloneDeep(instanceNodes[0].variables!.link) as ComponentVariableValue,
        });
        instanceNodes.forEach((node, i) => {
          (overridesPerInstance[i].link ??= {})[varId] = cloneDeep(node.variables!.link) as ComponentVariableValue;
        });
      }
    }

    const templateChildren = templateNode.children ?? [];
    templateChildren.forEach((child, idx) => {
      walk(child, instanceNodes.map((n) => (n.children ?? [])[idx]).filter(Boolean) as Layer[]);
    });
  };

  walk(template, group);

  const name = componentName(template);
  const componentLayers = cleanLayersForComponentCreation([template]);
  const component = await mat.createComponent(name, componentLayers, variables.length > 0 ? variables : undefined);
  if (!component) return null;

  return group.map((member, i) => {
    const overrides = overridesPerInstance[i];
    const hasOverrides = Object.keys(overrides).length > 0;
    const instance: Layer = {
      id: member.id,
      name: member.name,
      classes: '',
      componentId: component.id,
      children: [],
    };
    if (hasOverrides) instance.componentOverrides = overrides;
    return instance;
  });
}

function componentName(layer: Layer): string {
  return layer.customName || cap(layer.name) || 'Component';
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
