'use client';

import { useEffect, useRef } from 'react';

import { recreateScript } from '@/lib/script-utils';

interface CustomCodeInjectorProps {
  html: string;
}

// One-shot load events that already fired by the time custom code is injected
// (after hydration). Listeners registered now would never run, so we invoke
// them instead — keeps legacy snippets gated on these events working.
const ALREADY_FIRED_EVENTS = new Set(['DOMContentLoaded', 'load']);

/**
 * Patch `addEventListener` on `document`/`window` so registrations for events
 * that already fired during page load run the listener asynchronously. Returns
 * a restore function. Scoped to the injection window to avoid affecting the
 * rest of the app.
 */
function installFiredEventShim(): () => void {
  const targets: (Document | Window)[] = [document, window];
  const originals = new Map<Document | Window, typeof document.addEventListener>();
  const hasFired = (type: string) =>
    type === 'load' ? document.readyState === 'complete' : document.readyState !== 'loading';

  for (const target of targets) {
    const original = target.addEventListener.bind(target);
    originals.set(target, original);
    (target as { addEventListener: typeof document.addEventListener }).addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (ALREADY_FIRED_EVENTS.has(type) && listener && hasFired(type)) {
        setTimeout(() => {
          try {
            const event = new Event(type);
            if (typeof listener === 'function') listener.call(target, event);
            else listener.handleEvent(event);
          } catch (error) {
            console.error('Custom code ready-event handler failed:', error);
          }
        }, 0);
        return;
      }
      original(type, listener, options);
    };
  }

  return () => {
    for (const [target, original] of originals) {
      (target as { addEventListener: typeof document.addEventListener }).addEventListener = original;
    }
  };
}

/**
 * Injects custom HTML/script code after React hydration.
 * Renders an empty container on SSR to avoid hydration mismatches,
 * then injects and executes scripts via useEffect on the client.
 * External scripts are loaded sequentially to preserve dependency order.
 */
export default function CustomCodeInjector({ html }: CustomCodeInjectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = html;

    const scripts = Array.from(container.querySelectorAll('script'));
    let cancelled = false;

    // Make listeners for already-fired load events run while scripts execute.
    const restoreShim = installFiredEventShim();

    // Execute sequentially — dynamically created scripts with `src` are
    // async by default, which breaks dependencies between external libs
    // and inline scripts that use them.
    async function executeScripts() {
      for (const original of scripts) {
        if (cancelled) return;
        const script = recreateScript(original);

        if (script.src) {
          await new Promise<void>((resolve) => {
            script.addEventListener('load', () => resolve());
            script.addEventListener('error', () => resolve());
            original.replaceWith(script);
          });
        } else {
          original.replaceWith(script);
        }
      }
    }

    executeScripts().finally(restoreShim);

    return () => { cancelled = true; restoreShim(); };
  }, [html]);

  return <div ref={containerRef} />;
}
