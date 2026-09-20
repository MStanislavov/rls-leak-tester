"use client";

/**
 * "My shared scenarios" of the Share dialog: every row the signed-in user owns, with its link,
 * who may open it, and delete behind a second click. Titles are text nodes (SEC-001).
 */
import { ExternalLink, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { sharedPath, sharedUrl, VISIBILITY_HELP } from "@/lib/lab/share";
import { VISIBILITIES, type StoredScenarioSummary, type Visibility } from "@/lib/store";
import { CopyButton } from "../copy-button";
import { NativeSelect } from "../native-select";

interface MySharedScenariosProps {
  readonly mine: readonly StoredScenarioSummary[];
  /** The site's origin, for absolute links. */
  readonly origin: string;
  /** The id of the row a request is in flight for; its controls are off meanwhile. */
  readonly busyId: string | null;
  readonly onChangeVisibility: (id: string, visibility: Visibility) => void;
  readonly onDelete: (id: string) => void;
}

function isVisibility(value: string): value is Visibility {
  return (VISIBILITIES as readonly string[]).includes(value);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function MySharedScenarios(props: MySharedScenariosProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <section aria-labelledby="my-shared-heading" className="flex min-w-0 flex-col gap-2">
      <h3 id="my-shared-heading" className="text-sm font-semibold">
        My shared scenarios
      </h3>
      {props.mine.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="my-shared-empty">
          You have not shared a scenario yet.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto" data-testid="my-shared-list">
          {props.mine.map((entry) => {
            const busy = props.busyId === entry.id;
            const selectId = `shared-visibility-${entry.id}`;
            return (
              <li
                key={entry.id}
                data-testid="shared-scenario"
                data-slug={entry.slug}
                data-visibility={entry.visibility}
                className="flex min-w-0 flex-col gap-1.5 rounded-md border p-2"
              >
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                  <p className="min-w-0 truncate text-sm font-medium">{entry.title}</p>
                  <p className="text-xs text-muted-foreground">{formatWhen(entry.updatedAt)}</p>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <a
                    href={sharedPath(entry.slug)}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="shared-scenario-link"
                    className="inline-flex min-w-0 items-center gap-1 rounded font-mono text-xs underline underline-offset-2"
                  >
                    <span className="truncate">{sharedPath(entry.slug)}</span>
                    <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                  <CopyButton
                    text={sharedUrl(props.origin, entry.slug)}
                    label={`Copy the link of ${entry.title}`}
                    testId="shared-scenario-copy"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <label htmlFor={selectId} className="sr-only">
                    Who can open {entry.title}
                  </label>
                  <NativeSelect
                    id={selectId}
                    data-testid="shared-scenario-visibility"
                    className="h-7 w-28 text-xs"
                    disabled={busy}
                    value={entry.visibility}
                    title={VISIBILITY_HELP[entry.visibility]}
                    onChange={(event) => {
                      if (isVisibility(event.target.value)) {
                        props.onChangeVisibility(entry.id, event.target.value);
                      }
                    }}
                  >
                    {VISIBILITIES.map((visibility) => (
                      <option key={visibility} value={visibility}>
                        {visibility}
                      </option>
                    ))}
                  </NativeSelect>
                  {confirmDelete === entry.id ? (
                    <>
                      <Button
                        type="button"
                        variant="destructive"
                        size="xs"
                        disabled={busy}
                        data-testid="shared-scenario-delete-confirm"
                        onClick={() => {
                          setConfirmDelete(null);
                          props.onDelete(entry.id);
                        }}
                      >
                        Delete for everybody
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setConfirmDelete(null)}
                      >
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      aria-label={`Delete the shared scenario ${entry.title}`}
                      data-testid="shared-scenario-delete"
                      onClick={() => setConfirmDelete(entry.id)}
                    >
                      <Trash2 aria-hidden="true" />
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
