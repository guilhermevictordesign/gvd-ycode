/**
 * Webflow image extraction.
 *
 * Most Webflow image nodes carry an absolute CDN URL in `data.attr.src`, so the
 * IR keeps that URL; the shared materializer re-hosts it into Ycode assets at
 * conversion time (falling back to the remote URL if the fetch is blocked).
 *
 * Some images omit `attr.src` and only reference the asset by id in
 * `data.img.id` (these otherwise render as broken placeholders). In that case
 * we resolve the id against the payload's asset table to recover the URL.
 */

import type { ImportImage } from '@/lib/import/types';
import type { XscpNode } from '@/lib/import/adapters/webflow/xscp-types';

const DECORATIVE_ALT = '__wf_reserved_decorative';

export function imageFromNode(
  node: XscpNode,
  resolveAssetUrl: (assetId: string) => string | undefined,
): ImportImage {
  const attr = node.data?.attr ?? {};
  const alt = attr.alt && attr.alt !== DECORATIVE_ALT ? attr.alt : '';
  const width = attr.width && attr.width !== 'auto' ? attr.width : undefined;
  const height = attr.height && attr.height !== 'auto' ? attr.height : undefined;

  const imgId = node.data?.img?.id;
  const src = attr.src || (imgId ? resolveAssetUrl(imgId) : undefined) || undefined;

  return {
    src,
    alt,
    width,
    height,
  };
}
