'use client';

/**
 * External (design-tool) paste bridge.
 *
 * The keyboard paste flow reads design-tool payloads straight off the `paste`
 * event's `clipboardData`, but the layer context menu has no paste event to ride
 * on. This store bridges the two halves:
 *
 *   - `kind` is set when a context menu opens and detects a Webflow/Figma payload
 *     on the OS clipboard, so the menu can enable its "Paste after / inside"
 *     items even when Ycode's own internal clipboard is empty.
 *   - `pasteAt` is registered by the import host (`useImportPaste`, mounted in
 *     `YCodeBuilderMain`) and lets the menu trigger a positional import without
 *     reaching across the component tree.
 */

import { create } from 'zustand';

export type ExternalPasteKind = 'webflow' | 'figma';

/** Where an external paste should land, relative to a target layer. */
export interface ExternalPastePlacement {
  mode: 'after' | 'inside';
  layerId: string;
}

interface ExternalPasteState {
  /** Detected design-tool clipboard kind (set on context-menu open), or null. */
  kind: ExternalPasteKind | null;
  setKind: (kind: ExternalPasteKind | null) => void;
  /**
   * Registered by the import host. Reads the OS clipboard and imports it at the
   * given placement. Null when no import host is mounted.
   */
  pasteAt: ((placement: ExternalPastePlacement) => void) | null;
  setPasteAt: (fn: ((placement: ExternalPastePlacement) => void) | null) => void;
}

export const useExternalPasteStore = create<ExternalPasteState>((set) => ({
  kind: null,
  setKind: (kind) => set({ kind }),
  pasteAt: null,
  setPasteAt: (fn) => set({ pasteAt: fn }),
}));
