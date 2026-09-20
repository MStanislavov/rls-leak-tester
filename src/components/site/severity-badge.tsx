import { CircleAlert, Flame, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Severity } from "@/lib/checks";
import { cn } from "@/lib/utils";

/** Severity of a static check: an icon and a word, never colour alone. */
export const SEVERITY_ICONS: Record<Severity, LucideIcon> = {
  critical: Flame,
  high: TriangleAlert,
  medium: CircleAlert,
  info: Info,
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  info: "Info",
};

export const SEVERITY_CLASSES: Record<Severity, string> = {
  critical: "border-status-leak/40 bg-status-leak-bg text-status-leak",
  high: "border-status-overblock/40 bg-status-overblock-bg text-status-overblock",
  medium: "border-status-inconclusive/50 bg-status-inconclusive-bg text-status-inconclusive",
  info: "border-status-skipped/40 bg-status-skipped-bg text-status-skipped",
};

interface SeverityBadgeProps {
  readonly severity: Severity;
  readonly className?: string;
}

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  const Icon = SEVERITY_ICONS[severity];
  return (
    <span
      data-severity={severity}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        SEVERITY_CLASSES[severity],
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {SEVERITY_LABELS[severity]}
    </span>
  );
}
