/**
 * HTML ↔ Layer bidirectional converter
 *
 * Import: Parse an HTML string into a Layer[] tree, converting Tailwind classes
 *         to design properties and mapping HTML elements to Ycode layer types.
 *
 * Export: Convert a Layer tree back into clean HTML with Tailwind classes.
 */

import type { Layer, LinkSettings } from '@/types';
import { generateId } from '@/lib/utils';
import { classesToDesign } from '@/lib/tailwind-class-mapper';
import { getClassesString, getLayerHtmlTag } from '@/lib/layer-utils';
import { getTiptapTextContent } from '@/lib/text-format-utils';
import { escapeHtml } from '@/lib/escape-html';
import { normalizeV3ToV4, resolveNamedColors } from '@/lib/tailwind-normalizer';
import { cssToClasses } from '@/lib/import/css';

/** Returns the URL only if it's absolute, otherwise undefined (relative paths become placeholders). */
function resolveAbsoluteUrl(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'data:') {
      return url;
    }
  } catch { /* relative path */ }
  return undefined;
}

// ─── Tag → Layer Name Mapping ───

const TAG_TO_LAYER_NAME: Record<string, string> = {
  // Structure — maps to valid Ycode layer names
  div: 'div',
  section: 'section',
  header: 'div',
  footer: 'div',
  main: 'div',
  aside: 'div',
  article: 'div',
  nav: 'div',
  figure: 'div',
  figcaption: 'div',
  blockquote: 'div',
  details: 'div',
  summary: 'div',
  dialog: 'div',
  address: 'div',
  fieldset: 'div',
  legend: 'div',
  hgroup: 'div',
  search: 'div',

  // Links — treated as div with link settings
  a: 'div',

  // Text / inline content
  p: 'text',
  span: 'span',
  label: 'label',
  strong: 'span',
  b: 'span',
  em: 'span',
  i: 'span',
  u: 'span',
  s: 'span',
  del: 'span',
  ins: 'span',
  mark: 'span',
  small: 'span',
  sub: 'span',
  sup: 'span',
  abbr: 'span',
  cite: 'span',
  code: 'span',
  kbd: 'span',
  samp: 'span',
  var: 'span',
  time: 'span',
  data: 'span',
  q: 'span',
  dfn: 'span',
  ruby: 'span',
  rt: 'span',
  rp: 'span',
  bdi: 'span',
  bdo: 'span',
  wbr: 'span',

  // Headings
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',

  // Media
  img: 'image',
  picture: 'div',
  source: 'div',
  video: 'video',
  audio: 'audio',
  track: 'div',
  canvas: 'div',
  svg: 'icon',

  // Embeds
  iframe: 'iframe',
  embed: 'div',
  object: 'div',

  // Forms
  form: 'form',
  button: 'button',
  input: 'input',
  textarea: 'textarea',
  select: 'select',
  option: 'div',
  optgroup: 'div',
  datalist: 'div',
  output: 'div',
  progress: 'div',
  meter: 'div',

  // Lists → div (with semantic tag preserved)
  ul: 'div',
  ol: 'div',
  li: 'div',
  dl: 'div',
  dt: 'div',
  dd: 'div',
  menu: 'div',

  // Tables → div (with semantic tag preserved)
  table: 'div',
  caption: 'div',
  colgroup: 'div',
  col: 'div',
  thead: 'div',
  tbody: 'div',
  tfoot: 'div',
  tr: 'div',
  td: 'div',
  th: 'div',

  // Separators
  hr: 'hr',

  // Preformatted
  pre: 'div',
};

const SEMANTIC_TAG_OVERRIDE: Record<string, string> = {
  header: 'header',
  footer: 'footer',
  main: 'main',
  aside: 'aside',
  article: 'article',
  nav: 'nav',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  dl: 'dl',
  dt: 'dt',
  dd: 'dd',
  blockquote: 'blockquote',
  pre: 'pre',
  figure: 'figure',
  figcaption: 'figcaption',
  details: 'details',
  summary: 'summary',
  table: 'table',
  caption: 'caption',
  thead: 'thead',
  tbody: 'tbody',
  tfoot: 'tfoot',
  tr: 'tr',
  td: 'td',
  th: 'th',
  fieldset: 'fieldset',
  legend: 'legend',
  address: 'address',
  menu: 'menu',
  search: 'search',
};

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const CONTAINER_NAMES = new Set([
  'div', 'section', 'form', 'button', 'label',
]);

const SELF_CLOSING_TAGS = new Set([
  'img', 'input', 'hr', 'br', 'meta', 'link', 'source', 'track', 'wbr',
]);

const INLINE_TEXT_TAGS = new Set([
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small',
  'sub', 'sup', 'abbr', 'cite', 'code', 'kbd', 'samp', 'var', 'time',
  'data', 'q', 'dfn', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr',
  'a', 'span',
]);

// ─── Inline Style → Tailwind Classes ───

/**
 * Convert an inline `style` declaration block to Tailwind classes.
 * Delegates to the shared mapper in `lib/import/css.ts` so HTML import and the
 * Webflow/Figma importers stay in lockstep.
 */
function styleToClasses(style: string): string[] {
  return cssToClasses(style);
}

// ─── TipTap Rich Text Builder ───

type TiptapMark = { type: string; attrs?: Record<string, any> };
type TiptapNode =
  | { type: 'text'; text: string; marks?: TiptapMark[] }
  | { type: 'hardBreak' };

const HTML_TAG_TO_MARK: Record<string, string> = {
  strong: 'bold', b: 'bold',
  em: 'italic', i: 'italic',
  u: 'underline', ins: 'underline',
  s: 'strike', del: 'strike',
  sub: 'subscript', sup: 'superscript',
  code: 'code', kbd: 'code',
};

function collectInlineNodes(node: Node, marks: TiptapMark[]): TiptapNode[] {
  const nodes: TiptapNode[] = [];

  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];

    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent || '';
      if (text) {
        nodes.push({
          type: 'text',
          text,
          ...(marks.length > 0 ? { marks: [...marks] } : {}),
        });
      }
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'br') {
      nodes.push({ type: 'hardBreak' });
      continue;
    }

    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      const target = el.getAttribute('target');
      const rel = el.getAttribute('rel');
      const linkMark: TiptapMark = {
        type: 'richTextLink',
        attrs: {
          type: 'url' as const,
          url: { type: 'dynamic_text' as const, data: { content: href } },
          ...(target ? { target } : {}),
          ...(rel ? { rel } : {}),
        },
      };
      nodes.push(...collectInlineNodes(el, [...marks, linkMark]));
      continue;
    }

    const markType = HTML_TAG_TO_MARK[tag];
    if (markType) {
      nodes.push(...collectInlineNodes(el, [...marks, { type: markType }]));
    } else {
      nodes.push(...collectInlineNodes(el, marks));
    }
  }

  return nodes;
}

function buildRichTextDoc(el: Element) {
  const inlineNodes = collectInlineNodes(el, []);
  return {
    type: 'doc' as const,
    content: [{
      type: 'paragraph' as const,
      content: inlineNodes.length > 0 ? inlineNodes : [],
    }],
  };
}

// ─── Import: HTML → Layers ───

function isTextOnlyElement(el: Element): boolean {
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      const tag = child.tagName.toLowerCase();
      if (tag !== 'br' && !INLINE_TEXT_TAGS.has(tag)) return false;
      // Inline wrappers (e.g. <a>) may contain block-level elements like <img>
      if (INLINE_TEXT_TAGS.has(tag) && !isTextOnlyElement(child)) return false;
    }
  }
  return true;
}

const TEXT_LAYER_NAMES = new Set(['text', 'heading', 'span']);

const LAYER_NAME_LABELS: Record<string, string> = {
  heading: 'Heading',
  text: 'Text',
  span: 'Text',
};

function makeRichTextVariable(textOrDoc: string | object) {
  const content = typeof textOrDoc === 'string'
    ? getTiptapTextContent(textOrDoc)
    : textOrDoc;
  return {
    type: 'dynamic_rich_text' as const,
    data: { content },
  };
}

function makeTextLayer(textOrDoc: string | object): Layer {
  return {
    id: generateId('lyr'),
    name: 'text',
    classes: '',
    restrictions: { editText: true },
    variables: { text: makeRichTextVariable(textOrDoc) },
  };
}

function cleanDesign(design: Layer['design']): Layer['design'] | undefined {
  if (!design) return undefined;

  const cleaned: Record<string, any> = {};
  let hasValues = false;

  for (const [category, properties] of Object.entries(design)) {
    if (!properties || typeof properties !== 'object') continue;
    const nonEmpty = Object.keys(properties).length > 0;
    if (nonEmpty) {
      cleaned[category] = { isActive: true, ...properties };
      hasValues = true;
    }
  }

  return hasValues ? (cleaned as Layer['design']) : undefined;
}

function resolveImportClasses(el: Element): string {
  const classAttr = el.getAttribute('class') || '';
  const styleAttr = el.getAttribute('style') || '';

  const htmlClasses = classAttr.split(/\s+/).filter(Boolean);
  const inlineClasses = styleAttr ? styleToClasses(styleAttr) : [];

  const merged = [...htmlClasses, ...inlineClasses];
  const normalized = normalizeV3ToV4(merged);
  const resolved = resolveNamedColors(normalized);

  return resolved.join(' ');
}

function sanitizeSvg(el: Element): void {
  el.querySelectorAll('script').forEach(s => s.remove());
  const walk = (node: Element) => {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        node.removeAttribute(attr.name);
      }
    }
    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i]);
    }
  };
  walk(el);
}

function elementToLayer(el: Element): Layer | null {
  const tag = el.tagName.toLowerCase();

  if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta' || tag === 'br') {
    return null;
  }

  const layerName = TAG_TO_LAYER_NAME[tag] || 'div';
  const classes = resolveImportClasses(el);

  const rawDesign = classes ? classesToDesign(classes) : undefined;
  const design = cleanDesign(rawDesign);

  const layer: Layer = {
    id: generateId('lyr'),
    name: layerName,
    classes,
    ...(design ? { design } : {}),
  };

  if (HEADING_TAGS.has(tag)) {
    layer.settings = { tag };
  } else if (SEMANTIC_TAG_OVERRIDE[tag]) {
    layer.settings = { tag: SEMANTIC_TAG_OVERRIDE[tag] };
  }

  if (TEXT_LAYER_NAMES.has(layerName)) {
    layer.restrictions = { editText: true };
  }

  if (tag === 'a') {
    const href = el.getAttribute('href');
    const target = el.getAttribute('target') as LinkSettings['target'] | null;
    const rel = el.getAttribute('rel');

    if (href) {
      const linkSettings: LinkSettings = {
        type: 'url',
        url: { type: 'dynamic_text', data: { content: href } },
      };
      if (target) linkSettings.target = target;
      if (rel) linkSettings.rel = rel;
      layer.variables = { ...layer.variables, link: linkSettings };
    }
  }

  if (tag === 'img') {
    const rawSrc = el.getAttribute('src');
    const alt = el.getAttribute('alt');
    const absoluteSrc = rawSrc ? resolveAbsoluteUrl(rawSrc) : undefined;
    layer.variables = {
      ...layer.variables,
      image: {
        src: absoluteSrc
          ? { type: 'dynamic_text', data: { content: absoluteSrc } }
          : { type: 'asset', data: { asset_id: '' } },
        alt: { type: 'dynamic_text', data: { content: alt || '' } },
      },
    };
    const width = el.getAttribute('width');
    const height = el.getAttribute('height');
    if (width || height) {
      layer.attributes = {
        ...layer.attributes,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      };
    }
    return layer;
  }

  if (tag === 'input') {
    const type = el.getAttribute('type') || 'text';
    const placeholder = el.getAttribute('placeholder');
    const name = el.getAttribute('name');
    layer.attributes = {
      ...layer.attributes,
      type,
      ...(placeholder ? { placeholder } : {}),
      ...(name ? { name } : {}),
    };
    return layer;
  }

  if (tag === 'textarea') {
    const placeholder = el.getAttribute('placeholder');
    const name = el.getAttribute('name');
    const rows = el.getAttribute('rows');
    layer.attributes = {
      ...layer.attributes,
      ...(placeholder ? { placeholder } : {}),
      ...(name ? { name } : {}),
      ...(rows ? { rows } : {}),
    };
    return layer;
  }

  if (tag === 'select') {
    const name = el.getAttribute('name');
    layer.attributes = {
      ...layer.attributes,
      ...(name ? { name } : {}),
    };
    return layer;
  }

  if (tag === 'form') {
    const action = el.getAttribute('action');
    const method = el.getAttribute('method');
    layer.attributes = {
      ...layer.attributes,
      ...(action ? { action } : {}),
      ...(method ? { method } : {}),
    };
  }

  if (tag === 'iframe') {
    const iframeSrc = resolveAbsoluteUrl(el.getAttribute('src') || '');
    if (iframeSrc) {
      layer.variables = {
        ...layer.variables,
        iframe: {
          src: { type: 'dynamic_text', data: { content: iframeSrc } },
        },
      };
    }
    return layer;
  }

  if (tag === 'video' || tag === 'audio') {
    const mediaSrc = resolveAbsoluteUrl(el.getAttribute('src') || '');
    if (mediaSrc) {
      layer.variables = {
        ...layer.variables,
        [tag]: {
          src: { type: 'dynamic_text', data: { content: mediaSrc } },
        },
      };
    }
    layer.attributes = {
      ...layer.attributes,
      controls: el.hasAttribute('controls'),
      loop: el.hasAttribute('loop'),
      muted: el.hasAttribute('muted'),
      autoplay: el.hasAttribute('autoplay'),
    };
    return layer;
  }

  if (tag === 'svg') {
    sanitizeSvg(el);
    // Strip class/style already extracted to the icon layer's design properties
    el.removeAttribute('class');
    el.removeAttribute('style');
    const svgString = el.outerHTML;
    layer.variables = {
      ...layer.variables,
      icon: {
        src: { type: 'static_text', data: { content: svgString } },
      },
    };
    return layer;
  }

  const customId = el.getAttribute('id');
  if (customId) {
    layer.attributes = { ...layer.attributes, id: customId };
  }

  const isTextLayer = TEXT_LAYER_NAMES.has(layerName);

  if (isTextLayer && isTextOnlyElement(el)) {
    const doc = buildRichTextDoc(el);
    const hasContent = doc.content[0].content.length > 0;
    if (!hasContent) {
      // Empty text elements (e.g. decorative <span>) become div layers
      layer.name = 'div';
      layer.children = [];
      return layer;
    }
    layer.variables = {
      ...layer.variables,
      text: makeRichTextVariable(doc),
    };
    return layer;
  }

  if (!isTextLayer && isTextOnlyElement(el) && el.textContent?.trim()) {
    const doc = buildRichTextDoc(el);
    if (CONTAINER_NAMES.has(layerName)) {
      layer.children = [makeTextLayer(doc)];
    } else {
      layer.variables = {
        ...layer.variables,
        text: makeRichTextVariable(doc),
      };
    }
    return layer;
  }

  const children: Layer[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').trim();
      if (text) {
        children.push(makeTextLayer(text));
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const childLayer = elementToLayer(node as Element);
      if (childLayer) {
        children.push(childLayer);
      }
    }
  }

  if (isTextLayer && children.length === 0) {
    layer.variables = {
      ...layer.variables,
      text: makeRichTextVariable(LAYER_NAME_LABELS[layerName] || ''),
    };
    return layer;
  }

  if (children.length > 0) {
    layer.children = children;
  } else if (CONTAINER_NAMES.has(layerName)) {
    layer.children = [];
  }

  return layer;
}

/**
 * Parse an HTML string into a Ycode Layer tree.
 * Converts Tailwind classes to design properties.
 * Absolute image/media URLs are preserved; relative paths become placeholders.
 */
export function htmlToLayers(html: string): Layer[] {
  if (typeof window === 'undefined') return [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const layers: Layer[] = [];
    const body = doc.body;

    for (let i = 0; i < body.childNodes.length; i++) {
      const node = body.childNodes[i];
      if (node.nodeType === Node.ELEMENT_NODE) {
        const layer = elementToLayer(node as Element);
        if (layer) layers.push(layer);
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent || '').trim();
        if (text) {
          layers.push(makeTextLayer(text));
        }
      }
    }

    return layers;
  } catch (err) {
    console.warn('htmlToLayers: failed to parse HTML', err);
    return [];
  }
}

// ─── Export: Layers → HTML ───

const MARK_TO_HTML_TAG: Record<string, string> = {
  bold: 'strong', italic: 'em', underline: 'u', strike: 's',
  subscript: 'sub', superscript: 'sup', code: 'code',
};

function renderTiptapNodeToHtml(node: any): string {
  if (node.type === 'hardBreak') return '<br />';
  if (node.type !== 'text' || !node.text) return '';

  let html = escapeHtml(node.text);
  const marks: any[] = node.marks || [];

  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i];
    const tag = MARK_TO_HTML_TAG[mark.type];
    if (tag) {
      html = `<${tag}>${html}</${tag}>`;
      continue;
    }
    if (mark.type === 'richTextLink') {
      const href = mark.attrs?.url?.data?.content || '#';
      const linkParts = [`href="${escapeHtml(href)}"`];
      if (mark.attrs?.target) linkParts.push(`target="${mark.attrs.target}"`);
      if (mark.attrs?.rel) linkParts.push(`rel="${escapeHtml(mark.attrs.rel)}"`);
      html = `<a ${linkParts.join(' ')}>${html}</a>`;
    }
  }

  return html;
}

function renderTiptapDocToHtml(doc: any): string {
  if (!doc || !doc.content) return '';
  return doc.content
    .map((block: any) => {
      if (!block.content) return '';
      return block.content.map(renderTiptapNodeToHtml).join('');
    })
    .join('\n');
}

function getLayerTextHtml(layer: Layer): string | null {
  const textVar = layer.variables?.text;
  if (!textVar) return null;

  if (textVar.type === 'dynamic_text') {
    return escapeHtml(textVar.data.content);
  }

  if (textVar.type === 'dynamic_rich_text') {
    return renderTiptapDocToHtml((textVar.data as any).content) || null;
  }

  return null;
}

function getVariableContent(variable: any): string {
  if (!variable || !('data' in variable)) return '';
  return (variable.data as any).content || '';
}

function resolveExportTag(layer: Layer): string {
  let tag = getLayerHtmlTag(layer);

  const linkSettings = layer.variables?.link;
  const hasLink = linkSettings?.type === 'url' && linkSettings.url?.data.content;

  if (hasLink && (layer.name === 'div' || layer.name === 'button')) {
    tag = 'a';
  }

  return tag;
}

function buildLinkAttrs(link: LinkSettings): string[] {
  const attrs: string[] = [];
  if (link.url?.data.content) {
    attrs.push(`href="${escapeHtml(link.url.data.content)}"`);
  }
  if (link.target) attrs.push(`target="${link.target}"`);
  if (link.rel) attrs.push(`rel="${escapeHtml(link.rel)}"`);
  return attrs;
}

function layerToHtmlString(layer: Layer, indent: number): string {
  const pad = '  '.repeat(indent);
  const tag = resolveExportTag(layer);
  const classes = getClassesString(layer);

  const attrs: string[] = [];
  if (classes) attrs.push(`class="${escapeHtml(classes)}"`);

  if (layer.attributes?.id) {
    attrs.push(`id="${escapeHtml(layer.attributes.id)}"`);
  }

  const linkSettings = layer.variables?.link;
  if (tag === 'a' && linkSettings) {
    attrs.push(...buildLinkAttrs(linkSettings));
  }

  if (layer.name === 'image') {
    const src = getVariableContent(layer.variables?.image?.src);
    const alt = getVariableContent(layer.variables?.image?.alt);
    if (src) attrs.push(`src="${escapeHtml(src)}"`);
    attrs.push(`alt="${escapeHtml(alt)}"`);
    if (layer.attributes?.width) attrs.push(`width="${escapeHtml(layer.attributes.width)}"`);
    if (layer.attributes?.height) attrs.push(`height="${escapeHtml(layer.attributes.height)}"`);
  }

  if (layer.name === 'input') {
    if (layer.attributes?.type) attrs.push(`type="${escapeHtml(layer.attributes.type)}"`);
    if (layer.attributes?.placeholder) attrs.push(`placeholder="${escapeHtml(layer.attributes.placeholder)}"`);
    if (layer.attributes?.name) attrs.push(`name="${escapeHtml(layer.attributes.name)}"`);
  }

  if (layer.name === 'textarea') {
    if (layer.attributes?.placeholder) attrs.push(`placeholder="${escapeHtml(layer.attributes.placeholder)}"`);
    if (layer.attributes?.name) attrs.push(`name="${escapeHtml(layer.attributes.name)}"`);
    if (layer.attributes?.rows) attrs.push(`rows="${escapeHtml(String(layer.attributes.rows))}"`);
  }

  if (layer.name === 'select') {
    if (layer.attributes?.name) attrs.push(`name="${escapeHtml(layer.attributes.name)}"`);
  }

  if (layer.name === 'form') {
    if (layer.attributes?.action) attrs.push(`action="${escapeHtml(layer.attributes.action)}"`);
    if (layer.attributes?.method) attrs.push(`method="${escapeHtml(layer.attributes.method)}"`);
  }

  if (layer.name === 'iframe') {
    const src = getVariableContent(layer.variables?.iframe?.src);
    if (src) attrs.push(`src="${escapeHtml(src)}"`);
  }

  if (layer.name === 'video' || layer.name === 'audio') {
    const src = getVariableContent(layer.variables?.[layer.name as 'video' | 'audio']?.src);
    if (src) attrs.push(`src="${escapeHtml(src)}"`);
    if (layer.attributes?.controls) attrs.push('controls');
    if (layer.attributes?.loop) attrs.push('loop');
    if (layer.attributes?.muted) attrs.push('muted');
    if (layer.attributes?.autoplay) attrs.push('autoplay');
  }

  const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';

  if (SELF_CLOSING_TAGS.has(tag)) {
    return `${pad}<${tag}${attrStr} />`;
  }

  if (layer.name === 'icon') {
    const iconSrc = layer.variables?.icon?.src;
    if (iconSrc && iconSrc.type === 'static_text') {
      return `${pad}${(iconSrc.data as any).content}`;
    }
    return `${pad}<span${attrStr}></span>`;
  }

  const textHtml = getLayerTextHtml(layer);
  const openTag = `${pad}<${tag}${attrStr}>`;
  const closeTag = `</${tag}>`;

  if (textHtml && (!layer.children || layer.children.length === 0)) {
    return `${openTag}${textHtml}${closeTag}`;
  }

  if (!layer.children || layer.children.length === 0) {
    return `${openTag}${closeTag}`;
  }

  const childHtml = layer.children
    .map((child) => layerToHtmlString(child, indent + 1))
    .join('\n');

  return `${openTag}\n${childHtml}\n${pad}${closeTag}`;
}

/**
 * Convert a single layer and its children to HTML.
 */
export function layerToExportHtml(layer: Layer): string {
  return layerToHtmlString(layer, 0);
}
