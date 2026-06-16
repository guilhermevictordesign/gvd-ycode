import React from 'react';

/**
 * Maps lowercase HTML attribute names to their React/JSX camelCase equivalents.
 * Shared by head-HTML parsing and the layer renderers so imported markup never
 * leaks invalid DOM props (e.g. `fetchpriority`) onto React elements.
 */
export const HTML_TO_REACT_ATTRS: Record<string, string> = {
  'class': 'className',
  'for': 'htmlFor',
  'autofocus': 'autoFocus',
  'crossorigin': 'crossOrigin',
  'charset': 'charSet',
  'http-equiv': 'httpEquiv',
  'tabindex': 'tabIndex',
  'nomodule': 'noModule',
  'referrerpolicy': 'referrerPolicy',
  'fetchpriority': 'fetchPriority',
};

const TAG_REGEX =
  /<(meta|link|base)(\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>|<(style|script|title|noscript)(\s[^>]*)?>[\s\S]*?<\/\3\s*>/gi;

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function toReactAttrs(attrs: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    result[HTML_TO_REACT_ATTRS[key.toLowerCase()] || key] = value;
  }
  return result;
}

function extractInnerHtml(full: string, tag: string): string {
  const m = full.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*)<\\/${tag}\\s*>`, 'i'));
  return m ? m[1] : '';
}

const STYLE_BLOCK_REGEX = /<style[^>]*>([\s\S]*?)<\/style\s*>/gi;

/**
 * Concatenates the inner CSS of every `<style>` block in an HTML string.
 * Used by the builder canvas to live-preview user-defined CSS variables
 * declared in custom head code, without executing any `<script>` tags.
 */
export function extractStyleBlockContents(html: string | null | undefined): string {
  if (!html) return '';
  const parts: string[] = [];
  STYLE_BLOCK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STYLE_BLOCK_REGEX.exec(html)) !== null) {
    const inner = match[1].trim();
    if (inner) parts.push(inner);
  }
  return parts.join('\n');
}

/**
 * Renders global head HTML as React elements for direct placement inside
 * the root layout's <head>. Bypasses next/script to avoid self.__next_s
 * serialization — the browser executes scripts during head parsing.
 */
export function renderRootLayoutHeadCode(html: string, prefix = 'global-head'): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  TAG_REGEX.lastIndex = 0;

  let match;
  let idx = 0;

  while ((match = TAG_REGEX.exec(html)) !== null) {
    const voidTag = match[1]?.toLowerCase();
    const voidAttrStr = match[2] || '';
    const pairedTag = match[3]?.toLowerCase();
    const pairedAttrStr = match[4] || '';

    // Third-party scripts (AdSense, GTM, etc.) mutate their own head tags at
    // runtime (e.g. adding `data-checked-head`), so the live DOM diverges from
    // the SSR markup. suppressHydrationWarning silences these expected diffs.
    if (voidTag) {
      const attrs = toReactAttrs(parseAttributes(voidAttrStr.trim()));
      elements.push(React.createElement(voidTag, { key: `${prefix}-${idx++}`, suppressHydrationWarning: true, ...attrs }));
    } else if (pairedTag === 'script') {
      const attrs = parseAttributes(pairedAttrStr.trim());
      const inner = extractInnerHtml(match[0], 'script');
      const reactAttrs = toReactAttrs(attrs);
      const props: Record<string, unknown> = {
        key: `${prefix}-${idx++}`,
        suppressHydrationWarning: true,
        ...reactAttrs,
      };
      if (inner) {
        props.dangerouslySetInnerHTML = { __html: inner };
      }
      elements.push(React.createElement('script', props));
    } else if (pairedTag === 'style') {
      const attrs = toReactAttrs(parseAttributes(pairedAttrStr.trim()));
      const inner = extractInnerHtml(match[0], 'style');
      elements.push(
        React.createElement('style', {
          key: `${prefix}-${idx++}`,
          suppressHydrationWarning: true,
          ...attrs,
          dangerouslySetInnerHTML: { __html: inner },
        }),
      );
    } else if (pairedTag === 'title') {
      const inner = extractInnerHtml(match[0], 'title');
      elements.push(React.createElement('title', { key: `${prefix}-${idx++}`, suppressHydrationWarning: true }, inner));
    } else if (pairedTag) {
      const attrs = toReactAttrs(parseAttributes(pairedAttrStr.trim()));
      const inner = extractInnerHtml(match[0], pairedTag);
      elements.push(
        React.createElement(pairedTag, {
          key: `${prefix}-${idx++}`,
          suppressHydrationWarning: true,
          ...attrs,
          dangerouslySetInnerHTML: { __html: inner },
        }),
      );
    }
  }

  return elements;
}
