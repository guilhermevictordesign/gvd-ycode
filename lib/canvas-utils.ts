/**
 * Canvas configuration constants and shared utilities
 */

/**
 * Border/padding around the iframe canvas (in pixels)
 * Applied on all sides (top, right, bottom, left)
 */
export const CANVAS_BORDER = 20;

/**
 * Total padding (border on both sides)
 * Used for calculations: left + right or top + bottom
 */
export const CANVAS_PADDING = CANVAS_BORDER * 2;

const VIEWPORT_HEIGHT_UNITS = ['vh', 'svh', 'dvh', 'lvh'] as const;

/**
 * Maps a Tailwind utility prefix to the CSS properties it sets.
 * Multi-axis utilities (e.g. `mx`, `py`, `inset-y`) map to multiple properties.
 */
const PREFIX_TO_CSS_PROPS: Record<string, string[]> = {
  // Sizing
  h: ['height'],
  'min-h': ['min-height'],
  'max-h': ['max-height'],
  w: ['width'],
  'min-w': ['min-width'],
  'max-w': ['max-width'],
  size: ['width', 'height'],

  // Margin
  m: ['margin'],
  mx: ['margin-left', 'margin-right'],
  my: ['margin-top', 'margin-bottom'],
  mt: ['margin-top'],
  mr: ['margin-right'],
  mb: ['margin-bottom'],
  ml: ['margin-left'],
  ms: ['margin-inline-start'],
  me: ['margin-inline-end'],

  // Padding
  p: ['padding'],
  px: ['padding-left', 'padding-right'],
  py: ['padding-top', 'padding-bottom'],
  pt: ['padding-top'],
  pr: ['padding-right'],
  pb: ['padding-bottom'],
  pl: ['padding-left'],
  ps: ['padding-inline-start'],
  pe: ['padding-inline-end'],

  // Position
  top: ['top'],
  right: ['right'],
  bottom: ['bottom'],
  left: ['left'],
  start: ['inset-inline-start'],
  end: ['inset-inline-end'],
  inset: ['top', 'right', 'bottom', 'left'],
  'inset-x': ['left', 'right'],
  'inset-y': ['top', 'bottom'],

  // Gap
  gap: ['gap'],
  'gap-x': ['column-gap'],
  'gap-y': ['row-gap'],

  // Translate (uses CSS variables; we emit the resolved transform directly)
  'translate-x': ['translate-x'],
  'translate-y': ['translate-y'],
  translate: ['translate-x', 'translate-y'],
};

const PREFIXES_PATTERN = Object.keys(PREFIX_TO_CSS_PROPS)
  .map(p => p.replace(/-/g, '\\-'))
  .sort((a, b) => b.length - a.length) // Longest first so e.g. `min-h` matches before `m`
  .join('|');

const VIEWPORT_LENGTH_PATTERN = new RegExp(
  `^(${PREFIXES_PATTERN})-\\[(-?\\d+(?:\\.\\d+)?)(${VIEWPORT_HEIGHT_UNITS.join('|')})\\]$`
);

/**
 * Static utilities that resolve to 100vh equivalents (h-screen, min-h-dvh, etc.).
 * All become the reference height in pixels.
 */
const NAMED_VIEWPORT_UTILITIES: Record<string, string> = {
  'h-screen': 'height',
  'min-h-screen': 'min-height',
  'max-h-screen': 'max-height',
  'h-dvh': 'height',
  'min-h-dvh': 'min-height',
  'max-h-dvh': 'max-height',
  'h-svh': 'height',
  'min-h-svh': 'min-height',
  'max-h-svh': 'max-height',
  'h-lvh': 'height',
  'min-h-lvh': 'min-height',
  'max-h-lvh': 'max-height',
};

function escapeSelector(cls: string): string {
  return cls.replace(/([[\](){}.:!#%^&*+?<>~=|@/\\])/g, '\\$1');
}

/** Builds the CSS declarations for a class given its CSS properties and a pixel value. */
function buildDeclarations(props: string[], pixels: number): string {
  const declarations: string[] = [];
  for (const prop of props) {
    if (prop === 'translate-x') {
      declarations.push(`--tw-translate-x:${pixels}px`);
    } else if (prop === 'translate-y') {
      declarations.push(`--tw-translate-y:${pixels}px`);
    } else {
      declarations.push(`${prop}:${pixels}px !important`);
    }
  }
  return declarations.join(';');
}

/**
 * Generates CSS that overrides viewport-height units (vh, svh, dvh, lvh) with
 * fixed pixel values based on a reference viewport height. This prevents a
 * feedback loop where the iframe expands to fit content, viewport-unit layers
 * grow with it, and the measured height keeps increasing.
 *
 * Covers all Tailwind length utilities (sizing, margin, padding, position,
 * gap, translate), not just height ones — otherwise classes like
 * `mt-[10vh]` keep recalculating against the iframe's growing height.
 */
export function updateViewportOverrides(doc: Document, referenceHeight: number): void {
  if (referenceHeight <= 0) return;

  let styleEl = doc.getElementById('ycode-viewport-overrides');
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.id = 'ycode-viewport-overrides';
    doc.head.appendChild(styleEl);
  }

  const rules: string[] = [];
  const seen = new Set<string>();

  doc.querySelectorAll('[class]').forEach(el => {
    const classes = (el.getAttribute('class') || '').split(/\s+/);
    for (const cls of classes) {
      if (seen.has(cls)) continue;

      // Skip responsive/state variants — overriding without media queries
      // would apply the override at ALL breakpoints, which is incorrect
      if (cls.includes(':')) continue;

      const namedProp = NAMED_VIEWPORT_UTILITIES[cls];
      if (namedProp) {
        seen.add(cls);
        rules.push(`.${escapeSelector(cls)}{${namedProp}:${referenceHeight}px !important}`);
        continue;
      }

      const match = cls.match(VIEWPORT_LENGTH_PATTERN);
      if (match) {
        seen.add(cls);
        const [, prefix, value] = match;
        const pixels = (parseFloat(value) / 100) * referenceHeight;
        const props = PREFIX_TO_CSS_PROPS[prefix];
        if (props) {
          rules.push(`.${escapeSelector(cls)}{${buildDeclarations(props, pixels)}}`);
        }
      }
    }
  });

  const css = rules.join('\n');
  if (styleEl.textContent !== css) {
    styleEl.textContent = css;
  }
}

/**
 * Measures the actual content extent (bottom of last visible child) rather than
 * scrollHeight, which includes viewport-filling styles like h-full / min-h-screen
 * on html/body that inflate the measured height beyond actual content.
 *
 * Only iterates direct children of <body> (with display:contents recursion).
 * Deep recursion is intentionally avoided: descendants positioned absolutely
 * relative to the iframe viewport (e.g. `position: absolute; bottom: -6rem`
 * with no positioned ancestor) would extend past iframe bottom and create a
 * feedback loop — each measurement would grow the iframe, pushing the absolute
 * further down, growing the iframe again. In-flow content is already captured
 * by the body container's height.
 */
export function measureContentExtent(doc: Document): number {
  const body = doc.body;
  if (!body || body.children.length === 0) return 0;

  const bodyRect = body.getBoundingClientRect();
  let maxBottom = 0;
  const win = doc.defaultView;

  const measure = (parent: Element) => {
    for (let i = 0; i < parent.children.length; i++) {
      const el = parent.children[i];
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') continue;

      // display:contents elements have no box — recurse into their children
      if (win && win.getComputedStyle(el).display === 'contents') {
        measure(el);
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      maxBottom = Math.max(maxBottom, rect.bottom - bodyRect.top);
    }
  };

  measure(body);

  return Math.max(maxBottom, 0);
}

/**
 * Shared HTML template for canvas-style iframes with Tailwind Browser CDN.
 * Used by both the editor Canvas and the thumbnail capture hook.
 * @param mountId - The ID of the mount point div (default: 'canvas-mount')
 */
export function getCanvasIframeHtml(mountId: string = 'canvas-mount'): string {
  return `<!DOCTYPE html>
<html class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <style type="text/tailwindcss">
    @custom-variant current (&[aria-current]);
    @custom-variant disabled (&:is(:disabled, [aria-disabled]));
    @theme {
      /* Editor UI colors for context menus portaled into the iframe */
      --color-popover: oklch(0.269 0 0);
      --color-popover-foreground: oklch(0.708 0 0);
      --color-accent: oklch(0.32 0 0);
      --color-accent-foreground: oklch(0.985 0 0);
      --color-muted-foreground: oklch(0.708 0 0);
      --color-foreground: oklch(0.985 0 0);
      --color-border: oklch(1 0 0 / 5%);
      --color-destructive: oklch(0.704 0.191 22.216);
    }
  </style>
  <style id="ycode-fonts-style">
    /* Font CSS (Google @import + custom @font-face) injected dynamically */
  </style>
  <style>
    /* Custom dropdown chevron for select elements (native arrow removed by form reset) */
    select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") !important;
      background-repeat: no-repeat !important;
      background-position: right 12px center !important;
      background-size: 16px 16px !important;
    }
  </style>
  <link rel="stylesheet" href="/canvas.css?v=0.2.1.4">
  <style id="ycode-viewport-overrides">
    /* Dynamically populated: overrides vh/svh/dvh/lvh with fixed px values */
  </style>
</head>
<body class="h-full">
  <div id="${mountId}" class="contents"></div>
</body>
</html>`;
}
