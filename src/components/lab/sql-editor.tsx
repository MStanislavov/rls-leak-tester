"use client";

/**
 * CodeMirror 6 with the PostgreSQL dialect. Loaded through `next/dynamic` by the editor panel,
 * so CodeMirror is its own chunk.
 *
 * - Uncontrolled: the document lives in CodeMirror. Changes reach the lab debounced (a 200 KB
 *   script must not be copied into React state on every keystroke) and at once on blur, on
 *   unmount and through `handle.flush()`, which Run, Save and Export call first.
 * - Theme-aware without a reconfigure: every colour is a CSS variable of the app's tokens
 *   (`lab.css` adds the syntax colours), so the class on `<html>` switches the editor too. Only
 *   CodeMirror's own light/dark flag is reconfigured, for its built-in panels and tooltips.
 * - Tab is NOT bound: it moves the focus on, as everywhere else (no keyboard trap). Mod-Enter
 *   runs the matrix.
 * - The text is a document of text nodes; nothing here renders HTML (SEC-001).
 */
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useTheme } from "next-themes";
import { useEffect, useRef, type RefObject } from "react";

export interface SqlEditorHandle {
  /** The text as it is in the editor right now. */
  getValue(): string;
  /** Sends a pending change to `onChange` immediately. */
  flush(): void;
  /** Replaces the whole document, as an edit: `onChange` hears of it at once. */
  setValue(text: string): void;
}

export interface SqlEditorProps {
  /** Accessible name of the text box, for example "Schema SQL". */
  readonly label: string;
  /** Read once, when the editor mounts. Remount (`key`) to load another document. */
  readonly initialValue: string;
  readonly onChange: (text: string) => void;
  readonly onRun: () => void;
  /** One-based line to mark and scroll to; `null` clears the mark. */
  readonly errorLine: number | null;
  /** Filled while the editor is mounted. A prop, not `ref`: it crosses `next/dynamic`. */
  readonly handleRef: RefObject<SqlEditorHandle | null>;
  readonly testId: string;
  /** `/s/[slug]`: the text can be read, selected and copied, not changed. Read at mount. */
  readonly readOnly?: boolean;
}

const CHANGE_DEBOUNCE_MS = 200;

const setErrorLine = StateEffect.define<number | null>();

const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setErrorLine)) {
        const line = effect.value;
        next =
          line === null || line < 1 || line > transaction.state.doc.lines
            ? Decoration.none
            : Decoration.set([
                Decoration.line({ class: "cm-lab-error-line" }).range(
                  transaction.state.doc.line(line).from,
                ),
              ]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const MONO = "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace";

const labTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--foreground)",
    backgroundColor: "var(--card)",
    fontSize: "13px",
  },
  "&.cm-focused": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--card)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--accent) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--accent)", color: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)" },
  ".cm-lab-error-line": {
    backgroundColor: "var(--status-leak-bg)",
    boxShadow: "inset 3px 0 0 var(--status-leak)",
  },
  ".cm-panels, .cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
});

const labHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--cm-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--cm-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--cm-number)" },
  { tag: [tags.lineComment, tags.blockComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "var(--cm-type)" },
]);

export function SqlEditor({
  label,
  initialValue,
  onChange,
  onRun,
  errorLine,
  handleRef,
  testId,
  readOnly = false,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const darkFlag = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun });
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  useEffect(() => {
    callbacks.current = { onChange, onRun };
  }, [onChange, onRun]);

  // `initialValue`, `label` and `handleRef` are read when the editor mounts, on purpose: the
  // parent remounts the editor (key) to load another document.
  useEffect(() => {
    const parent = host.current;
    if (parent === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dirty = false;
    const flush = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (dirty) {
        dirty = false;
        callbacks.current.onChange(editor.state.doc.toString());
      }
    };

    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  flush();
                  callbacks.current.onRun();
                  return true;
                },
              },
            ]),
          ),
          basicSetup,
          sql({ dialect: PostgreSQL }),
          syntaxHighlighting(labHighlight),
          labTheme,
          darkFlag.current.of(EditorView.darkTheme.of(false)),
          errorLineField,
          EditorState.readOnly.of(readOnly),
          // tabindex: the scroller scrolls, and axe wants a keyboard way into every scrollable
          // region; a contenteditable is one, the explicit tabindex says so to the checker.
          EditorView.contentAttributes.of({
            "aria-label": label,
            spellcheck: "false",
            tabindex: "0",
            ...(readOnly ? { "aria-readonly": "true" } : {}),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              dirty = true;
              if (timer !== null) {
                clearTimeout(timer);
              }
              timer = setTimeout(flush, CHANGE_DEBOUNCE_MS);
            }
            if (update.focusChanged && !update.view.hasFocus) {
              flush();
            }
          }),
        ],
      }),
    });
    view.current = editor;
    handleRef.current = {
      getValue: () => editor.state.doc.toString(),
      flush,
      setValue: (text) => {
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
        flush();
      },
    };

    return () => {
      flush();
      handleRef.current = null;
      view.current = null;
      editor.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, see the comment above
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: darkFlag.current.reconfigure(EditorView.darkTheme.of(isDark)),
    });
  }, [isDark]);

  useEffect(() => {
    const editor = view.current;
    if (editor === null) {
      return;
    }
    const inRange = errorLine !== null && errorLine >= 1 && errorLine <= editor.state.doc.lines;
    editor.dispatch({
      effects: inRange
        ? [
            setErrorLine.of(errorLine),
            EditorView.scrollIntoView(editor.state.doc.line(errorLine).from, { y: "center" }),
          ]
        : [setErrorLine.of(null)],
    });
  }, [errorLine]);

  return (
    <div
      ref={host}
      data-testid={testId}
      data-error-line={errorLine ?? undefined}
      className="h-full min-h-0 overflow-hidden rounded-md border bg-card"
    />
  );
}
