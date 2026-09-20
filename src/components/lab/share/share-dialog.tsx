"use client";

/**
 * The body of the Share dialog on a deployment with Supabase: sign in, save the working scenario
 * through the app's own `/api/scenarios` routes (the remote `ScenarioStore`), show its link, and
 * manage what was shared before. The server checks the session on every call; this component
 * only decides what is shown.
 */
import { Link2, LogIn } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getPublicConfig } from "@/lib/config/public";
import { validateLabScenario } from "@/lib/lab";
import {
  changeVisibility,
  loadShareSession,
  shareErrorMessage,
  sharedUrl,
  signInReturnPath,
  VISIBILITY_HELP,
  withSharedSummary,
  type ShareSession,
} from "@/lib/lab/share";
import {
  createLocalScenarioStore,
  createRemoteScenarioStore,
  VISIBILITIES,
  type StoredScenario,
  type Visibility,
} from "@/lib/store";
import { getAuthClient } from "@/lib/store/auth-client";
import { CopyButton } from "../copy-button";
import type { LabSlotProps } from "../lab-extensions";
import { MySharedScenarios } from "./my-shared-scenarios";

interface ShareDialogProps {
  readonly lab: LabSlotProps;
  /** What this lab session shared last; the parent keeps it while the dialog is closed. */
  readonly shared: StoredScenario | null;
  readonly onShared: (stored: StoredScenario | null) => void;
  readonly visibility: Visibility;
  readonly onVisibility: (visibility: Visibility) => void;
}

function siteOrigin(): string {
  return getPublicConfig().siteUrl ?? window.location.origin;
}

/** What the dialog offers before there is a session: the way to get one. */
function SignedOutPanel({
  signInEnabled,
  onSignIn,
}: {
  readonly signInEnabled: boolean;
  readonly onSignIn: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2" data-testid="share-signed-out">
      <p className="text-sm">
        Sign in with GitHub to share. Your work is kept: when it has changes, a copy is saved in
        this browser first and reopened after you come back.
      </p>
      <Button
        type="button"
        disabled={!signInEnabled}
        data-testid="share-sign-in"
        onClick={onSignIn}
      >
        <LogIn aria-hidden="true" />
        Sign in with GitHub
      </Button>
      {signInEnabled ? null : (
        <p className="text-xs text-muted-foreground">
          This build was made without the public Supabase variables, so it has no sign-in. Rebuild
          with them set; see docs/DEPLOY.md.
        </p>
      )}
    </div>
  );
}

/** The link of the copy this lab session shared; nothing before the first share. */
function SharedLink({
  shared,
  inputId,
}: {
  readonly shared: StoredScenario | null;
  readonly inputId: string;
}) {
  if (shared === null) {
    return null;
  }
  const url = sharedUrl(siteOrigin(), shared.slug);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="share-result">
      <Label htmlFor={inputId}>
        Link ({shared.visibility}). It shows the scenario as it was when you shared it.
      </Label>
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          id={inputId}
          readOnly
          data-testid="share-link"
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <CopyButton text={url} label="Copy the link" testId="share-link-copy" />
      </div>
    </div>
  );
}

export function ShareDialog({ lab, shared, onShared, visibility, onVisibility }: ShareDialogProps) {
  const store = useMemo(() => createRemoteScenarioStore(), []);
  const auth = useMemo(() => getAuthClient(), []);
  const [session, setSession] = useState<ShareSession | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupId = useId();

  useEffect(() => {
    let active = true;
    void loadShareSession({ auth, store }).then((next) => {
      if (active) {
        setSession(next);
      }
    });
    return () => {
      active = false;
    };
  }, [auth, store]);

  // A link belongs to the scenario it was made from, not to whatever is open now.
  const current = shared !== null && shared.scenario.id === lab.scenario.id ? shared : null;
  const valid = lab.validation.scenario !== null;
  // A session that could not be read outranks the error of the last action.
  const errorMessage = session?.status === "error" ? session.message : error;

  const fail = useCallback((cause: unknown) => setError(shareErrorMessage(cause)), []);

  const signIn = (): void => {
    setError(null);
    void signInReturnPath(createLocalScenarioStore(), {
      origin: lab.origin,
      dirty: lab.dirty,
      scenario: validateLabScenario(lab.getScenario()).scenario,
    })
      .then((path) => auth.signInWithGitHub(path))
      .catch(() => setError("Sign-in with GitHub could not be started."));
  };

  const share = (): void => {
    const checked = validateLabScenario(lab.getScenario()).scenario;
    if (checked === null) {
      setError("The scenario has problems. Fix what the lab reports, then share it.");
      return;
    }
    setSaving(true);
    setError(null);
    store
      .save(
        current === null
          ? { scenario: checked, visibility }
          : { id: current.id, scenario: checked, visibility },
      )
      .then((stored) => {
        onShared(stored);
        setSession((before) =>
          before?.status === "signed-in"
            ? { status: "signed-in", mine: withSharedSummary(before.mine, stored) }
            : before,
        );
      }, fail)
      .finally(() => setSaving(false));
  };

  const setRowVisibility = (id: string, next: Visibility): void => {
    setBusyId(id);
    setError(null);
    changeVisibility(store, id, next)
      .then((stored) => {
        if (current?.id === stored.id) {
          onShared(stored);
        }
        setSession((before) =>
          before?.status === "signed-in"
            ? { status: "signed-in", mine: withSharedSummary(before.mine, stored) }
            : before,
        );
      }, fail)
      .finally(() => setBusyId(null));
  };

  const removeRow = (id: string): void => {
    setBusyId(id);
    setError(null);
    store
      .remove(id)
      .then(() => {
        if (current?.id === id) {
          onShared(null);
        }
        setSession((before) =>
          before?.status === "signed-in"
            ? { status: "signed-in", mine: before.mine.filter((entry) => entry.id !== id) }
            : before,
        );
      }, fail)
      .finally(() => setBusyId(null));
  };

  return (
    <DialogContent
      data-testid="share-dialog"
      data-session={session?.status ?? "checking"}
      className="sm:max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>Share this scenario</DialogTitle>
        <DialogDescription>
          A shared scenario gets a link that opens it read-only. Whoever opens it runs its SQL in
          their own browser; nothing runs on a server.
        </DialogDescription>
      </DialogHeader>

      {session === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking your session
        </p>
      ) : null}

      {session?.status === "signed-out" ? (
        <SignedOutPanel signInEnabled={auth.enabled} onSignIn={signIn} />
      ) : null}

      {session?.status === "signed-in" ? (
        <>
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-semibold">Who can open it</legend>
            {VISIBILITIES.map((option) => {
              const id = `${groupId}-${option}`;
              return (
                <div key={option} className="flex items-start gap-2">
                  <input
                    type="radio"
                    id={id}
                    name={groupId}
                    value={option}
                    checked={visibility === option}
                    disabled={saving}
                    data-testid={`share-visibility-${option}`}
                    aria-describedby={`${id}-help`}
                    className="mt-1 size-4 accent-primary"
                    onChange={() => onVisibility(option)}
                  />
                  <div className="flex flex-col">
                    <Label htmlFor={id} className="font-mono text-sm">
                      {option}
                    </Label>
                    <p id={`${id}-help`} className="text-xs text-muted-foreground">
                      {VISIBILITY_HELP[option]}
                    </p>
                  </div>
                </div>
              );
            })}
          </fieldset>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={saving || !valid}
              data-testid="share-submit"
              onClick={share}
            >
              <Link2 aria-hidden="true" />
              {current === null ? "Create the link" : "Update the shared copy"}
            </Button>
            {valid ? null : (
              <p className="text-xs font-medium text-status-overblock">
                The scenario has problems. Fix what the lab reports, then share it.
              </p>
            )}
          </div>

          <SharedLink shared={current} inputId={`${groupId}-link`} />
        </>
      ) : null}

      {errorMessage === null ? null : (
        <p role="alert" data-testid="share-error" className="text-sm font-medium text-status-leak">
          {errorMessage}
        </p>
      )}

      {session?.status === "signed-in" ? (
        <MySharedScenarios
          mine={session.mine}
          origin={siteOrigin()}
          busyId={busyId}
          onChangeVisibility={setRowVisibility}
          onDelete={removeRow}
        />
      ) : null}
    </DialogContent>
  );
}
