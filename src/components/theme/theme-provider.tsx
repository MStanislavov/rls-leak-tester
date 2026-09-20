"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

interface ThemeProviderProps {
  readonly children: ReactNode;
  /**
   * The per-request CSP nonce. `next-themes` renders an inline script that sets the theme class
   * before first paint; without the nonce the policy blocks it (ADR 0003, trap 6).
   */
  readonly nonce: string | undefined;
}

export function ThemeProvider({ children, nonce }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...(nonce === undefined ? {} : { nonce })}
    >
      {children}
    </NextThemesProvider>
  );
}
