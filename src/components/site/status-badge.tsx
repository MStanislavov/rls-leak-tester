import {
  CircleCheck,
  CircleMinus,
  CircleQuestionMark,
  Hourglass,
  OctagonAlert,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestionMark,
  SquareArrowOutUpRight,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { CellStatus, Verdict } from "@/lib/runner";
import { statusMeta } from "@/lib/site/status";
import { cn } from "@/lib/utils";

/**
 * A status is never colour alone (brief 3.3): every status has its own icon AND its own word.
 * These maps are the single place that decides both; the matrix, the legend and the docs use
 * them. No hooks and no "use client", so the components render on the server and in the lab.
 */
export const STATUS_ICONS: Record<CellStatus, LucideIcon> = {
  pass: CircleCheck,
  leak: OctagonAlert,
  escape: SquareArrowOutUpRight,
  overblock: TriangleAlert,
  inconclusive: CircleQuestionMark,
  skipped: CircleMinus,
};

/** Text colour plus tint. Complete class names, so Tailwind sees them. */
export const STATUS_CLASSES: Record<CellStatus, string> = {
  pass: "border-status-pass/30 bg-status-pass-bg text-status-pass",
  leak: "border-status-leak/40 bg-status-leak-bg text-status-leak",
  escape: "border-status-escape/40 bg-status-escape-bg text-status-escape",
  overblock: "border-status-overblock/40 bg-status-overblock-bg text-status-overblock",
  inconclusive:
    "border-dashed border-status-inconclusive/50 bg-status-inconclusive-bg text-status-inconclusive",
  skipped: "border-dashed border-status-skipped/40 bg-status-skipped-bg text-status-skipped",
};

/** An inconclusive cell whose probe timed out: its own icon beside its own word ("Timed out"). */
export const TIMED_OUT_ICON: LucideIcon = Hourglass;

interface StatusBadgeProps {
  readonly status: CellStatus;
  readonly size?: "sm" | "md";
  readonly className?: string;
  /** The word of a timed-out cell. The colours stay those of `status`; icon and word change. */
  readonly timedOutLabel?: string;
}

export function StatusBadge({ status, size = "md", className, timedOutLabel }: StatusBadgeProps) {
  const Icon = timedOutLabel === undefined ? STATUS_ICONS[status] : TIMED_OUT_ICON;
  const label = timedOutLabel ?? statusMeta(status).label;
  return (
    <span
      data-status={status}
      data-timed-out={timedOutLabel === undefined ? undefined : true}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-medium whitespace-nowrap",
        size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm",
        STATUS_CLASSES[status],
        className,
      )}
    >
      <Icon aria-hidden="true" className={size === "sm" ? "size-3.5" : "size-4"} />
      {label}
    </span>
  );
}

export const VERDICT_ICONS: Record<Verdict, LucideIcon> = {
  ISOLATED: ShieldCheck,
  LEAKING: ShieldAlert,
  "NOT PROVEN": ShieldQuestionMark,
};

export const VERDICT_CLASSES: Record<Verdict, string> = {
  ISOLATED: "border-status-pass/40 bg-status-pass-bg text-status-pass",
  LEAKING: "border-status-leak/40 bg-status-leak-bg text-status-leak",
  "NOT PROVEN":
    "border-dashed border-status-inconclusive/50 bg-status-inconclusive-bg text-status-inconclusive",
};

interface VerdictBadgeProps {
  readonly verdict: Verdict;
  readonly className?: string;
}

/** The verdict word with its icon. The words are the runner's own: ISOLATED, LEAKING, NOT PROVEN. */
export function VerdictBadge({ verdict, className }: VerdictBadgeProps) {
  const Icon = VERDICT_ICONS[verdict];
  return (
    <span
      data-verdict={verdict}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-sm font-semibold tracking-wide whitespace-nowrap",
        VERDICT_CLASSES[verdict],
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      {verdict}
    </span>
  );
}
