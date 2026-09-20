# ADR: Sonar triage of the UI, round 1

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-20
- Phase: 8 (SonarQube triage, area "ui")
- Builds on: ADR 0001 (the ejected shadcn stylesheet), 0022 and 0026 (focusable scroll regions)

## Context

The first analysis reported 132 issues in the UI paths, 84 of them blocking a rating of the gate.
Two groups needed a decision instead of a plain fix.

## Decisions

### 1. `src/app/shadcn-tailwind.css` is reduced to what the components use

68 of the 84 blocking issues were in this one vendored file: `css:S8767` (48, stylelint
`no-invalid-position-declaration`) on declarations inside `@supports` inside `@utility`, and
`css:S8776` (20, stylelint `nesting-selector-no-missing-scoping-root`) on `&` selectors inside
`@custom-variant` and `@utility`. Both are Tailwind 4 syntax that the CSS analyser reads as plain
CSS; none of it reaches a browser in that form. The two rules were reproduced outside the server
with stylelint 17.15.0 and exactly these two rules: 48 + 20, the same lines.

ADR 0001 planned to exclude the file from the CSS rules. That was not done (an exclusion is a gate
decision, QUAL-001 and QUAL-002, and not needed). Instead:

- Every block that no component uses was removed: the accordion keyframes, the `data-selected`
  variant, and the `no-scrollbar`, `scroll-fade*` and `shimmer*` utilities (grep over `src`, `e2e`
  and `tests`: no use of any of them). They were not free: eight `@property` rules, their fallback
  values in `@layer properties` and a `prefers-reduced-motion` rule for `.shimmer` were part of
  the CSS of every page. All 48 `S8767` and 5 `S8776` findings were inside these blocks.
- The eight variants that are used (`data-open`, `data-closed`, `data-checked`, `data-unchecked`,
  `data-disabled`, `data-active`, `data-horizontal`, `data-vertical`) were rewritten from the block
  form with `@slot` to the one-line form `@custom-variant name (selector, selector);`, which
  Tailwind documents and which has no nested rule with `&`. `tailwindcss/dist/lib.js` splits the
  list at the commas and joins it into one style rule, the same rule the block form produced.

Evidence, from `globals.css` compiled with `@tailwindcss/postcss` (unoptimised) before and after:
after the variant rewrite alone the output is byte-identical (97 883 bytes); after the removal the
diff has 0 added lines and only the dead `@property`, fallback and `.shimmer` rules removed
(96 752 bytes). stylelint with the two rules reports nothing on either stylesheet afterwards.

Consequence: `npx shadcn add <component>` for a component that needs one of the removed blocks
(an accordion, a scroll-fade, a shimmer) will not animate until the block is taken back from
`shadcn/tailwind.css` of shadcn 4.21.0. The header comment of the file says so.

### 2. `typescript:S6845` stays open on ten focusable scroll regions

Replaced in round 2 by `0032-sonar-ui-round-2.md`: the rule was half right, the tab stop now
follows the overflow, and the ten findings were fixed in the code. What follows is the round 1
view, kept as the record.

The rule (jsx-a11y `no-noninteractive-tabindex`) wants `tabIndex` only on interactive elements.
The ten places are scroll containers (`overflow-auto` or `overflow-x-auto`) with a role, an
accessible name and `tabIndex={0}`. That is the documented technique for WCAG 2.1.1: without it a
keyboard user cannot scroll the region in every browser, and axe fails
`scrollable-region-focusable` (ADR 0022, ADR 0026; the axe checks of the Playwright suite). The
only ways to silence the rule are an interactive role that would lie to a screen reader, or hiding
the attribute from the analyser behind a spread or a polymorphic tag. Neither is a fix, so the ten
findings stay open and are listed in `docs/sonar-triage.md`.

They are `RELIABILITY:MEDIUM`, so the reliability rating of the overall code stays at C and the
gate stays red because of them. The decision how to go on is the owner's; the options are in the
triage document.

### 3. Groups of buttons are `<fieldset>`, labelled scroll regions with a table are `<section>`

`typescript:S6819` asks for the native element instead of a role. Where the native element is the
same thing it was taken: the theme switch, the template variant switch and the status filter are
groups of buttons and became `<fieldset aria-label>` (role `group` stays, `min-w-0` removes the
min-content width of a fieldset), and the two `div role="region"` around tables became
`<section aria-label>`. It was not taken where the advice does not fit: a `<pre>` cannot become a
`<fieldset>`, and `<output>` means the result of a calculation or of a user action, which a
"Loading the lab" notice is not. Those findings are non-blocking and listed in the triage document.
