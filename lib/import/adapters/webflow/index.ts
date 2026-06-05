/**
 * Webflow adapter entry point: detect the XSCP clipboard signature and turn the
 * raw clipboard string into a neutral `ImportDocument`.
 */

import type { ImportDocument } from '@/lib/import/types';
import { parseWebflow } from '@/lib/import/adapters/webflow/parse';
import type { GlobalStylesheet } from '@/lib/import/adapters/webflow/global-styles';
import { XSCP_TYPE, type XscpPayload } from '@/lib/import/adapters/webflow/xscp-types';

/** Cheap signature check before attempting a full JSON parse. */
export function isWebflowClipboard(text: string): boolean {
  return text.includes(XSCP_TYPE);
}

/**
 * Parse a clipboard string into an import document, or null if it isn't XSCP.
 * When a parsed global stylesheet is supplied, it backfills variable-only
 * classes and tag styles the clipboard omits.
 */
export function parseWebflowClipboard(text: string, globalStyles?: GlobalStylesheet): ImportDocument | null {
  let data: XscpPayload;
  try {
    data = JSON.parse(text) as XscpPayload;
  } catch {
    return null;
  }

  if (data?.type !== XSCP_TYPE || !data.payload?.nodes) return null;
  return parseWebflow(data, globalStyles);
}
