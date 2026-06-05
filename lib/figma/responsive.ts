'use client';

/**
 * Responsive planning (Phase 4)
 *
 * Reliability-first: the primary path is a designer-driven multi-frame merge.
 * When the selection contains the same design at multiple widths (matched by
 * normalized name + distinct width bands), the widest frame becomes the desktop
 * base and the narrower frames contribute high-confidence `max-lg:` / `max-md:`
 * overrides. When detection is ambiguous, we no-op rather than guess.
 */

import type { YcodeNode } from '@/lib/figma/types';

export interface ResponsivePlan {
  baseNodes: YcodeNode[];
  responsiveClasses: Map<YcodeNode, string[]>;
}

const TABLET_PREFIX = 'max-lg:';
const MOBILE_PREFIX = 'max-md:';

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_-]*(\/|@)?\s*(desktop|tablet|mobile|lg|md|sm|xl)\s*$/i, '')
    .replace(/[\s/_-]*\b(desktop|tablet|mobile)\b[\s/_-]*/gi, ' ')
    .trim();
}

type Band = 'desktop' | 'tablet' | 'mobile';

function bandForWidth(width: number): Band {
  if (width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

function maxFontSize(html?: string): number | null {
  if (!html) return null;
  let max = 0;
  const re = /font-size:\s*(\d+(?:\.\d+)?)px/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = parseFloat(m[1]);
    if (v > max) max = v;
  }
  return max > 0 ? Math.round(max) : null;
}

function paddingAllEqual(node: YcodeNode): number | null {
  if (
    node.paddingTop === node.paddingRight &&
    node.paddingRight === node.paddingBottom &&
    node.paddingBottom === node.paddingLeft
  ) {
    return node.paddingTop;
  }
  return null;
}

/** Append high-confidence breakpoint overrides for `base` based on `bp`. */
function diffNode(
  base: YcodeNode,
  bp: YcodeNode,
  prefix: string,
  map: Map<YcodeNode, string[]>,
): void {
  const classes: string[] = [];

  // Flex direction (the most common and reliable responsive change).
  if (base.display === 'flex' && bp.display === 'flex' && base.flexDirection !== bp.flexDirection) {
    classes.push(`${prefix}flex-${bp.flexDirection === 'row' ? 'row' : 'col'}`);
  }

  // Visibility.
  if (base.visible && !bp.visible) classes.push(`${prefix}hidden`);

  // Width: fixed -> fill, or a different fixed width.
  if (base.widthType === 'fixed' && bp.widthType === 'fill') {
    classes.push(`${prefix}w-full`);
  } else if (base.widthType === 'fixed' && bp.widthType === 'fixed' && Math.round(base.width) !== Math.round(bp.width)) {
    classes.push(`${prefix}w-[${Math.round(bp.width)}px]`);
  }

  // Gap.
  if (base.gap != null && bp.gap != null && base.gap !== bp.gap) {
    classes.push(`${prefix}gap-[${bp.gap}px]`);
  }

  // Uniform padding.
  const basePad = paddingAllEqual(base);
  const bpPad = paddingAllEqual(bp);
  if (basePad != null && bpPad != null && basePad !== bpPad) {
    classes.push(`${prefix}p-[${bpPad}px]`);
  }

  // Heading / text size.
  if (base.__class === 'TextNode' && bp.__class === 'TextNode') {
    const baseFs = maxFontSize(base.html);
    const bpFs = maxFontSize(bp.html);
    if (baseFs != null && bpFs != null && baseFs !== bpFs) {
      classes.push(`${prefix}text-[${bpFs}px]`);
    }
  }

  if (classes.length > 0) {
    const existing = map.get(base) || [];
    map.set(base, existing.concat(classes));
  }
}

function alignAndDiff(
  base: YcodeNode,
  bp: YcodeNode,
  prefix: string,
  map: Map<YcodeNode, string[]>,
): void {
  diffNode(base, bp, prefix, map);
  const baseChildren = base.children || [];
  const bpChildren = bp.children || [];
  // Only recurse when structures align (reliability over coverage).
  if (baseChildren.length !== bpChildren.length || baseChildren.length === 0) return;
  for (let i = 0; i < baseChildren.length; i++) {
    alignAndDiff(baseChildren[i], bpChildren[i], prefix, map);
  }
}

export function planResponsive(nodes: YcodeNode[]): ResponsivePlan {
  const map = new Map<YcodeNode, string[]>();

  // Group top-level nodes by normalized name.
  const groups = new Map<string, YcodeNode[]>();
  const order: string[] = [];
  for (const node of nodes) {
    const key = normalizeName(node.name);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(node);
  }

  const baseNodes: YcodeNode[] = [];

  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length < 2) {
      baseNodes.push(...group);
      continue;
    }

    // Assign each frame to a width band; require distinct bands to merge.
    const byBand: Partial<Record<Band, YcodeNode>> = {};
    for (const node of group) {
      const band = bandForWidth(node.width);
      // Keep the first occurrence per band; prefer wider within a band.
      if (!byBand[band] || node.width > byBand[band]!.width) byBand[band] = node;
    }

    const base = byBand.desktop || group.slice().sort((a, b) => b.width - a.width)[0];
    if (!base) {
      baseNodes.push(...group);
      continue;
    }

    // If we could not separate the group into distinct narrower frames, treat
    // them as independent nodes (no-op merge) to avoid guessing.
    const hasNarrower = (byBand.tablet && byBand.tablet !== base) || (byBand.mobile && byBand.mobile !== base);
    if (!hasNarrower) {
      baseNodes.push(...group);
      continue;
    }

    if (byBand.tablet && byBand.tablet !== base) {
      alignAndDiff(base, byBand.tablet, TABLET_PREFIX, map);
    }
    if (byBand.mobile && byBand.mobile !== base) {
      alignAndDiff(base, byBand.mobile, MOBILE_PREFIX, map);
    }

    baseNodes.push(base);
  }

  return { baseNodes, responsiveClasses: map };
}
