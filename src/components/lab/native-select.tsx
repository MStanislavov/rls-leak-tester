import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A native `<select>` in the look of the shadcn inputs. The lab has grids of 60 and more selects
 * (one per expectation); native ones cost nothing to mount, work on a phone and need no portal.
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}
