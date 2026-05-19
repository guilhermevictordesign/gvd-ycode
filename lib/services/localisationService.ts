/**
 * Localisation Publishing Service
 * Handles publishing of locales and translations
 *
 * Returns precise change diffs and a pre-upsert slug snapshot so the publish
 * route can compute exact locale-scoped cache invalidation, including the
 * OLD URL when a slug or locale code is renamed.
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import type { Locale, Translation, TranslationSourceType } from '@/types';

export interface ChangedLocale {
  id: string;
  oldCode: string | null;       // null = newly added
  newCode: string | null;       // null = removed (soft-deleted)
  oldIsDefault: boolean | null;
  newIsDefault: boolean | null;
}

export interface ChangedTranslation {
  locale_id: string;
  source_type: TranslationSourceType;
  source_id: string;
  content_key: string;
  oldValue: string | null;      // null = newly added
  newValue: string | null;      // null = removed (soft-deleted)
}

/**
 * Snapshot of pre-upsert locale/slug state. Lets us reconstruct OLD URLs
 * for changed locale codes and slug-rename translations without trying to
 * read them out of the database after they've been overwritten.
 */
export interface SlugSnapshot {
  /** Pre-upsert published locale state, keyed by locale id. */
  localesById: Map<string, { code: string; is_default: boolean }>;
  /** Pre-upsert published folder slug translations: locale_id → folder_id → slug. */
  folderSlugsByLocale: Map<string, Map<string, string>>;
  /** Pre-upsert published page slug translations: locale_id → page_id → slug. */
  pageSlugsByLocale: Map<string, Map<string, string>>;
  /** Pre-upsert published CMS item slug translations: locale_id → item_id → slug. */
  cmsSlugsByLocale: Map<string, Map<string, string>>;
}

export interface PublishLocalisationResult {
  locales: number;
  translations: number;
  changedLocales: ChangedLocale[];
  changedTranslations: ChangedTranslation[];
  slugSnapshot: SlugSnapshot;
  timing: {
    localesDurationMs: number;
    translationsDurationMs: number;
  };
}

/**
 * Compare a draft row to its currently-published counterpart and return
 * true if any field that affects rendering or URLs has changed.
 *
 * Ignores `updated_at` and `created_at` (timestamps don't drive renders).
 */
function localeDiffers(draft: Locale, published: Locale): boolean {
  return (
    draft.code !== published.code ||
    draft.is_default !== published.is_default ||
    Boolean(draft.deleted_at) !== Boolean(published.deleted_at)
  );
}

function translationDiffers(draft: Translation, published: Translation): boolean {
  return (
    draft.content_value !== published.content_value ||
    draft.is_completed !== published.is_completed ||
    Boolean(draft.deleted_at) !== Boolean(published.deleted_at)
  );
}

/**
 * Build the pre-upsert slug snapshot from the currently-published rows.
 * Captures only slug-bearing translation rows (`source:slug` and
 * `cms:field:key:slug`) because those are the only ones that affect URLs.
 */
function buildSlugSnapshot(
  publishedLocales: Locale[],
  publishedTranslations: Translation[],
): SlugSnapshot {
  const localesById = new Map<string, { code: string; is_default: boolean }>();
  for (const l of publishedLocales) {
    if (l.deleted_at) continue;
    localesById.set(l.id, { code: l.code, is_default: l.is_default });
  }

  const folderSlugsByLocale = new Map<string, Map<string, string>>();
  const pageSlugsByLocale = new Map<string, Map<string, string>>();
  const cmsSlugsByLocale = new Map<string, Map<string, string>>();

  for (const t of publishedTranslations) {
    if (t.deleted_at) continue;
    const isPageSlug = t.source_type === 'page' && t.content_key === 'slug';
    const isFolderSlug = t.source_type === 'folder' && t.content_key === 'slug';
    const isCmsSlug = t.source_type === 'cms' && t.content_key === 'field:key:slug';
    if (!isPageSlug && !isFolderSlug && !isCmsSlug) continue;

    const target = isFolderSlug
      ? folderSlugsByLocale
      : isPageSlug
        ? pageSlugsByLocale
        : cmsSlugsByLocale;

    if (!target.has(t.locale_id)) target.set(t.locale_id, new Map());
    target.get(t.locale_id)!.set(t.source_id, t.content_value);
  }

  return { localesById, folderSlugsByLocale, pageSlugsByLocale, cmsSlugsByLocale };
}

/**
 * Publish all draft locales and translations.
 *
 * Computes exact `changedLocales` / `changedTranslations` diffs by comparing
 * each draft row to its currently-published counterpart BEFORE the upsert.
 * Returns those diffs plus a `slugSnapshot` of pre-upsert published state so
 * downstream cache invalidation can reconstruct OLD URLs for slug renames.
 */
export async function publishLocalisation(): Promise<PublishLocalisationResult> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const deletedAt = new Date().toISOString();
  let publishedLocalesCount = 0;
  let publishedTranslationsCount = 0;
  let localesDurationMs = 0;
  let translationsDurationMs = 0;
  const changedLocales: ChangedLocale[] = [];
  const changedTranslations: ChangedTranslation[] = [];

  // ──────────────────────────────────────────────────────────────────────
  // SNAPSHOT: Capture all currently-published locales and translations
  // BEFORE any upsert. This is what we'll diff against and what
  // `buildSlugSnapshot` reads to compute OLD URLs for slug renames.
  // ──────────────────────────────────────────────────────────────────────

  const [
    { data: existingPublishedLocalesRaw },
    { data: existingPublishedTranslationsRaw },
  ] = await Promise.all([
    client.from('locales').select('*').eq('is_published', true),
    client.from('translations').select('*').eq('is_published', true),
  ]);

  const existingPublishedLocales: Locale[] = existingPublishedLocalesRaw || [];
  const existingPublishedTranslations: Translation[] = existingPublishedTranslationsRaw || [];

  const publishedLocalesById = new Map<string, Locale>();
  for (const l of existingPublishedLocales) publishedLocalesById.set(l.id, l);

  const publishedTranslationsById = new Map<string, Translation>();
  for (const t of existingPublishedTranslations) publishedTranslationsById.set(t.id, t);

  const slugSnapshot = buildSlugSnapshot(existingPublishedLocales, existingPublishedTranslations);

  // === LOCALES ===
  const localesStart = performance.now();

  // Step 1: Fetch all draft locales (including soft-deleted)
  const { data: allDraftLocales, error: localesError } = await client
    .from('locales')
    .select('*')
    .eq('is_published', false);

  if (localesError) {
    throw new Error(`Failed to fetch draft locales: ${localesError.message}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // DIFF: Compare each draft locale to its published counterpart.
  // ──────────────────────────────────────────────────────────────────────
  if (allDraftLocales) {
    for (const draft of allDraftLocales as Locale[]) {
      const published = publishedLocalesById.get(draft.id);

      if (!published || published.deleted_at) {
        // Newly added (or undeleted) — only counts as a change if the
        // draft itself isn't soft-deleted.
        if (!draft.deleted_at) {
          changedLocales.push({
            id: draft.id,
            oldCode: null,
            newCode: draft.code,
            oldIsDefault: null,
            newIsDefault: draft.is_default,
          });
        }
        continue;
      }

      if (draft.deleted_at) {
        // Soft-deleted in draft → will be removed from published.
        changedLocales.push({
          id: draft.id,
          oldCode: published.code,
          newCode: null,
          oldIsDefault: published.is_default,
          newIsDefault: null,
        });
        continue;
      }

      if (localeDiffers(draft, published)) {
        changedLocales.push({
          id: draft.id,
          oldCode: published.code,
          newCode: draft.code,
          oldIsDefault: published.is_default,
          newIsDefault: draft.is_default,
        });
      }
    }
  }

  if (allDraftLocales && allDraftLocales.length > 0) {
    const activeDraftLocales = allDraftLocales.filter((l: Locale) => l.deleted_at === null);
    const softDeletedDraftLocales = allDraftLocales.filter((l: Locale) => l.deleted_at !== null);

    // Step 2: Soft-delete published versions of soft-deleted draft locales (single query)
    if (softDeletedDraftLocales.length > 0) {
      const localeIds = softDeletedDraftLocales.map((locale: Locale) => locale.id);
      const { error: deleteLocalesError } = await client
        .from('locales')
        .update({ deleted_at: deletedAt })
        .in('id', localeIds)
        .eq('is_published', true)
        .is('deleted_at', null);

      if (deleteLocalesError) {
        throw new Error(`Failed to soft-delete locales: ${deleteLocalesError.message}`);
      }
    }

    // Step 3: Upsert published locales
    if (activeDraftLocales.length > 0) {
      const publishedLocales = activeDraftLocales.map((locale: Locale) => ({
        id: locale.id,
        code: locale.code,
        label: locale.label,
        is_default: locale.is_default,
        is_published: true,
        created_at: locale.created_at,
        updated_at: locale.updated_at,
        deleted_at: null,
      }));

      const { error: upsertError } = await client
        .from('locales')
        .upsert(publishedLocales, {
          onConflict: 'id,is_published',
        });

      if (upsertError) {
        throw new Error(`Failed to upsert published locales: ${upsertError.message}`);
      }

      publishedLocalesCount = activeDraftLocales.length;
    }
  }

  localesDurationMs = Math.round(performance.now() - localesStart);

  // === TRANSLATIONS ===
  const translationsStart = performance.now();

  // Step 4: Fetch all draft translations (including soft-deleted)
  const { data: allDraftTranslations, error: translationsError } = await client
    .from('translations')
    .select('*')
    .eq('is_published', false);

  if (translationsError) {
    throw new Error(`Failed to fetch draft translations: ${translationsError.message}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // DIFF: Compare each draft translation to its published counterpart.
  // ──────────────────────────────────────────────────────────────────────
  if (allDraftTranslations) {
    for (const draft of allDraftTranslations as Translation[]) {
      const published = publishedTranslationsById.get(draft.id);

      if (!published || published.deleted_at) {
        if (!draft.deleted_at) {
          changedTranslations.push({
            locale_id: draft.locale_id,
            source_type: draft.source_type,
            source_id: draft.source_id,
            content_key: draft.content_key,
            oldValue: null,
            newValue: draft.content_value,
          });
        }
        continue;
      }

      if (draft.deleted_at) {
        changedTranslations.push({
          locale_id: published.locale_id,
          source_type: published.source_type,
          source_id: published.source_id,
          content_key: published.content_key,
          oldValue: published.content_value,
          newValue: null,
        });
        continue;
      }

      if (translationDiffers(draft, published)) {
        changedTranslations.push({
          locale_id: draft.locale_id,
          source_type: draft.source_type,
          source_id: draft.source_id,
          content_key: draft.content_key,
          oldValue: published.content_value,
          newValue: draft.content_value,
        });
      }
    }
  }

  if (allDraftTranslations && allDraftTranslations.length > 0) {
    const activeDraftTranslations = allDraftTranslations.filter((t: Translation) => t.deleted_at === null);
    const softDeletedDraftTranslations = allDraftTranslations.filter((t: Translation) => t.deleted_at !== null);

    // Step 5: Soft-delete published versions of soft-deleted draft translations (single query)
    if (softDeletedDraftTranslations.length > 0) {
      const translationIds = softDeletedDraftTranslations.map((translation: Translation) => translation.id);
      const { error: deleteTranslationsError } = await client
        .from('translations')
        .update({ deleted_at: deletedAt })
        .in('id', translationIds)
        .eq('is_published', true)
        .is('deleted_at', null);

      if (deleteTranslationsError) {
        throw new Error(`Failed to soft-delete translations: ${deleteTranslationsError.message}`);
      }
    }

    // Step 6: Upsert published translations
    if (activeDraftTranslations.length > 0) {
      const publishedTranslations = activeDraftTranslations.map((translation: Translation) => ({
        id: translation.id,
        locale_id: translation.locale_id,
        source_type: translation.source_type,
        source_id: translation.source_id,
        content_key: translation.content_key,
        content_type: translation.content_type,
        content_value: translation.content_value,
        is_completed: translation.is_completed,
        is_published: true,
        created_at: translation.created_at,
        updated_at: translation.updated_at,
        deleted_at: null,
      }));

      const { error: upsertError } = await client
        .from('translations')
        .upsert(publishedTranslations, {
          onConflict: 'id,is_published',
        });

      if (upsertError) {
        throw new Error(`Failed to upsert published translations: ${upsertError.message}`);
      }

      publishedTranslationsCount = activeDraftTranslations.length;
    }
  }

  translationsDurationMs = Math.round(performance.now() - translationsStart);

  return {
    locales: publishedLocalesCount,
    translations: publishedTranslationsCount,
    changedLocales,
    changedTranslations,
    slugSnapshot,
    timing: {
      localesDurationMs,
      translationsDurationMs,
    },
  };
}
