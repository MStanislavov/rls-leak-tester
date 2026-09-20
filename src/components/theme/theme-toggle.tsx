"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

interface ThemeOption {
  readonly value: "light" | "dark" | "system";
  readonly label: string;
  readonly Icon: LucideIcon;
}

const OPTIONS: readonly ThemeOption[] = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "system", label: "System theme", Icon: Monitor },
];

const subscribeToNothing = () => () => {};

/**
 * False on the server and during hydration, true afterwards. The stored theme is only known in
 * the browser, so the pressed state is rendered after hydration and never mismatches the HTML.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

/** Light, dark or system. Three buttons, so the current choice and the alternatives are visible. */
export function ThemeToggle({ className }: { readonly className?: string }) {
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();
  const active = hydrated ? theme : undefined;

  return (
    <div
      role="group"
      aria-label="Theme"
      data-testid="theme-toggle"
      className={cn("inline-flex items-center gap-0.5 rounded-lg border p-0.5", className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={active === value}
          onClick={() => setTheme(value)}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
        >
          <Icon aria-hidden="true" className="size-4" />
        </button>
      ))}
    </div>
  );
}
