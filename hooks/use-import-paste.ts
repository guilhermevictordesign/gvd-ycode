'use client';

/**
 * Unified clipboard-paste importer.
 *
 * Intercepts the browser paste event and dispatches by source:
 *   1. Webflow XSCP payload   → shared import pipeline (`lib/import`)
 *   2. Figma plugin payload   → Figma converter (`lib/figma`)
 *   3. Anything else          → normal Ycode internal paste (`onNormalPaste`)
 *
 * Both design-tool branches produce `Layer[]` and hand them to the same
 * `insertLayers` callback, so insertion/placement logic lives in one place.
 *
 * Runs on the `paste` event (not keydown) so we can read `clipboardData`. The
 * Ycode canvas is a same-origin iframe, so a paste fired while focus is inside
 * it never reaches the top document — we therefore bind the handler to the top
 * document AND every same-origin iframe document, re-attaching as iframes load.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { Layer } from '@/types';
import { useFontsStore } from '@/stores/useFontsStore';
import { YCODE_FIGMA_SIGNATURE, isYcodeFigmaPayload } from '@/lib/figma/types';
import type { YcodeFigmaPayload } from '@/lib/figma/types';
import { loadSiteStylesheetCss } from '@/lib/apps/webflow/stylesheet-cache';
import { buildImport } from '@/lib/import';
import { isWebflowClipboard, parseWebflowClipboard } from '@/lib/import/adapters/webflow';
import { parseGlobalStylesheet } from '@/lib/import/adapters/webflow/global-styles';
import { plural } from '@/lib/import/summary';
import type { ImportSummary } from '@/lib/import/types';
import { readExternalDesignClipboard } from '@/lib/import/clipboard-detect';
import { YCODE_LAYER_CLIPBOARD_SIGNATURE } from '@/stores/useClipboardStore';
import {
  useExternalPasteStore,
  type ExternalPastePlacement,
} from '@/stores/useExternalPasteStore';

interface UseImportPasteOptions {
  enabled: boolean;
  /**
   * Insert built layers using the host's placement rules. When `placement` is
   * given (a context-menu "Paste after / inside"), insert relative to that
   * target; otherwise the host falls back to its default selection-based rule.
   */
  insertLayers: (layers: Layer[], placement?: ExternalPastePlacement) => void;
  /** Fall back to Ycode's internal clipboard paste. */
  onNormalPaste: () => void;
}

interface FontResolution {
  /** Lowercased family names that resolve to an installed/built-in font. */
  available: Set<string>;
  /** Families newly installed from Google during this import. */
  installed: string[];
  /** Families we couldn't resolve — left unset so layers use the default font. */
  unavailable: string[];
}

/**
 * Resolve the fonts used by an imported design BEFORE conversion runs.
 *
 * Installs any family that exists on Google Fonts, and returns the set of
 * families that actually resolve to a usable font. Families that can't be
 * resolved are reported back so the converter can skip them (rather than
 * emitting a dangling `font-[...]` class that silently renders as the default)
 * and the user can be told which fonts need manual handling.
 */
async function resolveFonts(families: string[]): Promise<FontResolution> {
  const store = useFontsStore.getState();
  await store.loadFonts();
  await store.loadGoogleFontsCatalog();

  const catalog = useFontsStore.getState().googleFontsCatalog;
  const available = new Set<string>();
  const installed: string[] = [];
  const unavailable: string[] = [];

  for (const family of families) {
    if (useFontsStore.getState().getFontByFamily(family)) {
      available.add(family.toLowerCase());
      continue;
    }

    const match = catalog.find(
      (f) => f.family.toLowerCase() === family.toLowerCase()
    );

    if (match) {
      try {
        await useFontsStore.getState().addGoogleFont(match);
        available.add(family.toLowerCase());
        installed.push(family);
        continue;
      } catch {
        /* fall through to unavailable */
      }
    }

    unavailable.push(family);
  }

  return { available, installed, unavailable };
}

/**
 * Returns the parsed payload, the string `'truncated'` when Figma data is
 * present but unparseable (clipboard truncation on large selections), or null
 * when there's no Figma data at all.
 */
function extractFigmaPayload(clipboardData: DataTransfer): YcodeFigmaPayload | 'truncated' | null {
  let sawSignature = false;

  const html = clipboardData.getData('text/html');
  if (html) {
    const match = html.match(/data-ycode-figma="([^"]*)"/);
    if (match?.[1]) {
      sawSignature = true;
      try {
        const decoded = decodeURIComponent(match[1]);
        const parsed = JSON.parse(decoded);
        if (isYcodeFigmaPayload(parsed)) return parsed;
      } catch { /* not valid / truncated */ }
    }
  }

  const text = clipboardData.getData('text/plain');
  if (text?.includes(YCODE_FIGMA_SIGNATURE)) {
    sawSignature = true;
    try {
      const parsed = JSON.parse(text);
      if (isYcodeFigmaPayload(parsed)) return parsed;
    } catch { /* not valid / truncated */ }
  }

  return sawSignature ? 'truncated' : null;
}

/** Pull whichever clipboard MIME type might carry a Webflow XSCP payload. */
function readClipboardText(clipboardData: DataTransfer): string {
  return (
    clipboardData.getData('application/json') ||
    clipboardData.getData('text/plain') ||
    clipboardData.getData('text/html') ||
    ''
  );
}

function webflowSummaryMessage(summary: ImportSummary): string {
  const parts = [
    plural(summary.layers, 'layer'),
    summary.styles > 0 ? plural(summary.styles, 'style') : '',
    summary.components > 0 ? plural(summary.components, 'component') : '',
    summary.assets > 0 ? plural(summary.assets, 'image') : '',
    summary.fonts > 0 ? plural(summary.fonts, 'font') : '',
  ].filter(Boolean);
  return `Imported ${parts.join(', ')}`;
}

export function useImportPaste({
  enabled,
  insertLayers,
  onNormalPaste,
}: UseImportPasteOptions) {
  const router = useRouter();
  // Guards against a second paste landing while an import is still running.
  const isProcessingRef = useRef(false);

  /** Point the user at the Webflow Design settings to connect a published site. */
  const openWebflowSettings = useCallback(() => {
    router.push('/ycode/integrations/apps?app=webflow');
  }, [router]);

  const importWebflow = useCallback(async (text: string, placement?: ExternalPastePlacement) => {
    isProcessingRef.current = true;
    const toastId = toast.loading('Pasting from Webflow…');
    try {
      const { css, reason } = await loadSiteStylesheetCss();

      // Require a connected published site before the first paste. Without the
      // global stylesheet the paste would create bare, unstyled layer styles
      // (no colours, fonts or var resolution), and a later re-paste can't
      // upgrade those in place — it only spawns suffixed duplicates. So we stop
      // here and send the user to connect their site first.
      if (reason === 'no-site') {
        toast.error('Connect your Webflow site to paste', {
          id: toastId,
          description:
            'Add your published site URL under Webflow → Design so pasted designs include global styles, colours and fonts.',
          action: { label: 'Connect', onClick: openWebflowSettings },
          duration: 10_000,
        });
        return;
      }

      const globalStyles = css ? parseGlobalStylesheet(css) : undefined;
      const document = parseWebflowClipboard(text, globalStyles);
      if (!document) {
        toast.error('Could not read the Webflow selection', { id: toastId });
        return;
      }

      // Stream "n of total layers" into the loading toast, throttled so large
      // pastes don't re-render on every node.
      let lastProgressAt = 0;
      const onProgress = (done: number, total: number) => {
        const now = performance.now();
        if (done < total && now - lastProgressAt < 80) return;
        lastProgressAt = now;
        toast.loading('Pasting from Webflow…', {
          id: toastId,
          description: `Building layer ${done} of ${total}`,
        });
      };

      const { layers, summary } = await buildImport(document, { onProgress });

      if (layers.length === 0) {
        toast.error('No layers found in the Webflow selection', { id: toastId });
        return;
      }

      insertLayers(layers, placement);

      toast.success(webflowSummaryMessage(summary), { id: toastId });

      // Collections can't be auto-connected on paste — they live in your CMS.
      // Point the user at the migration flow rather than leaving placeholders.
      if (summary.collections > 0) {
        toast.message(
          `This paste includes ${plural(summary.collections, 'collection')}`,
          {
            description: 'Import them under Webflow → CMS to connect your content.',
            action: { label: 'Open Webflow', onClick: openWebflowSettings },
            duration: 10_000,
          },
        );
      }
    } catch (error) {
      console.error('[useImportPaste] Webflow import failed:', error);
      toast.error('Failed to import from Webflow', {
        id: toastId,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [insertLayers, openWebflowSettings]);

  const importFigma = useCallback(async (payload: YcodeFigmaPayload, placement?: ExternalPastePlacement) => {
    isProcessingRef.current = true;
    const toastId = toast.loading('Pasting from Figma…');
    try {
      const { convertFigmaToLayers, extractFontFamilies } = await import('@/lib/figma/converter');
      const { FigmaMaterializer } = await import('@/lib/figma/materializer');
      const { figmaDebug, figmaDebugStash } = await import('@/lib/figma/debug');

      // Stash the payload so a failed import can be inspected via
      // window.__ycodeFigmaLastPayload in the console.
      figmaDebugStash('LastPayload', payload);
      figmaDebug('payload received', { bytes: JSON.stringify(payload).length });

      // Resolve fonts first so the converter only assigns families it can
      // actually render. Unresolvable fonts are reported back to the user.
      const fontFamilies = extractFontFamilies(payload);
      let fonts: FontResolution = { available: new Set(), installed: [], unavailable: [] };
      if (fontFamilies.length > 0) {
        try {
          fonts = await resolveFonts(fontFamilies);
        } catch (err) {
          console.warn('[useImportPaste] font resolution error:', err);
        }
      }

      const materializer = new FigmaMaterializer();
      const layers = await convertFigmaToLayers(payload, materializer, fonts.available);

      if (layers.length === 0) {
        toast.error('No valid layers found in Figma data', { id: toastId });
        return;
      }

      insertLayers(layers, placement);

      const { summary } = materializer;
      const detailParts: string[] = [];
      if (summary.components > 0) detailParts.push(plural(summary.components, 'component'));
      if (summary.layerStyles > 0) detailParts.push(plural(summary.layerStyles, 'style'));
      if (summary.colorVariables > 0) detailParts.push(plural(summary.colorVariables, 'color variable'));
      if (fonts.installed.length > 0) detailParts.push(plural(fonts.installed.length, 'font'));

      toast.success('Imported from Figma', {
        id: toastId,
        description: detailParts.length > 0 ? `Created ${detailParts.join(' · ')}` : undefined,
      });

      // Tell the user about fonts we couldn't resolve so they know why some
      // text uses the default font and can upload/replace them if needed.
      if (fonts.unavailable.length > 0) {
        const names = fonts.unavailable.join(', ');
        toast.warning(
          `Using default font for ${plural(fonts.unavailable.length, 'unavailable font')}`,
          {
            description: `Not on Google Fonts: ${names}. Upload them under Fonts to match the design.`,
          },
        );
      }
    } catch (error) {
      console.error('Figma import failed:', error);
      toast.error('Failed to import from Figma', {
        id: toastId,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [insertLayers]);

  // Imperative entry point for the layer context menu's "Paste after / inside".
  // Re-reads the OS clipboard (the menu only knew a payload *existed*) and
  // imports it at the chosen placement.
  const pasteExternalAt = useCallback(async (placement: ExternalPastePlacement) => {
    if (isProcessingRef.current) {
      toast.message('Still pasting the previous selection…');
      return;
    }
    const data = await readExternalDesignClipboard();
    if (!data) {
      toast.error('No Figma or Webflow content found on the clipboard');
      return;
    }
    if (data.kind === 'webflow') {
      void importWebflow(data.text, placement);
      return;
    }
    // Figma: rebuild a DataTransfer-like shim so the shared extractor applies.
    const shim = {
      getData: (type: string) =>
        type === 'text/html' ? data.html : type === 'text/plain' ? data.text : '',
    } as unknown as DataTransfer;
    const figma = extractFigmaPayload(shim);
    if (figma && figma !== 'truncated') {
      void importFigma(figma, placement);
    } else {
      toast.error('Figma data was incomplete', {
        description: 'Try copying the frames again from Figma.',
      });
    }
  }, [importWebflow, importFigma]);

  // Expose the runner so the context menu (a different subtree) can trigger a
  // positional external paste.
  useEffect(() => {
    if (!enabled) return;
    const store = useExternalPasteStore.getState();
    store.setPasteAt(pasteExternalAt);
    return () => useExternalPasteStore.getState().setPasteAt(null);
  }, [enabled, pasteExternalAt]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (!enabled || !e.clipboardData) return;

    // Don't hijack pastes into editable fields (inputs, text editor, etc.).
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }

    // 0. Internal Ycode copy/cut — the layer lives in the clipboard store, and
    // the OS clipboard only carries our marker (which overwrote any stale
    // Webflow/Figma payload). Route straight to the normal internal paste.
    const text = readClipboardText(e.clipboardData);
    if (text.trim() === YCODE_LAYER_CLIPBOARD_SIGNATURE) {
      e.preventDefault();
      e.stopPropagation();
      if (!isProcessingRef.current) onNormalPaste();
      return;
    }

    // 1. Webflow XSCP payload.
    if (text && isWebflowClipboard(text)) {
      e.preventDefault();
      e.stopPropagation();
      if (isProcessingRef.current) {
        toast.message('Still pasting the previous selection…');
        return;
      }
      void importWebflow(text);
      return;
    }

    // 2. Figma plugin payload.
    const figma = extractFigmaPayload(e.clipboardData);
    if (figma === 'truncated') {
      e.preventDefault();
      console.error('[useImportPaste] Figma payload present but unparseable (likely truncated/too large)');
      toast.error('Figma data was incomplete', {
        description: 'The selection may be too large to copy. Try copying a smaller section or fewer frames.',
      });
      return;
    }
    if (figma) {
      e.preventDefault();
      e.stopPropagation();
      if (isProcessingRef.current) {
        toast.message('Still importing the previous selection…');
        return;
      }
      void importFigma(figma);
      return;
    }

    // 3. Normal Ycode internal paste.
    e.preventDefault();
    if (!isProcessingRef.current) onNormalPaste();
  }, [enabled, importWebflow, importFigma, onNormalPaste]);

  useEffect(() => {
    if (!enabled) return;

    // Track documents we've already wired up so we don't double-bind.
    const bound = new WeakSet<Document>();
    const listener = handlePaste as EventListener;

    const bind = (doc: Document | null | undefined) => {
      if (!doc || bound.has(doc)) return;
      bound.add(doc);
      // Capture phase so we claim the event before canvas/editor handlers.
      doc.addEventListener('paste', listener, true);
    };

    bind(document);

    // Same-origin iframe documents (the canvas). Re-scan periodically and on
    // load so we cover late-mounting and reloading iframes.
    const bindIframes = () => {
      document.querySelectorAll('iframe').forEach((iframe) => {
        try {
          bind(iframe.contentDocument);
        } catch {
          /* cross-origin — not accessible, skip */
        }
        iframe.addEventListener('load', () => {
          try {
            bind(iframe.contentDocument);
          } catch {
            /* cross-origin */
          }
        });
      });
    };

    bindIframes();
    const interval = window.setInterval(bindIframes, 1500);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('paste', listener, true);
      document.querySelectorAll('iframe').forEach((iframe) => {
        try {
          iframe.contentDocument?.removeEventListener('paste', listener, true);
        } catch {
          /* cross-origin */
        }
      });
    };
  }, [enabled, handlePaste]);
}
