"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface CopyButtonProps {
  /** What lands on the clipboard. */
  readonly text: string;
  /** Accessible name: "Copy leaked keys", "Copy probe SQL". */
  readonly label: string;
  readonly testId?: string;
}

const CONFIRMATION_MS = 1_500;

export function CopyButton({ text, label, testId }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => toast.error("The browser did not allow access to the clipboard."),
    );
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={copy}
      aria-label={label}
      data-testid={testId}
      data-copied={copied}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
