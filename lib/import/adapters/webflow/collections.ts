/**
 * Webflow Collection List (`Dynamo*`) handling.
 *
 * Webflow strips collection identity, item templates and field bindings on
 * copy (see `meta.dynListBindRemovedCount`), so all we can recover is the
 * structure. We emit a single collection-list placeholder with an empty
 * `variables.collection = { id: '' }` that the user re-links to a real Ycode
 * collection (imported separately via the Webflow Data API).
 */

import type { ImportNode } from '@/lib/import/types';
import type { WebflowParseContext, XscpNode } from '@/lib/import/adapters/webflow/xscp-types';

export function isDynamoType(type?: string): boolean {
  return !!type && type.startsWith('Dynamo');
}

export function isCollectionWrapper(type?: string): boolean {
  return type === 'DynamoWrapper';
}

/**
 * Convert a `DynamoWrapper` subtree into a wrapper box containing a collection
 * placeholder node. The item template is preserved when present (it is usually
 * stripped to empty by Webflow).
 */
/** Base (non-combo) class name of a node — Webflow's navigator label. */
function baseName(node: XscpNode, ctx: WebflowParseContext): string | undefined {
  const refs = ctx.resolveStyles(node.classes);
  const base = refs.find((r) => !r.combo) ?? refs[0];
  return base?.name || undefined;
}

export function buildCollectionNode(wrapper: XscpNode, ctx: WebflowParseContext): ImportNode {
  const wrapperStyles = ctx.resolveStyles(wrapper.classes);
  const childNodes = (wrapper.children ?? []).map((id) => ctx.byId.get(id)).filter(Boolean) as XscpNode[];

  const listNode = childNodes.find((n) => n.type === 'DynamoList');

  let collection: ImportNode;
  if (listNode) {
    const listStyles = ctx.resolveStyles(listNode.classes);
    const listChildren = (listNode.children ?? []).map((id) => ctx.byId.get(id)).filter(Boolean) as XscpNode[];
    const itemNode = listChildren.find((n) => n.type === 'DynamoItem');

    // Webflow strips the item template DOM when a Collection List is copied out
    // of its site, so `itemNode.children` is usually empty. We still preserve
    // whatever survives.
    const template = itemNode
      ? ((itemNode.children ?? [])
        .map((id) => ctx.byId.get(id))
        .map((n) => ctx.buildNode(n))
        .filter(Boolean) as ImportNode[])
      : [];

    collection = {
      kind: 'collection',
      tag: 'div',
      styles: listStyles,
      displayName: baseName(listNode, ctx) ?? 'Collection List',
      children: template,
    };
  } else {
    collection = { kind: 'collection', tag: 'div', displayName: 'Collection List', children: [] };
  }

  return {
    kind: 'box',
    tag: wrapper.tag,
    styles: wrapperStyles,
    displayName: baseName(wrapper, ctx) ?? 'Collection List Wrapper',
    children: [collection],
  };
}
