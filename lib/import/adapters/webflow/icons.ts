/**
 * Webflow built-in widget icons → inline SVG.
 *
 * Webflow's slider/dropdown/nav widgets carry a named glyph from its built-in
 * icon font, e.g. `data.widget = { type: 'icon', icon: 'slider-left' }`. That
 * font isn't available in Ycode, so we map the common glyphs to clean inline
 * SVGs (currentColor, so they inherit text colour). Unknown glyphs return null
 * and the caller drops the node, as before.
 */

/** Wrap an SVG body in a currentColor, stroke-based 24x24 icon. */
function stroke(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

const WEBFLOW_ICONS: Record<string, string> = {
  // Slider arrows.
  'slider-left': stroke('<polyline points="15 18 9 12 15 6"/>'),
  'slider-right': stroke('<polyline points="9 18 15 12 9 6"/>'),
  // Dropdown / accordion chevron.
  'dropdown-toggle': stroke('<polyline points="6 9 12 15 18 9"/>'),
  // Nav menu (hamburger) + close.
  'nav-menu': stroke('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>'),
  'nav-menu-open': stroke('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

/** Return inline SVG markup for a Webflow widget icon name, or null if unmapped. */
export function webflowIconSvg(name?: string): string | null {
  if (!name) return null;
  return WEBFLOW_ICONS[name] ?? null;
}
