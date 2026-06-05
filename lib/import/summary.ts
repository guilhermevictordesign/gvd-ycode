/**
 * Shared helpers for building import/paste summary toasts. Keeps the
 * "N thing(s)" pluralisation in one place across the Webflow and Figma flows.
 */

/** `plural(1, 'layer')` → "1 layer"; `plural(3, 'layer')` → "3 layers". */
export function plural(count: number, noun: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? noun : pluralForm ?? `${noun}s`}`;
}
