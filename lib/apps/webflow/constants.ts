/**
 * Shared constants for the Webflow integration.
 *
 * Centralises the app id and the `app_settings` keys so the client, settings UI
 * and paste importer agree on the contract — a typo here would silently break
 * token auth or global-style backfill rather than fail loudly.
 */

export const WEBFLOW_APP_ID = 'webflow';

export const WEBFLOW_SETTINGS = {
  /** Webflow Data API token (scopes: sites:read, cms:read). */
  apiToken: 'api_token',
  /** Published site URL used to discover the global stylesheet on paste. */
  publishedUrl: 'published_url',
} as const;
