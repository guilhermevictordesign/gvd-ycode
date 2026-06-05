'use client';

/**
 * Opt-in debug logging for the Figma import pipeline.
 *
 * Enable from the browser console with either:
 *   localStorage.setItem('ycode:figma-debug', '1')   // persists across reloads
 *   window.__ycodeFigmaDebug = true                  // current session only
 *
 * When enabled, the import logs each phase + timing, and the last parsed
 * payload is stashed on `window.__ycodeFigmaLastPayload` for inspection.
 */

const FLAG_KEY = 'ycode:figma-debug';

export function figmaDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if ((window as unknown as { __ycodeFigmaDebug?: boolean }).__ycodeFigmaDebug === true) return true;
    return window.localStorage?.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function figmaDebug(...args: unknown[]): void {
  if (figmaDebugEnabled()) console.log('[FigmaPaste]', ...args);
}

/** Stash a value on `window` for post-mortem inspection (always, cheap). */
export function figmaDebugStash(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    (window as unknown as Record<string, unknown>)[`__ycodeFigma${key}`] = value;
  } catch {
    /* ignore */
  }
}
