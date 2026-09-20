"use client";

/**
 * Save, Save as, Open, Delete (the local store), New, Import and Export (scenario JSON). The
 * store is a port: the lab talks to `ScenarioStore`, not to `localStorage`.
 */
import {
  ChevronDown,
  Download,
  FilePlus,
  FolderOpen,
  Save,
  SaveAll,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_TITLE_LENGTH } from "@/lib/scenario";
import type { StoredScenarioSummary } from "@/lib/store";

interface ScenarioMenuProps {
  readonly disabled: boolean;
  /** `false` while the scenario does not validate: it can then neither be saved nor exported. */
  readonly canSave: boolean;
  readonly title: string;
  readonly savedId: string | null;
  readonly onNew: () => void;
  readonly onSave: () => void;
  readonly onSaveAs: (title: string) => void;
  readonly onExport: () => void;
  readonly onImportFile: (file: File) => void;
  readonly listSaved: () => Promise<StoredScenarioSummary[]>;
  readonly onOpenSaved: (id: string) => void;
  readonly onDeleteSaved: (id: string) => Promise<void>;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function ScenarioMenu(props: ScenarioMenuProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [saveAsTitle, setSaveAsTitle] = useState<string | null>(null);
  const [saved, setSaved] = useState<StoredScenarioSummary[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const openList = (): void => {
    setConfirmDelete(null);
    void props.listSaved().then(setSaved);
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // The same file can be chosen twice in a row.
    event.target.value = "";
    if (file !== undefined) {
      props.onImportFile(file);
    }
  };

  const trimmedTitle = saveAsTitle?.trim() ?? "";

  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.disabled || !props.canSave}
        data-testid="scenario-save"
        onClick={() => (props.savedId === null ? setSaveAsTitle(props.title) : props.onSave())}
      >
        <Save aria-hidden="true" />
        Save
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.disabled}
            data-testid="scenario-menu"
          >
            Scenario
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem data-testid="scenario-new" onSelect={props.onNew}>
            <FilePlus aria-hidden="true" />
            New blank scenario
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="scenario-open" onSelect={openList}>
            <FolderOpen aria-hidden="true" />
            Open a saved scenario
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="scenario-save-as"
            disabled={!props.canSave}
            onSelect={() => setSaveAsTitle(props.title)}
          >
            <SaveAll aria-hidden="true" />
            Save as
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="scenario-import"
            onSelect={() => fileInput.current?.click()}
          >
            <Upload aria-hidden="true" />
            Import scenario JSON
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="scenario-export"
            disabled={!props.canSave}
            onSelect={props.onExport}
          >
            <Download aria-hidden="true" />
            Export scenario JSON
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        aria-label="Scenario JSON file to import"
        data-testid="scenario-import-input"
        className="sr-only"
        tabIndex={-1}
        onChange={onFile}
      />

      <Dialog
        open={saveAsTitle !== null}
        onOpenChange={(open) => (open ? undefined : setSaveAsTitle(null))}
      >
        <DialogContent data-testid="save-as-dialog">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmedTitle !== "") {
                props.onSaveAs(trimmedTitle);
                setSaveAsTitle(null);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Save in this browser</DialogTitle>
              <DialogDescription>
                The scenario is stored in this browser&apos;s local storage. Nothing is sent
                anywhere.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1">
              <Label htmlFor="save-as-title">Title</Label>
              <Input
                id="save-as-title"
                data-testid="save-as-title"
                value={saveAsTitle ?? ""}
                maxLength={MAX_TITLE_LENGTH}
                onChange={(event) => setSaveAsTitle(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaveAsTitle(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={trimmedTitle === ""} data-testid="save-as-confirm">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={saved !== null} onOpenChange={(open) => (open ? undefined : setSaved(null))}>
        <DialogContent data-testid="open-dialog" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Saved scenarios</DialogTitle>
            <DialogDescription>Stored in this browser, newest first.</DialogDescription>
          </DialogHeader>
          {saved !== null && saved.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="open-dialog-empty">
              Nothing saved yet.
            </p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {(saved ?? []).map((entry) => (
                <li
                  key={entry.id}
                  data-testid="saved-scenario"
                  data-store-id={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{entry.title}</p>
                    <p className="text-xs text-muted-foreground">{formatWhen(entry.updatedAt)}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="saved-scenario-open"
                      onClick={() => {
                        setSaved(null);
                        props.onOpenSaved(entry.id);
                      }}
                    >
                      Open
                    </Button>
                    {confirmDelete === entry.id ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        data-testid="saved-scenario-delete-confirm"
                        onClick={() => {
                          setConfirmDelete(null);
                          void props.onDeleteSaved(entry.id).then(openList);
                        }}
                      >
                        Really delete
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${entry.title}`}
                        data-testid="saved-scenario-delete"
                        onClick={() => setConfirmDelete(entry.id)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
