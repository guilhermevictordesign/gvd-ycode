'use client';

/**
 * Session cache for the connected site's global stylesheet (raw CSS).
 *
 * Every Webflow paste needs the site's global styles to backfill colours,
 * headings and fonts. Re-fetching the published page + CSS on every paste is
 * wasteful in the common "paste, paste, paste" loop, so we cache the fetched
 * CSS per site URL for a short TTL. Parsing is left to the caller so this module
 * stays free of import-pipeline dependencies.
 *
 * Staleness is bounded deliberately: the entry expires after `TTL_MS`, is
 * cleared whenever the Design URL is saved (see `clearStylesheetCache`), and is
 * gone on reload. A Webflow republish also produces a new fingerprinted CSS URL,
 * so re-discovery after the TTL picks up the change.
 */

import { webflowApi } from './client';
import { WEBFLOW_SETTINGS } from './constants';

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  css: string | undefined;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Outcome of resolving the connected site's stylesheet.
 *
 * `reason` lets the paste handler tell apart "the user never connected a site"
 * (offer to connect one) from "we tried but the fetch failed" (don't nag — it's
 * likely transient), while both still let the paste proceed without backfill.
 */
export interface StylesheetResult {
  css?: string;
  reason?: 'no-site' | 'failed';
}

/** Drop cached stylesheets — call when the connected site URL changes. */
export function clearStylesheetCache(): void {
  cache.clear();
}

/**
 * Resolve the connected site's global stylesheet CSS (cached).
 *
 * Never throws — paste still works without global-style backfill. When no CSS
 * is returned, `reason` explains why so the caller can decide whether to hint.
 */
export async function loadSiteStylesheetCss(): Promise<StylesheetResult> {
  try {
    const settings = await webflowApi
      .getSettings()
      .catch(() => ({} as Record<string, string>));
    const site = settings?.[WEBFLOW_SETTINGS.publishedUrl]?.trim();
    if (!site) return { reason: 'no-site' };

    const hit = cache.get(site);
    if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
      return hit.css ? { css: hit.css } : { reason: 'failed' };
    }

    const { css } = await webflowApi.resolveStylesheet(site);
    // Cache even an empty result so a misconfigured URL doesn't refetch on
    // every paste within the TTL window.
    cache.set(site, { css, fetchedAt: Date.now() });
    return css ? { css } : { reason: 'failed' };
  } catch (error) {
    console.warn('[webflow] global stylesheet load failed:', error);
    return { reason: 'failed' };
  }
}
