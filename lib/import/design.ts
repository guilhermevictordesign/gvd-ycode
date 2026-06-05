/**
 * Shared helpers for turning a Tailwind class string into cleaned Ycode
 * `DesignProperties`, mirroring the behaviour used by the HTML importer.
 */

import type { Layer } from '@/types';
import { classesToDesign } from '@/lib/tailwind-class-mapper';

/** Drop empty design categories and tag the populated ones as active. */
export function cleanDesign(design: Layer['design']): Layer['design'] | undefined {
  if (!design) return undefined;

  const cleaned: Record<string, unknown> = {};
  let hasValues = false;

  for (const [category, properties] of Object.entries(design)) {
    if (!properties || typeof properties !== 'object') continue;
    if (Object.keys(properties).length > 0) {
      cleaned[category] = { isActive: true, ...properties };
      hasValues = true;
    }
  }

  return hasValues ? (cleaned as Layer['design']) : undefined;
}

/** Build cleaned design properties from a Tailwind class string. */
export function buildDesign(classes: string): Layer['design'] | undefined {
  if (!classes.trim()) return undefined;
  return cleanDesign(classesToDesign(classes));
}
