/**
 * Tailwind custom variants used by generated user content.
 *
 * These must be registered with every Tailwind compiler that processes
 * user-authored classes (client + server CSS generators) so variants like
 * `current:` (active slider bullet) and `disabled:` (nav buttons) emit rules.
 * Keep in sync with the `@custom-variant` declarations in `app/globals.css`.
 */
export const TAILWIND_CUSTOM_VARIANTS = `@custom-variant current (&[aria-current]);
@custom-variant disabled (&:is(:disabled, [aria-disabled]));`;
