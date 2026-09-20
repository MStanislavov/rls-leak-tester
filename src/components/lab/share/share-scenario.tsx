"use client";

/**
 * "Share" in the lab's toolbar (brief 3.10). Without Supabase the button stays visible but is
 * marked as unavailable, and says why: in a tooltip, to a screen reader, and in the dialog it
 * still opens. It is `aria-disabled`, not `disabled`, so the keyboard reaches the explanation.
 * With Supabase it opens the Share dialog, whose code is loaded on first use.
 */
import dynamic from "next/dynamic";
import { Share2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_SHARE_VISIBILITY, SHARE_DISABLED_EXPLANATION } from "@/lib/lab/share";
import type { StoredScenario, Visibility } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { LabSlotProps } from "../lab-extensions";
import { useSharingAvailability } from "./use-sharing-availability";

const ShareDialog = dynamic(() => import("./share-dialog").then((module) => module.ShareDialog), {
  ssr: false,
});

const CHECKING = "Checking whether this deployment can share scenarios.";

function SharingUnavailable({ explanation }: { readonly explanation: string }) {
  return (
    <DialogContent data-testid="share-disabled-dialog">
      <DialogHeader>
        <DialogTitle>Sharing is not available here</DialogTitle>
        <DialogDescription data-testid="share-disabled-text">{explanation}</DialogDescription>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Nothing else depends on it. Save keeps the scenario in this browser, and Export scenario
        JSON in the Scenario menu gives you a file you can send to somebody.
      </p>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Close
          </Button>
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  );
}

export function ShareScenario(props: LabSlotProps) {
  const availability = useSharingAvailability();
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState<StoredScenario | null>(null);
  const [visibility, setVisibility] = useState<Visibility>(DEFAULT_SHARE_VISIBILITY);
  const hintId = useId();
  const enabled = availability === "enabled";
  const explanation = availability === "checking" ? CHECKING : SHARE_DISABLED_EXPLANATION;

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="share-button"
              data-availability={availability}
              aria-disabled={!enabled}
              aria-describedby={enabled ? undefined : hintId}
              className={cn(!enabled && "cursor-not-allowed opacity-60")}
              onClick={() => setOpen(true)}
            >
              <Share2 aria-hidden="true" />
              Share
            </Button>
          </TooltipTrigger>
          {enabled ? null : (
            <TooltipContent data-testid="share-disabled-tooltip">{explanation}</TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      {enabled ? null : (
        <span id={hintId} className="sr-only">
          {explanation}
        </span>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        {enabled ? null : <SharingUnavailable explanation={explanation} />}
        {enabled && open ? (
          <ShareDialog
            lab={props}
            shared={shared}
            onShared={setShared}
            visibility={visibility}
            onVisibility={setVisibility}
          />
        ) : null}
      </Dialog>
    </>
  );
}
