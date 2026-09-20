"use client";

/**
 * "Fork to my lab" on `/s/[slug]`: a copy of the shared scenario under a new id in THIS browser's
 * local store, then the lab opens it (`/lab?saved=<id>`). Nothing is sent anywhere.
 */
import { GitFork } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { forkToLab, shareErrorMessage } from "@/lib/lab/share";
import { createLocalScenarioStore } from "@/lib/store";
import type { LabSlotProps } from "../lab-extensions";

export function ForkToLab({ getScenario }: LabSlotProps) {
  const router = useRouter();
  const [forking, setForking] = useState(false);

  const fork = (): void => {
    setForking(true);
    forkToLab(createLocalScenarioStore(), getScenario()).then(
      (path) => router.push(path),
      (error: unknown) => {
        setForking(false);
        toast.error(shareErrorMessage(error));
      },
    );
  };

  return (
    <Button
      type="button"
      variant="outline"
      disabled={forking}
      data-testid="fork-button"
      onClick={fork}
    >
      <GitFork aria-hidden="true" />
      Fork to my lab
    </Button>
  );
}
