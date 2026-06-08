/**
 * Static export — page resolution.
 *
 * Yields one `ResolvedPage` per route a source page produces:
 *   - static page  → 1
 *   - error page   → 1 (default locale only)
 *   - homepage     → 1 per locale
 *   - dynamic page → N, one per published collection item
 */

import {
  fetchHomepage,
  fetchErrorPage,
  fetchPageByPath,
} from '@/lib/page-fetcher'
import type { PageData } from '@/lib/page-fetcher'
import { buildSlugPath, buildLocalizedSlugPath } from '@/lib/page-utils'
import { getTranslatableKey } from '@/lib/locale-runtime'
import { getValuesByFieldId } from '@/lib/repositories/collectionItemValueRepository'

import type { Locale, Page, PageFolder, Translation } from '@/types'

import {
  collectInteractions,
  getBodyClasses,
  layerTreeContains,
  renderPageBody,
  type ExportedInteraction,
} from './document'
import { computeOutputKey } from './paths'

export interface ResolvedPage {
  page: Page
  bodyHtml: string
  /** Class string from the synthetic `body` layer (background, text color, fonts). */
  bodyClasses: string
  /** BCP-47 language code derived from the active locale. */
  lang: string
  outputKey: string
  hasSlider: boolean
  interactions: ExportedInteraction[]
}

interface PageCmsSettings {
  collection_id?: string
  slug_field_id?: string
}

export interface LocaleContext {
  /** Active locale (null = default). */
  locale: Locale | null
  /** Translations for the active locale (empty for default). */
  translations: Record<string, Translation>
}

/**
 * Build the `Record<key, Translation>` shape `buildLocalizedSlugPath` expects.
 */
export function buildTranslationsMap(translations: Translation[]): Record<string, Translation> {
  const map: Record<string, Translation> = {}
  for (const t of translations) {
    const key = getTranslatableKey({
      source_type: t.source_type,
      source_id: t.source_id,
      content_key: t.content_key,
    })
    map[key] = t
  }
  return map
}

export async function* resolvePages(
  page: Page,
  folders: PageFolder[],
  pages: Page[],
  ctx: LocaleContext,
): AsyncGenerator<ResolvedPage> {
  const isDefaultLocale = !ctx.locale || ctx.locale.is_default
  const localePrefix = isDefaultLocale ? '' : `${ctx.locale!.code}/`

  // --- Error pages (default locale only) ------------------------------------
  if (page.error_page !== null && page.error_page !== undefined) {
    if (!isDefaultLocale) return
    const data = (await fetchErrorPage(page.error_page, true)) as PageData | null
    if (data) {
      const resolved = renderResolved(data.page, data, folders, pages, `${page.error_page}.html`, ctx)
      if (resolved) yield resolved
    }
    return
  }

  // --- Homepage -------------------------------------------------------------
  if (page.is_index && page.page_folder_id === null) {
    let data: PageData | null
    let outputKey: string
    if (isDefaultLocale) {
      data = (await fetchHomepage(true)) as PageData | null
      outputKey = 'index.html'
    } else {
      data = await fetchPageByPath(ctx.locale!.code, true)
      outputKey = `${localePrefix}index.html`
    }
    if (data) {
      const resolved = renderResolved(data.page, data, folders, pages, outputKey, ctx)
      if (resolved) yield resolved
    }
    return
  }

  // --- Dynamic CMS pages ---------------------------------------------------
  if (page.is_dynamic) {
    if (!isDefaultLocale) return
    const cms = (page.settings as { cms?: PageCmsSettings } | undefined)?.cms
    if (!cms?.collection_id || !cms.slug_field_id) {
      console.warn(`[Static Export] Dynamic page "${page.name}" has no CMS config — skipping`)
      return
    }
    const slugValues = await getValuesByFieldId(cms.slug_field_id, true)
    if (slugValues.length === 0) {
      console.warn(`[Static Export] Dynamic page "${page.name}" has no published items — skipping`)
      return
    }
    for (const row of slugValues) {
      const itemSlug = typeof row.value === 'string' ? row.value : String(row.value ?? '')
      if (!itemSlug) continue
      const pattern = buildSlugPath(page, folders, 'page', '{slug}')
      const slugPath = pattern.replace(/\{slug\}/g, itemSlug).replace(/^\/+/, '')
      const data = await fetchPageByPath(slugPath, true)
      if (!data?.pageLayers?.layers) {
        console.warn(`[Static Export] Could not resolve "${page.name}" item "${itemSlug}"`)
        continue
      }
      const outputKey = `${slugPath}/index.html`
      const resolved = renderResolved(data.page, data, folders, pages, outputKey, ctx)
      if (resolved) yield resolved
    }
    return
  }

  // --- Static pages --------------------------------------------------------
  const localizedPath = isDefaultLocale
    ? buildSlugPath(page, folders, 'page')
    : buildLocalizedSlugPath(page, folders, 'page', ctx.locale, ctx.translations)
  const slugPath = localizedPath.replace(/^\/+/, '')
  const data = await fetchPageByPath(slugPath, true)
  if (!data?.pageLayers?.layers) return
  const outputKey = isDefaultLocale
    ? computeOutputKey(page, folders)
    : (slugPath ? `${slugPath}/index.html` : `${localePrefix}index.html`)
  const resolved = renderResolved(data.page, data, folders, pages, outputKey, ctx)
  if (resolved) yield resolved
}

function renderResolved(
  page: Page,
  data: PageData,
  folders: PageFolder[],
  pages: Page[],
  outputKey: string,
  ctx: LocaleContext,
): ResolvedPage | null {
  if (!data.pageLayers?.layers) return null
  const layers = data.pageLayers.layers
  const bodyHtml = renderPageBody(layers, {
    pages,
    folders,
    components: data.components,
    locale: data.locale ?? ctx.locale ?? null,
    translations: data.translations ?? ctx.translations,
    pageId: page.id,
  })
  return {
    page,
    bodyHtml,
    bodyClasses: getBodyClasses(layers),
    lang: ctx.locale?.code ?? 'en',
    outputKey,
    hasSlider: layerTreeContains(layers, 'slider'),
    interactions: collectInteractions(layers),
  }
}
