import React from 'react';
import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import DarkModeProvider from '@/components/DarkModeProvider';

export const defaultMetadata: Metadata = {
  title: 'Ycode - Visual Website Builder',
  description: 'Self-hosted visual website builder',
};

interface RootLayoutShellProps {
  children: React.ReactNode;
  headElements?: React.ReactNode[];
  /**
   * Classes applied to <body>. Consumers can include a `next/font` variable
   * (e.g. `${inter.variable}`) so a font is only loaded on the routes that
   * need it. Defaults to a font-free `font-sans antialiased` so generic
   * `font-sans` references fall back to the system stack — this is what
   * public published sites should use to avoid shipping the builder's UI font.
   */
  bodyClassName?: string;
  /**
   * Language for the <html lang> attribute. Omitted for public published sites
   * so the per-page locale (set on the content wrapper by PageRenderer) is the
   * source of truth instead of a hardcoded `en`.
   */
  lang?: string;
}

export default function RootLayoutShell({
  children,
  headElements,
  bodyClassName = 'font-sans antialiased',
  lang,
}: RootLayoutShellProps) {
  return (
    <html lang={lang} suppressHydrationWarning>
      <head>
        {headElements}
      </head>
      <body className={bodyClassName} suppressHydrationWarning>
        <DarkModeProvider>
          {children}
        </DarkModeProvider>
        <Analytics />
      </body>
    </html>
  );
}
