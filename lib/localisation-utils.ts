import type { Layer, Page, Translation, Locale, LocaleOption, CollectionField } from '@/types';
import { getLayerIcon, getLayerName } from '@/lib/layer-display-utils';
import {
  buildLayerTranslationKey,
  getTranslationByKey,
  hasValidTranslationValue,
  getTranslationValue,
} from '@/lib/locale-runtime';
import { createDynamicTextVariable, createDynamicRichTextVariable, createDynamicRichTextVariableFromPlainText, createAssetVariable } from '@/lib/variable-utils';
import { castValue } from '@/lib/collection-utils';
import { tiptapDocHasFormatting, tiptapDocToCanonicalString, hasVariableNode, hasAnyTextOrVariable } from '@/lib/tiptap-utils';
import { isRichTextLayer } from '@/lib/layer-utils';
import { looksLikeFormattedHtml } from '@/lib/translation-classification';
import type { IconProps } from '@/components/ui/icon';

// Re-exports for back-compat — runtime translation helpers now live in
// `lib/locale-runtime.ts` (template-free) so the public renderer can import
// them without dragging in the builder-only translatable-item extractors.
export {
  getTranslatableKey,
  buildLayerTranslationKey,
  getTranslationByKey,
  hasValidTranslationValue,
  getTranslationValue,
  getTranslatedAssetId,
  getTranslatedText,
} from '@/lib/locale-runtime';

/**
 * Supported locales with their metadata (ISO 639-1 codes)
 * Sorted alphabetically by english label
 */
export const LOCALES: LocaleOption[] = [
  { code: 'ab', label: 'Abkhaz', native_label: 'аҧсуа' },
  { code: 'aa', label: 'Afar', native_label: 'Afaraf' },
  { code: 'af', label: 'Afrikaans', native_label: 'Afrikaans' },
  { code: 'ak', label: 'Akan', native_label: 'Akan' },
  { code: 'sq', label: 'Albanian', native_label: 'Shqip' },
  { code: 'am', label: 'Amharic', native_label: 'አማርኛ' },
  { code: 'ar', label: 'Arabic', native_label: 'العربية', rtl: true },
  { code: 'ar-eg', label: 'Arabic (Egypt)', native_label: 'العربية (مصر)', rtl: true },
  { code: 'ar-lb', label: 'Arabic (Lebanon)', native_label: 'العربية (لبنان)', rtl: true },
  { code: 'ar-ma', label: 'Arabic (Morocco)', native_label: 'العربية (المغرب)', rtl: true },
  { code: 'ar-sa', label: 'Arabic (Saudi Arabia)', native_label: 'العربية (السعودية)', rtl: true },
  { code: 'an', label: 'Aragonese', native_label: 'Aragonés' },
  { code: 'hy', label: 'Armenian', native_label: 'Հայերեն' },
  { code: 'as', label: 'Assamese', native_label: 'অসমীয়া' },
  { code: 'av', label: 'Avaric', native_label: 'авар мацӀ' },
  { code: 'ae', label: 'Avestan', native_label: 'avesta' },
  { code: 'ay', label: 'Aymara', native_label: 'aymar aru' },
  { code: 'az', label: 'Azerbaijani', native_label: 'azərbaycan dili' },
  { code: 'bm', label: 'Bambara', native_label: 'bamanankan' },
  { code: 'ba', label: 'Bashkir', native_label: 'башҡорт теле' },
  { code: 'eu', label: 'Basque', native_label: 'Euskara' },
  { code: 'be', label: 'Belarusian', native_label: 'Беларуская' },
  { code: 'bn', label: 'Bengali', native_label: 'বাংলা' },
  { code: 'bh', label: 'Bihari', native_label: 'भोजपुरी' },
  { code: 'bi', label: 'Bislama', native_label: 'Bislama' },
  { code: 'bs', label: 'Bosnian', native_label: 'Bosanski' },
  { code: 'br', label: 'Breton', native_label: 'Brezhoneg' },
  { code: 'bg', label: 'Bulgarian', native_label: 'Български' },
  { code: 'my', label: 'Burmese', native_label: 'ဗမာစာ' },
  { code: 'ca', label: 'Catalan', native_label: 'Català' },
  { code: 'ch', label: 'Chamorro', native_label: 'Chamoru' },
  { code: 'ce', label: 'Chechen', native_label: 'нохчийн мотт' },
  { code: 'ny', label: 'Chichewa', native_label: 'chiCheŵa' },
  { code: 'zh', label: 'Chinese', native_label: '中文' },
  { code: 'zh-hk', label: 'Chinese (Hong Kong)', native_label: '繁體中文 (香港)' },
  { code: 'zh-cn', label: 'Chinese (Simplified)', native_label: '简体中文' },
  { code: 'zh-tw', label: 'Chinese (Traditional)', native_label: '繁體中文 (台灣)' },
  { code: 'cv', label: 'Chuvash', native_label: 'чӑваш чӗлхи' },
  { code: 'kw', label: 'Cornish', native_label: 'Kernewek' },
  { code: 'co', label: 'Corsican', native_label: 'Lingua corsa' },
  { code: 'cr', label: 'Cree', native_label: 'ᓀᐦᐃᔭᐍᐏᐣ' },
  { code: 'hr', label: 'Croatian', native_label: 'Hrvatski' },
  { code: 'cs', label: 'Czech', native_label: 'Čeština' },
  { code: 'da', label: 'Danish', native_label: 'Dansk' },
  { code: 'dv', label: 'Divehi', native_label: 'ދިވެހި', rtl: true },
  { code: 'nl', label: 'Dutch', native_label: 'Nederlands' },
  { code: 'en', label: 'English', native_label: 'English' },
  { code: 'en-au', label: 'English (Australia)', native_label: 'English (Australia)' },
  { code: 'en-ca', label: 'English (Canada)', native_label: 'English (Canada)' },
  { code: 'en-in', label: 'English (India)', native_label: 'English (India)' },
  { code: 'en-nz', label: 'English (New Zealand)', native_label: 'English (New Zealand)' },
  { code: 'en-gb', label: 'English (United Kingdom)', native_label: 'English (United Kingdom)' },
  { code: 'en-us', label: 'English (United States)', native_label: 'English (United States)' },
  { code: 'eo', label: 'Esperanto', native_label: 'Esperanto' },
  { code: 'et', label: 'Estonian', native_label: 'Eesti' },
  { code: 'ee', label: 'Ewe', native_label: 'Eʋegbe' },
  { code: 'fo', label: 'Faroese', native_label: 'føroyskt' },
  { code: 'fj', label: 'Fijian', native_label: 'vosa Vakaviti' },
  { code: 'fi', label: 'Finnish', native_label: 'Suomi' },
  { code: 'fr', label: 'French', native_label: 'Français' },
  { code: 'fr-ca', label: 'French (Canada)', native_label: 'Français (Canada)' },
  { code: 'fr-fr', label: 'French (France)', native_label: 'Français (France)' },
  { code: 'fr-ch', label: 'French (Switzerland)', native_label: 'Français (Suisse)' },
  { code: 'ff', label: 'Fula', native_label: 'Fulfulde' },
  { code: 'gl', label: 'Galician', native_label: 'Galego' },
  { code: 'ka', label: 'Georgian', native_label: 'ქართული' },
  { code: 'de', label: 'German', native_label: 'Deutsch' },
  { code: 'de-at', label: 'German (Austria)', native_label: 'Deutsch (Österreich)' },
  { code: 'de-de', label: 'German (Germany)', native_label: 'Deutsch (Deutschland)' },
  { code: 'de-ch', label: 'German (Switzerland)', native_label: 'Deutsch (Schweiz)' },
  { code: 'el', label: 'Greek', native_label: 'Ελληνικά' },
  { code: 'kl', label: 'Greenlandic', native_label: 'Kalaallisut' },
  { code: 'gn', label: 'Guaraní', native_label: 'Avañeẽ' },
  { code: 'gu', label: 'Gujarati', native_label: 'ગુજરાતી' },
  { code: 'ht', label: 'Haitian Creole', native_label: 'Kreyòl ayisyen' },
  { code: 'ha', label: 'Hausa', native_label: 'Hausa' },
  { code: 'he', label: 'Hebrew', native_label: 'עברית', rtl: true },
  { code: 'hz', label: 'Herero', native_label: 'Otjiherero' },
  { code: 'hi', label: 'Hindi', native_label: 'हिन्दी' },
  { code: 'ho', label: 'Hiri Motu', native_label: 'Hiri Motu' },
  { code: 'hu', label: 'Hungarian', native_label: 'Magyar' },
  { code: 'is', label: 'Icelandic', native_label: 'Íslenska' },
  { code: 'io', label: 'Ido', native_label: 'Ido' },
  { code: 'ig', label: 'Igbo', native_label: 'Asụsụ Igbo' },
  { code: 'id', label: 'Indonesian', native_label: 'Bahasa Indonesia' },
  { code: 'ia', label: 'Interlingua', native_label: 'Interlingua' },
  { code: 'ie', label: 'Interlingue', native_label: 'Interlingue (Occidental)' },
  { code: 'iu', label: 'Inuktitut', native_label: 'ᐃᓄᒃᑎᑐᑦ' },
  { code: 'ik', label: 'Inupiaq', native_label: 'Iñupiaq' },
  { code: 'ga', label: 'Irish', native_label: 'Gaeilge' },
  { code: 'it', label: 'Italian', native_label: 'Italiano' },
  { code: 'ja', label: 'Japanese', native_label: '日本語' },
  { code: 'jv', label: 'Javanese', native_label: 'Basa Jawa' },
  { code: 'kn', label: 'Kannada', native_label: 'ಕನ್ನಡ' },
  { code: 'kr', label: 'Kanuri', native_label: 'Kanuri' },
  { code: 'ks', label: 'Kashmiri', native_label: 'كشميري', rtl: true },
  { code: 'kk', label: 'Kazakh', native_label: 'Қазақ тілі' },
  { code: 'km', label: 'Khmer', native_label: 'ភាសាខ្មែរ' },
  { code: 'ki', label: 'Kikuyu', native_label: 'Gĩkũyũ' },
  { code: 'rw', label: 'Kinyarwanda', native_label: 'Ikinyarwanda' },
  { code: 'rn', label: 'Kirundi', native_label: 'Kirundi' },
  { code: 'kv', label: 'Komi', native_label: 'коми кыв' },
  { code: 'kg', label: 'Kongo', native_label: 'KiKongo' },
  { code: 'ko', label: 'Korean', native_label: '한국어' },
  { code: 'ku', label: 'Kurdish', native_label: 'کوردی', rtl: true },
  { code: 'kj', label: 'Kwanyama', native_label: 'Kuanyama' },
  { code: 'ky', label: 'Kyrgyz', native_label: 'Кыргызча' },
  { code: 'lo', label: 'Lao', native_label: 'ພາສາລາວ' },
  { code: 'la', label: 'Latin', native_label: 'Latina' },
  { code: 'lv', label: 'Latvian', native_label: 'Latviešu' },
  { code: 'li', label: 'Limburgish', native_label: 'Limburgs' },
  { code: 'ln', label: 'Lingala', native_label: 'Lingála' },
  { code: 'lt', label: 'Lithuanian', native_label: 'Lietuvių' },
  { code: 'lu', label: 'Luba-Katanga', native_label: '' },
  { code: 'lg', label: 'Luganda', native_label: 'Luganda' },
  { code: 'lb', label: 'Luxembourgish', native_label: 'Lëtzebuergesch' },
  { code: 'mk', label: 'Macedonian', native_label: 'македонски јазик' },
  { code: 'mg', label: 'Malagasy', native_label: 'Malagasy fiteny' },
  { code: 'ms', label: 'Malay', native_label: 'Bahasa Melayu' },
  { code: 'ml', label: 'Malayalam', native_label: 'മലയാളം' },
  { code: 'mt', label: 'Maltese', native_label: 'Malti' },
  { code: 'gv', label: 'Manx', native_label: 'Gaelg' },
  { code: 'mi', label: 'Māori', native_label: 'te reo Māori' },
  { code: 'mr', label: 'Marathi', native_label: 'मराठी' },
  { code: 'mh', label: 'Marshallese', native_label: 'Kajin M̧ajeļ' },
  { code: 'mn', label: 'Mongolian', native_label: 'монгол' },
  { code: 'na', label: 'Nauru', native_label: 'Ekakairũ Naoero' },
  { code: 'nv', label: 'Navajo', native_label: 'Diné bizaad' },
  { code: 'ng', label: 'Ndonga', native_label: 'Owambo' },
  { code: 'ne', label: 'Nepali', native_label: 'नेपाली' },
  { code: 'nd', label: 'North Ndebele', native_label: 'isiNdebele' },
  { code: 'se', label: 'Northern Sami', native_label: 'Davvisámegiella' },
  { code: 'no', label: 'Norwegian', native_label: 'Norsk' },
  { code: 'nb', label: 'Norwegian Bokmål', native_label: 'Norsk bokmål' },
  { code: 'nn', label: 'Norwegian Nynorsk', native_label: 'Norsk nynorsk' },
  { code: 'ii', label: 'Nuosu', native_label: 'ꆈꌠ꒿ Nuosuhxop' },
  { code: 'oc', label: 'Occitan', native_label: 'Occitan' },
  { code: 'oj', label: 'Ojibwe', native_label: 'ᐊᓂᔑᓈᐯᒧᐎᓐ' },
  { code: 'cu', label: 'Old Church Slavonic', native_label: 'Словѣньскъ' },
  { code: 'or', label: 'Oriya', native_label: 'ଓଡ଼ିଆ' },
  { code: 'om', label: 'Oromo', native_label: 'Afaan Oromoo' },
  { code: 'os', label: 'Ossetian', native_label: 'ирон æвзаг' },
  { code: 'pi', label: 'Pāli', native_label: 'पाऴि' },
  { code: 'ps', label: 'Pashto', native_label: 'پښتو' },
  { code: 'fa', label: 'Persian', native_label: 'فارسی', rtl: true },
  { code: 'pl', label: 'Polish', native_label: 'Polski' },
  { code: 'pt', label: 'Portuguese', native_label: 'Português' },
  { code: 'pt-br', label: 'Portuguese (Brazil)', native_label: 'Português (Brasil)' },
  { code: 'pt-pt', label: 'Portuguese (Portugal)', native_label: 'Português (Portugal)' },
  { code: 'pa', label: 'Punjabi', native_label: 'ਪੰਜਾਬੀ' },
  { code: 'qu', label: 'Quechua', native_label: 'Runa Simi, Kichwa' },
  { code: 'ro', label: 'Romanian', native_label: 'Română' },
  { code: 'rm', label: 'Romansh', native_label: 'rumantsch grischun' },
  { code: 'ru', label: 'Russian', native_label: 'Русский' },
  { code: 'sm', label: 'Samoan', native_label: 'Gagana Samoa' },
  { code: 'sg', label: 'Sango', native_label: 'Sängö' },
  { code: 'sa', label: 'Sanskrit', native_label: 'संस्कृतम्' },
  { code: 'sc', label: 'Sardinian', native_label: 'Sardu' },
  { code: 'gd', label: 'Scottish Gaelic', native_label: 'Gàidhlig' },
  { code: 'sr', label: 'Serbian', native_label: 'Српски' },
  { code: 'sn', label: 'Shona', native_label: 'chiShona' },
  { code: 'sd', label: 'Sindhi', native_label: 'سنڌي', rtl: true },
  { code: 'si', label: 'Sinhala', native_label: 'සිංහල' },
  { code: 'sk', label: 'Slovak', native_label: 'Slovenčina' },
  { code: 'sl', label: 'Slovene', native_label: 'Slovenščina' },
  { code: 'so', label: 'Somali', native_label: 'Soomaali' },
  { code: 'nr', label: 'South Ndebele', native_label: 'isiNdebele' },
  { code: 'st', label: 'Southern Sotho', native_label: 'Sesotho' },
  { code: 'es', label: 'Spanish', native_label: 'Español' },
  { code: 'es-ar', label: 'Spanish (Argentina)', native_label: 'Español (Argentina)' },
  { code: 'es-cl', label: 'Spanish (Chile)', native_label: 'Español (Chile)' },
  { code: 'es-co', label: 'Spanish (Colombia)', native_label: 'Español (Colombia)' },
  { code: 'es-mx', label: 'Spanish (Mexico)', native_label: 'Español (México)' },
  { code: 'es-es', label: 'Spanish (Spain)', native_label: 'Español (España)' },
  { code: 'su', label: 'Sundanese', native_label: 'Basa Sunda' },
  { code: 'sw', label: 'Swahili', native_label: 'Kiswahili' },
  { code: 'ss', label: 'Swati', native_label: 'SiSwati' },
  { code: 'sv', label: 'Swedish', native_label: 'Svenska' },
  { code: 'tl', label: 'Tagalog', native_label: 'Tagalog' },
  { code: 'ty', label: 'Tahitian', native_label: 'Reo Tahiti' },
  { code: 'tg', label: 'Tajik', native_label: 'Тоҷикӣ' },
  { code: 'ta', label: 'Tamil', native_label: 'தமிழ்' },
  { code: 'tt', label: 'Tatar', native_label: 'Татарча' },
  { code: 'te', label: 'Telugu', native_label: 'తెలుగు' },
  { code: 'th', label: 'Thai', native_label: 'ไทย' },
  { code: 'bo', label: 'Tibetan', native_label: 'བོད་ཡིག' },
  { code: 'ti', label: 'Tigrinya', native_label: 'ትግርኛ' },
  { code: 'to', label: 'Tonga', native_label: 'Lea fakatonga' },
  { code: 'ts', label: 'Tsonga', native_label: 'Xitsonga' },
  { code: 'tn', label: 'Tswana', native_label: 'Setswana' },
  { code: 'tr', label: 'Turkish', native_label: 'Türkçe' },
  { code: 'tk', label: 'Turkmen', native_label: 'Türkmen' },
  { code: 'tw', label: 'Twi', native_label: 'Twi' },
  { code: 'ug', label: 'Uyghur', native_label: 'ئۇيغۇرچە', rtl: true },
  { code: 'uk', label: 'Ukrainian', native_label: 'Українська' },
  { code: 'ur', label: 'Urdu', native_label: 'اردو', rtl: true },
  { code: 'uz', label: 'Uzbek', native_label: 'Oʻzbekcha' },
  { code: 've', label: 'Venda', native_label: 'Tshivenḓa' },
  { code: 'vi', label: 'Vietnamese', native_label: 'Tiếng Việt' },
  { code: 'vo', label: 'Volapük', native_label: 'Volapük' },
  { code: 'wa', label: 'Walloon', native_label: 'Walon' },
  { code: 'cy', label: 'Welsh', native_label: 'Cymraeg' },
  { code: 'fy', label: 'Western Frisian', native_label: 'Frysk' },
  { code: 'wo', label: 'Wolof', native_label: 'Wollof' },
  { code: 'xh', label: 'Xhosa', native_label: 'isiXhosa' },
  { code: 'yi', label: 'Yiddish', native_label: 'ייִדיש' },
  { code: 'yo', label: 'Yoruba', native_label: 'Yorùbá' },
  { code: 'za', label: 'Zhuang', native_label: 'Saɯ cueŋƅ' },
  { code: 'zu', label: 'Zulu', native_label: 'isiZulu' },
];

// Maps and sets for faster lookups
const LOCALES_BY_CODE = new Map<string, LocaleOption>(LOCALES.map((locale) => [locale.code, locale]));
const LOCALES_CODES = new Set<string>(LOCALES.map((locale) => locale.code));

/**
 * Get locale by code
 */
export function getLocaleByCode(code: string): LocaleOption | undefined {
  return LOCALES_BY_CODE.get(code);
}

/**
 * Check if a locale code is supported
 */
export function isLocaleCodeSupported(code: string): boolean {
  return LOCALES_CODES.has(code);
}

/**
 * Check if a locale is right-to-left
 */
export function isLocaleRtl(locale: LocaleOption): boolean {
  return locale.rtl === true;
}

/**
 * Translatable item extracted from pages
 */
export interface TranslatableItem {
  key: string; // Unique identifier for the item (same key for all locales)
  source_type: 'page' | 'folder' | 'component' | 'cms'; // Source type (page, folder, component, cms)
  source_id: string; // Source ID (e.g., page ID, folder ID, component ID, collection item ID)
  content_key: string; // Source key (e.g., 'layer:{layerId}:text', 'seo:title', 'slug')
  content_type: 'text' | 'richtext' | 'asset_id'; // Content type (text, richtext, asset)
  content_value: string; // Current text value (may contain inline variables)
  open_in_sheet?: boolean; // If true, editing opens in a right-side sheet panel (for block-level rich text)
  info: {
    icon: IconProps['name']; // Icon name for the item
    label: string; // Item label (e.g., "SEO Title", "Heading")
    description?: string; // Optional item description
  }
}

/**
 * Extract alt text from an image layer
 * @param layer - Layer with image variables
 * @returns Alt text content or null if not available
 */
export function extractImageAltText(layer: Layer): string | null {
  // Only use variables.image.alt (DynamicTextVariable)
  if (!layer.variables?.image?.alt || layer.variables.image.alt.type !== 'dynamic_text') {
    return null;
  }

  const altText = layer.variables.image.alt.data.content;

  if (!altText || !altText.trim()) {
    return null;
  }

  return altText.trim();
}

/**
 * Decide how a layer's text content should be surfaced in the localization UI.
 *
 * Classification follows the *current* content, not the source layer type:
 * - A `richText` layer whose content currently has formatting (bold, lists,
 *   headings, etc.) gets the full sheet editor.
 * - A `richText` layer whose content is currently flat plain text falls back
 *   to a simple inline input — there's nothing to format anyway.
 * - All other layers (heading, paragraph, span, etc.) are always flattened
 *   to plain text. Their on-canvas widget doesn't expose formatting
 *   controls, so offering them in translation would be misleading.
 *
 * The returned `value` always uses the canonical inline-variable string
 * format for `text` content, and the JSON-stringified Tiptap doc for
 * `richtext` content, so downstream rendering is unambiguous.
 */
function classifyLayerTextForTranslation(
  layer: Layer
): { contentType: 'text' | 'richtext'; value: string; openInSheet: boolean } | null {
  const textVariable = layer.variables?.text;
  if (!textVariable) return null;

  // Only true rich-text layers (block-level editor with paragraphs/headings/
  // lists) open in the doc-style sheet. Simple text/heading layers flatten
  // multi-paragraph content to line breaks on canvas, so the translation
  // editor should stay inline and compact to match.
  const isRichLayer = isRichTextLayer(layer);

  if (textVariable.type === 'dynamic_text') {
    const text = textVariable.data.content;
    if (!text || typeof text !== 'string' || !text.trim()) return null;
    if (looksLikeFormattedHtml(text) || text.includes('<ycode-inline-variable>')) {
      return { contentType: 'richtext', value: text.trim(), openInSheet: isRichLayer };
    }
    return { contentType: 'text', value: text.trim(), openInSheet: false };
  }

  if (textVariable.type === 'dynamic_rich_text') {
    const doc = textVariable.data.content;
    if (!doc || typeof doc !== 'object') return null;

    if (tiptapDocHasFormatting(doc) || hasVariableNode(doc)) {
      const json = JSON.stringify(doc);
      if (!hasAnyTextOrVariable(doc)) return null;
      return { contentType: 'richtext', value: json, openInSheet: isRichLayer };
    }

    const canonical = tiptapDocToCanonicalString(doc).trim();
    if (!canonical) return null;
    return { contentType: 'text', value: canonical, openInSheet: false };
  }

  return null;
}

/**
 * Extract translatable media items (image src/alt, video src/poster, audio src)
 * from a single layer. Shared by both the recursive and shallow extractors.
 */
function extractMediaTranslatableItems(
  layer: Layer,
  sourceType: 'page' | 'component',
  sourceId: string,
  items: TranslatableItem[]
): void {
  const layerName = getLayerName(layer);

  if (layer.name === 'image' && layer.variables?.image) {
    const imageSrc = layer.variables.image.src;
    if (imageSrc && imageSrc.type === 'asset' && imageSrc.data?.asset_id) {
      items.push({
        key: `${sourceType}:${sourceId}:layer:${layer.id}:image_src`,
        source_type: sourceType,
        source_id: sourceId,
        content_key: `layer:${layer.id}:image_src`,
        content_type: 'asset_id',
        content_value: imageSrc.data.asset_id,
        info: { icon: 'image', label: `${layerName} (source)` },
      });
    }

    const imageAlt = extractImageAltText(layer);
    if (imageAlt) {
      items.push({
        key: `${sourceType}:${sourceId}:layer:${layer.id}:image_alt`,
        source_type: sourceType,
        source_id: sourceId,
        content_key: `layer:${layer.id}:image_alt`,
        content_type: 'text',
        content_value: imageAlt,
        info: { icon: 'image', label: `${layerName} (alt text)` },
      });
    }
  }

  if (layer.name === 'video' && layer.variables?.video) {
    const videoSrc = layer.variables.video.src;
    if (videoSrc && videoSrc.type === 'asset' && videoSrc.data?.asset_id) {
      items.push({
        key: `${sourceType}:${sourceId}:layer:${layer.id}:video_src`,
        source_type: sourceType,
        source_id: sourceId,
        content_key: `layer:${layer.id}:video_src`,
        content_type: 'asset_id',
        content_value: videoSrc.data.asset_id,
        info: { icon: 'video', label: `${layerName} (source)` },
      });
    }

    const videoPoster = layer.variables.video.poster;
    if (videoPoster && videoPoster.type === 'asset' && videoPoster.data?.asset_id) {
      items.push({
        key: `${sourceType}:${sourceId}:layer:${layer.id}:video_poster`,
        source_type: sourceType,
        source_id: sourceId,
        content_key: `layer:${layer.id}:video_poster`,
        content_type: 'asset_id',
        content_value: videoPoster.data.asset_id,
        info: { icon: 'image', label: `${layerName} (poster)` },
      });
    }
  }

  if (layer.name === 'audio' && layer.variables?.audio?.src) {
    const audioSrc = layer.variables.audio.src;
    if (audioSrc.type === 'asset' && audioSrc.data?.asset_id) {
      items.push({
        key: `${sourceType}:${sourceId}:layer:${layer.id}:audio_src`,
        source_type: sourceType,
        source_id: sourceId,
        content_key: `layer:${layer.id}:audio_src`,
        content_type: 'asset_id',
        content_value: audioSrc.data.asset_id,
        info: { icon: 'audio', label: `${layerName} (source)` },
      });
    }
  }
}

/**
 * Recursively extract all translatable text items from layers
 */
function extractLayerTranslatableItems(
  layers: Layer[],
  sourceType: 'page' | 'component',
  sourceId: string,
  items: TranslatableItem[]
): void {
  for (const layer of layers) {
    // The locale-selector label renders the active locale name dynamically and
    // doesn't need translating. Skip the whole subtree by its parent (`name`)
    // as well as the inner label layer (`key`) — older content may be missing
    // the `localeSelectorLabel` key.
    if (layer.name === 'localeSelector' || layer.key === 'localeSelectorLabel') continue;

    const classification = classifyLayerTextForTranslation(layer);

    if (classification) {
      items.push({
        key: `${sourceType}:${sourceId}:layer:${layer.id}:text`,
        source_type: sourceType,
        source_id: sourceId,
        content_key: `layer:${layer.id}:text`,
        content_type: classification.contentType,
        content_value: classification.value,
        open_in_sheet: classification.openInSheet,
        info: {
          icon: getLayerIcon(layer),
          label: getLayerName(layer),
        },
      });
    }

    extractMediaTranslatableItems(layer, sourceType, sourceId, items);

    if (layer.children && Array.isArray(layer.children) && layer.children.length > 0) {
      extractLayerTranslatableItems(layer.children, sourceType, sourceId, items);
    }
  }
}

/**
 * Extract SEO translatable items from page settings
 */
function classifySeoValue(value: string): { contentType: 'text' | 'richtext'; openInSheet: boolean } {
  if (looksLikeFormattedHtml(value) || value.includes('<ycode-inline-variable>')) {
    return { contentType: 'richtext', openInSheet: true };
  }
  return { contentType: 'text', openInSheet: false };
}

function extractSeoItems(
  pageId: string,
  seo: { title?: string; description?: string } | undefined,
  items: TranslatableItem[]
): void {
  if (!seo) return;

  if (seo.title && typeof seo.title === 'string' && seo.title.trim()) {
    const classification = classifySeoValue(seo.title);
    items.push({
      key: `page:${pageId}:seo:title`,
      source_type: 'page',
      source_id: pageId,
      content_key: 'seo:title',
      content_type: classification.contentType,
      content_value: seo.title.trim(),
      open_in_sheet: classification.openInSheet,
      info: {
        icon: 'search',
        label: 'SEO Title',
      },
    });
  }

  if (seo.description && typeof seo.description === 'string' && seo.description.trim()) {
    const classification = classifySeoValue(seo.description);
    items.push({
      key: `page:${pageId}:seo:description`,
      source_type: 'page',
      source_id: pageId,
      content_key: 'seo:description',
      content_type: classification.contentType,
      content_value: seo.description.trim(),
      open_in_sheet: classification.openInSheet,
      info: {
        icon: 'search',
        label: 'SEO Description',
      },
    });
  }
}

/**
 * Extract all translatable items from a page (slug, SEO, and layers)
 * Ordered: slug first, then SEO settings, then layer texts
 * Note: Dynamic page slugs and index pages (homepage / folder index) are
 * excluded — their slug doesn't contribute to the URL.
 */
export function extractPageTranslatableItems(
  page: Page,
  layers: Layer[],
  locale?: Locale
): TranslatableItem[] {
  const items: TranslatableItem[] = [];

  // 1. Extract slug (first) - exclude dynamic, index, and error pages
  if (!page.is_dynamic && !page.is_index && !page.error_page && page.slug && page.slug.trim()) {
    const localeName = locale?.label || 'localized';
    items.push({
      key: `page:${page.id}:slug`,
      source_type: 'page',
      source_id: page.id,
      content_key: 'slug',
      content_type: 'text',
      content_value: page.slug.trim(),
      info: {
        icon: 'link',
        label: 'Page slug',
        description: `Affects the ${localeName} URL generated for this page`,
      },
    });
  }

  // 2. Extract SEO items (second)
  extractSeoItems(page.id, page.settings?.seo, items);

  // 3. Extract layer texts (third)
  if (layers && Array.isArray(layers) && layers.length > 0) {
    extractLayerTranslatableItems(layers, 'page', page.id, items);
  }

  return items;
}

/**
 * Extract all translatable items from a folder (slug only)
 */
export function extractFolderTranslatableItems(
  folder: { id: string; slug: string; name: string },
  locale?: Locale
): TranslatableItem[] {
  const items: TranslatableItem[] = [];

  // Extract folder slug
  if (folder.slug && folder.slug.trim()) {
    const localeName = locale?.label || 'localized';
    items.push({
      key: `folder:${folder.id}:slug`,
      source_type: 'folder',
      source_id: folder.id,
      content_key: 'slug',
      content_type: 'text',
      content_value: folder.slug.trim(),
      info: {
        icon: 'folder',
        label: 'Folder slug',
        description: `Affects the ${localeName} URLs of all pages and folders inside this folder`,
      },
    });
  }

  return items;
}

/**
 * Extract all translatable items from a component (layer texts only)
 */
export function extractComponentTranslatableItems(
  component: { id: string; name: string },
  layers: Layer[]
): TranslatableItem[] {
  const items: TranslatableItem[] = [];

  // Extract layer texts only (components don't have slug or SEO)
  if (layers && Array.isArray(layers) && layers.length > 0) {
    extractLayerTranslatableItems(layers, 'component', component.id, items);
  }

  return items;
}

/**
 * Extract all translatable items from a CMS collection item
 * Only extracts text and rich_text field values
 */
export function extractCmsTranslatableItems(
  collectionItem: { id: string; collection_id: string; values: Record<string, string> },
  fields: Array<{ id: string; name: string; type: string; key: string | null }>,
  locale?: Locale
): TranslatableItem[] {
  const items: TranslatableItem[] = [];

  // Extract translatable field values (text and rich_text only)
  for (const field of fields) {
    // Only translate text and rich_text fields
    if (field.type !== 'text' && field.type !== 'rich_text') {
      continue;
    }

    const fieldValue = collectionItem.values[field.id];

    // Skip empty values — rich_text values may be parsed Tiptap objects
    if (!fieldValue) {
      continue;
    }

    let contentValue: string;
    if (typeof fieldValue === 'object') {
      contentValue = JSON.stringify(fieldValue);
    } else {
      contentValue = String(fieldValue).trim();
      if (!contentValue) continue;
    }

    const isSlugField = field.key === 'slug';
    const localeName = locale?.label || 'localized';

    // Build content_key: field:key:{key} or field:id:{id} when key is null
    const contentKey = field.key
      ? `field:key:${field.key}`
      : `field:id:${field.id}`;

    const isRichText = field.type === 'rich_text';
    items.push({
      key: `cms:${collectionItem.id}:${contentKey}`,
      source_type: 'cms',
      source_id: collectionItem.id,
      content_key: contentKey,
      content_type: isRichText ? 'richtext' : 'text',
      content_value: contentValue,
      open_in_sheet: isRichText,
      info: {
        icon: isRichText ? 'type' : 'text',
        label: field.name,
        description: isSlugField ? `Affects ${localeName} URLs generated by dynamic pages using this CMS item` : undefined,
      },
    });
  }

  // Order: slug first, then other fields
  return items.sort((a, b) => {
    const aIsSlug = a.content_key === 'field:key:slug';
    const bIsSlug = b.content_key === 'field:key:slug';
    if (aIsSlug && !bIsSlug) return -1;
    if (!aIsSlug && bIsSlug) return 1;
    return 0;
  });
}

/**
 * Generate a translatable key from a Translation
 * Format: source_type:source_id:content_key
 * @param translation - Translation object or object with source_type, source_id, and content_key
 * @returns Translatable key string
 */
// `getTranslatableKey` and the runtime translation helpers were moved to
// `lib/locale-runtime.ts` (template-free) so leaf modules like
// `lib/page-utils.ts` and the public renderer can import them without
// transitively pulling in the builder-only extractors and the template tree.

/**
 * Extract all layer content as a key-value map
 * Returns map of content keys to their values
 * Format: { "layer:{id}:text": "content", "layer:{id}:alt": "alt text" }
 * Uses extractLayerTranslatableItems internally for consistency
 */
export function extractLayerContentMap(
  layers: Layer[],
  sourceType: 'page' | 'component' = 'page',
  sourceId: string = 'temp'
): Record<string, string> {
  const items: TranslatableItem[] = [];

  // Use existing extractLayerTranslatableItems for consistency
  extractLayerTranslatableItems(layers, sourceType, sourceId, items);

  // Convert items to content map (content_key -> content_value)
  const contentMap: Record<string, string> = {};
  for (const item of items) {
    contentMap[item.content_key] = item.content_value;
  }

  return contentMap;
}

// `getTranslatedAssetId` / `getTranslatedText` moved to `lib/locale-runtime.ts`
// (see note above).

/**
 * Inject translated text and assets into layers recursively.
 * Replaces layer text content and asset sources with translations when available.
 * Handles both page-level and component-level translations via _masterComponentId.
 *
 * Shared between the server-side page fetcher (preview / published) and the
 * builder canvas so both paths produce identical output.
 *
 * @param defaultMasterComponentId - When provided, any layer that doesn't carry
 *   `_masterComponentId` is treated as belonging to this component. Used by the
 *   builder canvas while editing a component definition (where the rendered
 *   layers are the component's raw layers, not a resolved instance), so
 *   translations stored under `component:{componentId}:...` apply.
 */
export function injectTranslatedText(
  layers: Layer[],
  pageId: string,
  translations: Record<string, Translation>,
  options?: { includeIncomplete?: boolean; defaultMasterComponentId?: string }
): Layer[] {
  const valueOptions = options?.includeIncomplete ? { includeIncomplete: true } : undefined;
  return layers.map(layer => {
    const updates: Partial<Layer> = {};
    const variableUpdates: Partial<Layer['variables']> = {};

    // Use original layer ID for translation lookups — after resolveComponents,
    // child layer IDs are transformed to instance-specific IDs (e.g., "instanceId-childId")
    // but translations are stored with the original component layer IDs.
    const translationLayerId = (layer as any)._originalLayerId || layer.id;
    const masterComponentId =
      ((layer as any)._masterComponentId as string | undefined) ?? options?.defaultMasterComponentId;

    // 1. Inject text translation
    const textTranslationKey = buildLayerTranslationKey(pageId, `layer:${translationLayerId}:text`, masterComponentId);
    const textTranslation = getTranslationByKey(translations, textTranslationKey);

    const textValue = getTranslationValue(textTranslation, valueOptions);
    if (textValue) {
      // Preserve the original variable type (dynamic_text or dynamic_rich_text).
      // Use the translation's stored content_type to decide whether the value is
      // a JSON-serialized Tiptap doc or plain text — when a rich-text source has
      // no formatting, it's stored as plain text (see classifyLayerTextForTranslation),
      // so blindly JSON.parse-ing it would log noisy errors on every render.
      if (layer.variables?.text?.type === 'dynamic_rich_text') {
        if (textTranslation?.content_type === 'richtext') {
          (variableUpdates as any).text = createDynamicRichTextVariable(textValue);
        } else {
          (variableUpdates as any).text = createDynamicRichTextVariableFromPlainText(textValue);
        }
      } else {
        (variableUpdates as any).text = createDynamicTextVariable(textValue);
      }
    }

    // 2. Inject asset translations for media layers
    if (layer.name === 'image') {
      const imageSrcKey = buildLayerTranslationKey(pageId, `layer:${translationLayerId}:image_src`, masterComponentId);
      const imageSrcTranslation = getTranslationByKey(translations, imageSrcKey);
      const imageAltKey = buildLayerTranslationKey(pageId, `layer:${translationLayerId}:image_alt`, masterComponentId);
      const imageAltTranslation = getTranslationByKey(translations, imageAltKey);

      if (imageSrcTranslation || imageAltTranslation) {
        const imageUpdates: any = { ...(layer.variables?.image as any) };

        if (imageSrcTranslation && imageSrcTranslation.content_value) {
          imageUpdates.src = createAssetVariable(imageSrcTranslation.content_value);
        }

        const imageAltValue = getTranslationValue(imageAltTranslation, valueOptions);
        if (imageAltValue) {
          imageUpdates.alt = createDynamicTextVariable(imageAltValue);
        } else {
          // Preserve original alt if no translation
          imageUpdates.alt = layer.variables?.image?.alt || createDynamicTextVariable('');
        }

        (variableUpdates as any).image = imageUpdates;
      }
    }

    if (layer.name === 'video') {
      const videoSrcKey = buildLayerTranslationKey(pageId, `layer:${translationLayerId}:video_src`, masterComponentId);
      const videoSrcTranslation = getTranslationByKey(translations, videoSrcKey);
      const videoPosterKey = buildLayerTranslationKey(pageId, `layer:${translationLayerId}:video_poster`, masterComponentId);
      const videoPosterTranslation = getTranslationByKey(translations, videoPosterKey);

      if (videoSrcTranslation || videoPosterTranslation) {
        const videoUpdates: any = { ...(layer.variables?.video as any) };

        if (videoSrcTranslation && videoSrcTranslation.content_value) {
          videoUpdates.src = createAssetVariable(videoSrcTranslation.content_value);
        }

        if (videoPosterTranslation && videoPosterTranslation.content_value) {
          videoUpdates.poster = createAssetVariable(videoPosterTranslation.content_value);
        }

        (variableUpdates as any).video = videoUpdates;
      }
    }

    if (layer.name === 'audio') {
      const audioSrcKey = buildLayerTranslationKey(pageId, `layer:${translationLayerId}:audio_src`, masterComponentId);
      const audioSrcTranslation = getTranslationByKey(translations, audioSrcKey);

      if (audioSrcTranslation && audioSrcTranslation.content_value) {
        (variableUpdates as any).audio = {
          src: createAssetVariable(audioSrcTranslation.content_value),
        };
      }
    }

    if (Object.keys(variableUpdates).length > 0) {
      updates.variables = {
        ...layer.variables,
        ...variableUpdates,
      } as Layer['variables'];
    }

    if (layer.children && layer.children.length > 0) {
      updates.children = injectTranslatedText(layer.children, pageId, translations, options);
    }

    return {
      ...layer,
      ...updates,
    };
  });
}

/**
 * Apply CMS translations to a collection item's values map (field_id -> value).
 * Returns a new map with translated values where available; rich-text strings are
 * cast back into Tiptap document objects via castValue so they match the shape
 * downstream renderers expect.
 */
export function applyCmsTranslations(
  itemId: string,
  itemValues: Record<string, any>,
  collectionFields: CollectionField[],
  translations?: Record<string, Translation> | null,
  options?: { includeIncomplete?: boolean }
): Record<string, any> {
  if (!translations || Object.keys(translations).length === 0) {
    return itemValues;
  }

  const valueOptions = options?.includeIncomplete ? { includeIncomplete: true } : undefined;
  const translatedValues: Record<string, any> = { ...itemValues };

  const fieldIdToKey = new Map<string, string | null>();
  const fieldIdToType = new Map<string, string>();
  for (const field of collectionFields) {
    fieldIdToKey.set(field.id, field.key);
    fieldIdToType.set(field.id, field.type);
  }

  for (const fieldId of Object.keys(itemValues)) {
    const fieldKey = fieldIdToKey.get(fieldId);

    const contentKey = fieldKey ? `field:key:${fieldKey}` : `field:id:${fieldId}`;
    const translationKey = `cms:${itemId}:${contentKey}`;
    const translation = translations[translationKey];

    const translatedValue = getTranslationValue(translation, valueOptions);
    if (translatedValue) {
      const fieldType = fieldIdToType.get(fieldId);
      translatedValues[fieldId] = fieldType
        ? castValue(translatedValue, fieldType as any)
        : translatedValue;
    }
  }

  return translatedValues;
}

/**
 * Extract the translatable items for a single layer (without recursing into children).
 * Used by the right sidebar to build the per-layer translation editor.
 */
export function extractLayerTranslatableItemsShallow(
  layer: Layer,
  sourceType: 'page' | 'component',
  sourceId: string
): TranslatableItem[] {
  const items: TranslatableItem[] = [];

  if (layer.name === 'localeSelector' || layer.key === 'localeSelectorLabel') return items;

  const classification = classifyLayerTextForTranslation(layer);
  if (classification) {
    items.push({
      key: `${sourceType}:${sourceId}:layer:${layer.id}:text`,
      source_type: sourceType,
      source_id: sourceId,
      content_key: `layer:${layer.id}:text`,
      content_type: classification.contentType,
      content_value: classification.value,
      open_in_sheet: classification.openInSheet,
      info: {
        icon: getLayerIcon(layer),
        label: getLayerName(layer),
      },
    });
  }

  extractMediaTranslatableItems(layer, sourceType, sourceId, items);

  return items;
}
