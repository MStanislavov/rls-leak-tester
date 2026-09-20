# ADR: Sonar triage of the UI, round 2: the tab stop of a scroll region follows its layout

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-20
- Phase: 8 (SonarQube triage, area "ui")
- Builds on: ADR 0022 and 0026 (focusable scroll regions), `0031-sonar-ui-round-1.md`
- Replaces: decision 2 of `0031-sonar-ui-round-1.md`, and the part of its decision 3 about `<pre>`

## Context

After round 1 the gate failed on one condition: the reliability rating of the overall code was C
because of ten open `typescript:S6845` findings (`tabIndex` on a non-interactive element,
`RELIABILITY:MEDIUM`). Round 1 had listed them as suspected false positives: every one of the ten
is a scroll container (`overflow-auto` or `overflow-x-auto`) with `tabIndex={0}`, which WCAG 2.1.1
and axe `scrollable-region-focusable` need. Seven `typescript:S6819` findings sat on the same
elements (`role="group"` or `role="region"` on a `<pre>`).

Reading the rule again showed that it was half right. Its reason is the size of the tab ring: a
tab stop belongs to something the keyboard can operate. A scroll region is that only while its
content overflows. The ten elements had the tab stop always: on `/docs` at desktop width a region
that shows all of its content was a stop, and in the details drawer every list of three keys was
one. The part of the finding that is right is "a stop on static text"; the part that is wrong is
"never on a `<pre>`".

## Decisions

### 1. The tab stop is there exactly while the region overflows

`src/components/site/scroll-region.tsx` has the hook `useScrollTabStop` and two components over
it. The hook measures the element (`scrollWidth > clientWidth || scrollHeight > clientHeight`) and
returns `tabIndex` `0` or `undefined`. It measures again when the box changes (a
`ResizeObserver`: the window, a zoom, a `<details>` that opens), when the content changes inside a
box that is already at its maximum height (a `MutationObserver`), when the web fonts are ready, and
when the focus leaves the region.

- Until the first measurement the region counts as scrolling. The server's HTML and a page whose
  script never runs keep every tab stop, so nothing is lost without JavaScript and there is no
  moment in which axe could see a scrolling region without one.
- A region that holds the focus keeps its stop even if it stops overflowing (a zoom out, a
  resize): removing `tabindex` from the focused element would drop the focus to the top of the
  page. The stop goes when the focus leaves.
- The ten places use it: seven listings through `CodeListing`, the two tables of `/docs` and of the
  landing page through `ScrollSection`, the key lists of the details drawer through the hook.
  `src/components/lab/tables-panel.tsx` (read-only tables, ADR 0026) and the CodeMirror scroller
  (ADR 0022) are unchanged: their stop depends on the mode, not on the layout, and neither was a
  finding.

This is a change of behaviour, and it is the point of the change: fewer stops for a keyboard user,
the same access to every region that scrolls.

### 2. A code listing is a `<figure>` with a name, not a `<pre>` with a role

A focus stop wants a name, a name on a `<pre>` wants a role, and `role="group"` on a `<pre>` is
what S6819 reported; round 1 found no native element among the ones the rule offers. HTML has one
it does not offer: `<figure>` "annotates illustrations, diagrams, photos, code listings". So
`CodeListing` is `<figure aria-label>` around the `<pre>`, the figure is the box that scrolls and
takes the stop, and no `role` attribute is left. The `<pre>` inherits font and `white-space` from
the figure and is as wide as its longest line (`w-fit min-w-full`), so wrapping, scrolling and the
padding at the end of a horizontal scroll are as before. The SQL sample of `/docs` (`Sql` in
`src/app/docs/prose.tsx`) was `role="region"`, a landmark for every sample; it is a figure now as
well.

`data-testid`, the accessible names and the class names of the boxes did not change; the test ids
are on the figure, whose text is the text of the `<pre>`.

### 3. What the analyser sees, said plainly

S6845 is jsx-a11y `no-noninteractive-tabindex`. It reads the attribute in the source: a literal
`0` is reported, a value that is computed is not (the rule cannot know it, the same as for the
roving `tabIndex` of the result matrix). `tabIndex={tabIndex}` is written out on the element, not
passed through a spread, but the silence of the rule after this change proves nothing by itself.
What proves the behaviour is `e2e/scroll-region.spec.ts`: for every region on `/docs` at 1280 and
at 320 pixels and in the details drawer after a run, `tabindex="0"` is present exactly when the
region overflows; the server's HTML has every stop; a focused region keeps its stop; axe
`scrollable-region-focusable` has no violation in any of these states. The spec fails in three of
its four tests when the measurement is switched off (checked once, by hand).

Both rules were run outside the server with `eslint-plugin-jsx-a11y` 6.10.2
(`no-noninteractive-tabindex`, `prefer-tag-over-role`), whose messages are the ones the server
shows. On a sample, `<pre tabIndex={0}>` is reported and `<pre tabIndex={tabIndex}>` is not. Over
`src/**/*.tsx` after the change, neither rule reports any of the 10 + 7 places; the seven
`role="status"` findings of the server are reported at the same lines, plus two `sr-only` live
regions the server does not list. The next analysis has the last word.

### 4. `role="status"` stays as it is

The seven remaining S6819 findings ask for `<output>` instead of `<p role="status">` on notices
such as "Loading the lab". Round 1's reasoning holds (an `<output>` is the result of a calculation
or of a user action) and they block nothing: they stay open in `docs/sonar-triage.md`.

## Consequences

- A new scroll region uses `CodeListing`, `ScrollSection` or `useScrollTabStop`; a literal
  `tabIndex={0}` on static markup would bring S6845 back, rightly.
- The landing page and `/docs` load one more small client component; the landing page test that
  looks for heavy code still passes.
- No issue was changed in the server, no rule, exclusion, threshold or gate condition was touched.
