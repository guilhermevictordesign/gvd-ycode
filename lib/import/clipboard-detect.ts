'use client';

/**
 * Read and classify the OS clipboard for a design-tool payload, OUTSIDE a paste
 * event (e.g. when a context menu opens or one of its items is clicked).
 *
 * The keyboard paste flow uses the `paste` event's `clipboardData`, which needs
 * no permission. Here we have no such event, so we use the async Clipboard API.
 * Reading can be denied (permission / focus); callers must treat `null` as
 * "nothing usable" and degrade gracefully rather than erroring.
 */

import { isWebflowClipboard } from '@/lib/import/adapters/webflow';
import { YCODE_FIGMA_SIGNATURE } from '@/lib/figma/types';
import { YCODE_LAYER_CLIPBOARD_SIGNATURE } from '@/stores/useClipboardStore';

export type ExternalClipboardKind = 'webflow' | 'figma';

/**
 * True only when clipboard-read is *already* granted. Used to gate the
 * context-menu's open-time detection so a right-click never triggers a
 * permission prompt — if access isn't already granted we simply leave the
 * paste items disabled (the keyboard ⌘V flow still works regardless).
 */
export async function isClipboardReadGranted(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return false;
    const status = await navigator.permissions.query({
      name: 'clipboard-read' as PermissionName,
    });
    return status.state === 'granted';
  } catch {
    // Permission name unsupported (e.g. Firefox) — don't prompt; stay disabled.
    return false;
  }
}

export interface ExternalClipboardData {
  kind: ExternalClipboardKind;
  /** text/plain (or application/json) payload. */
  text: string;
  /** text/html payload (Figma sometimes carries its JSON here). */
  html: string;
}

/** Pull text/plain + text/html off the OS clipboard, tolerating partial access. */
async function readClipboardParts(): Promise<{ text: string; html: string }> {
  let text = '';
  let html = '';

  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard) return { text, html };

  try {
    if (clipboard.read) {
      const items = await clipboard.read();
      for (const item of items) {
        if (!html && item.types.includes('text/html')) {
          html = await (await item.getType('text/html')).text();
        }
        if (!text && item.types.includes('text/plain')) {
          text = await (await item.getType('text/plain')).text();
        }
      }
    }
  } catch {
    /* read() denied or unsupported — fall back to readText below */
  }

  if (!text && clipboard.readText) {
    try {
      text = await clipboard.readText();
    } catch {
      /* readText denied — keep whatever we have */
    }
  }

  return { text, html };
}

/**
 * Classify the current OS clipboard. Returns the payload when it holds a
 * Webflow or Figma copy, or `null` for an internal Ycode copy, empty clipboard,
 * or denied access.
 */
export async function readExternalDesignClipboard(): Promise<ExternalClipboardData | null> {
  const { text, html } = await readClipboardParts();

  // An internal Ycode copy claims the OS clipboard with this marker — not external.
  if (text.trim() === YCODE_LAYER_CLIPBOARD_SIGNATURE) return null;

  // Webflow's XSCP JSON usually lands in text/plain, but accept text/html too.
  const webflowText = [text, html].find((value) => value && isWebflowClipboard(value));
  if (webflowText) {
    return { kind: 'webflow', text: webflowText, html };
  }

  const looksFigma =
    (!!html && html.includes('data-ycode-figma')) ||
    (!!text && text.includes(YCODE_FIGMA_SIGNATURE));
  if (looksFigma) {
    return { kind: 'figma', text, html };
  }

  return null;
}
