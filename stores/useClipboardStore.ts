'use client';

/**
 * Clipboard Store
 * 
 * Global clipboard state for layer operations (cut, copy, paste)
 * Works across different pages
 */

import { create } from 'zustand';
import type { Layer, LayerInteraction } from '../types';

/**
 * Marker written to the OS clipboard on an internal copy/cut. The paste handler
 * (`use-import-paste`) reads the OS clipboard to decide between a design-tool
 * import (Webflow/Figma) and a normal internal paste. Because an internal copy
 * stores the layer in this store — not on the OS clipboard — a stale Webflow
 * payload left in the OS clipboard would otherwise be re-imported on every
 * paste. Claiming the OS clipboard with this marker overwrites that stale
 * payload so the paste falls through to the internal clipboard.
 */
export const YCODE_LAYER_CLIPBOARD_SIGNATURE = '__ycode-internal-clipboard__';

/** Best-effort: overwrite the OS clipboard so stale Webflow/Figma data clears. */
function claimSystemClipboard(): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(YCODE_LAYER_CLIPBOARD_SIGNATURE).catch(() => {
        /* permission/focus denied — internal paste still works in-tab */
      });
    }
  } catch {
    /* clipboard API unavailable — ignore */
  }
}

interface CopiedStyle {
  classes: string;
  design?: Layer['design'];
  styleId?: string;
  styleIds?: string[];
  styleOverrides?: Layer['styleOverrides'];
}

interface CopiedInteractions {
  interactions: LayerInteraction[];
  sourceLayerId: string;
}

interface ClipboardState {
  clipboardLayer: Layer | null;
  clipboardMode: 'copy' | 'cut' | null;
  sourcePageId: string | null;
  copiedStyle: CopiedStyle | null;
  copiedInteractions: CopiedInteractions | null;
}

interface ClipboardActions {
  copyLayer: (layer: Layer, pageId: string) => void;
  cutLayer: (layer: Layer, pageId: string) => void;
  clearClipboard: () => void;
  copyStyle: (classes: string, design?: Layer['design'], styleId?: string, styleOverrides?: Layer['styleOverrides'], styleIds?: string[]) => void;
  pasteStyle: () => CopiedStyle | null;
  clearStyle: () => void;
  copyInteractions: (interactions: LayerInteraction[], sourceLayerId: string) => void;
  pasteInteractions: () => CopiedInteractions | null;
  clearInteractions: () => void;
}

type ClipboardStore = ClipboardState & ClipboardActions;

export const useClipboardStore = create<ClipboardStore>((set, get) => ({
  clipboardLayer: null,
  clipboardMode: null,
  sourcePageId: null,
  copiedStyle: null,
  copiedInteractions: null,

  copyLayer: (layer, pageId) => {
    claimSystemClipboard();
    set({
      clipboardLayer: layer,
      clipboardMode: 'copy',
      sourcePageId: pageId,
    });
  },

  cutLayer: (layer, pageId) => {
    claimSystemClipboard();
    set({
      clipboardLayer: layer,
      clipboardMode: 'cut',
      sourcePageId: pageId,
    });
  },

  clearClipboard: () => {
    set({
      clipboardLayer: null,
      clipboardMode: null,
      sourcePageId: null,
    });
  },

  copyStyle: (classes, design, styleId, styleOverrides, styleIds) => {
    set({
      copiedStyle: {
        classes,
        design,
        styleId,
        styleIds,
        styleOverrides,
      },
    });
  },

  pasteStyle: () => {
    return get().copiedStyle;
  },

  clearStyle: () => {
    set({
      copiedStyle: null,
    });
  },

  copyInteractions: (interactions, sourceLayerId) => {
    set({
      copiedInteractions: {
        interactions: JSON.parse(JSON.stringify(interactions)),
        sourceLayerId,
      },
    });
  },

  pasteInteractions: () => {
    return get().copiedInteractions;
  },

  clearInteractions: () => {
    set({
      copiedInteractions: null,
    });
  },
}));
