# System audit

Does the design system in `design-system/` currently **govern**, **describe**, or **misdescribe**
the running app? This report is the `system` lens of `/review-gauntlet` — computed style measured
against the running app, checked against the design system's own written specs, not against a
screenshot.

## Measurement conditions

|                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App commit (SHA)                   | `3288f6a287fc9172d420d2ce977b510c917433d9` (`main`, PR #181)                                                                                                                                                                                                                                                                                                                                                                                                 |
| Design system version              | same commit — `design-system/` lives in this repo, no separate SHA. Token vocabulary unchanged since the last full run (`5f8192b`, still 41 names across `colors.css`/`spacing.css`/`typography.css`), so every token-census row below is a direct diff, not void.                                                                                                                                                                                           |
| Viewport                           | 1440 × 960, device pixel ratio 1                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Renderer                           | ANGLE (D3D12, NVIDIA GeForce RTX 2060) — hardware, not software fallback (`MOSAIC_GPU=1`, confirmed via the harness's own refuse-on-software-renderer check)                                                                                                                                                                                                                                                                                                 |
| Drive script                       | [`scripts/system-audit-drive.mjs`](../scripts/system-audit-drive.mjs), content hash `2b952a34c0ef25da` (sha256, first 16 hex) — this is the "hardened" script (PR #156: derives `DESIGN_TOKENS` from `design-system/tokens/*.css` at run time, drives a narrow-viewport pass). Its hash does not match the prior full report's (`d5a3d954…`), so every `†` row below is a fresh baseline, not a diff against `5f8192b` — see "State coverage changed" below. |
| Console/page errors during the run | none                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**States measured**: initial load (default-selected shape kind, an assembly kind — currently
"Wheel (Top ×2 + Cap)"); help dialog open; 6-color artwork loaded (Colors detected populated,
default printer's "multi-unit" info pill live); printer switched to Snapmaker U1 (its "over-max"
warn pill live); confirm dialog open (triggered by switching shape kind with artwork loaded); a
hover pass (default button, dropzone), a focus pass (text input), a real `dragover` dispatch
(dropzone), and a narrow-viewport pass (≤899px, `#narrow-notice`) — layered on the states above.

**States _not_ reached this run**: the loading-overlay's `visible` moment mid-rebuild; ColorRow's
`.dragging` / `.drop-target` mid-drag states; a populated Base row and a merged color group
(`.member-swatch`, `.swatch.pinned`); the primary Button variant's `:hover`; the depth-override
`.overridden` input state and its `↺` reset button; `.base-swatch`'s `:hover`; a native `<select>`'s
open dropdown; the assembly-part manual drop target (see Finding 6 below — no reachable state
renders it with any shipped kind).

### State coverage changed since the last full report — `†` rows are a fresh baseline

The last full report (`5f8192b`) was itself measured against an earlier version of this same
script (hash `d5a3d954…`) that did not yet drive the narrow-viewport pass — that gap was closed by
PR #156 after that report shipped, and this run is the first full measurement to replay the
extended script. Per this lens's own rule, a changed drive-script hash means every `†`
(state-sensitive) row is **incomparable to `5f8192b`**, not a diff against it. Concretely this run
newly confirms `--space-panel` render-live (closing that report's Finding 9) and reaches one more
documented state (the narrow/mobile notice) than `5f8192b` did. This report is the new baseline for
`†` rows; a future run replaying this same script hash (`2b952a34c0ef25da`) can diff against it
directly.

Two supplementary, ad hoc checks (not the committed drive script) are cited where used: a source
grep for every `var(--danger` and `linear-gradient(` usage site in `src/styles.css` (confirming the
danger-reserved-for-warnings and gradient-count semantic rules), and `git log -S`/`git diff` against
specific commits to establish whether a change closed a finding or only narrowed where it renders.

## Verdict

**Governs the token layer for the first time. Still merely describes three long-standing spec/copy
gaps, unchanged across three consecutive runs.**

The headline structural change: **every one of the 41 declared design tokens now resolves via
inheritance, not co-declaration.** `src/styles.css` `@import`s `design-system/tokens/{colors,
spacing,typography}.css` directly (PR #154, landed since the last full report) and contains **zero**
local `--name: value` declarations — confirmed by grep across the whole file, not sampled. That is
qualitatively different from the last two runs' story: adoption rose from 43% to 80% to now
**100%**, but this time the number means what it used to only claim to mean. A co-declared token
(the prior state, for 80% of them) is agreement today with nothing to catch tomorrow's drift; an
inherited one structurally can't diverge without the change happening in the shared file, where it
is visible to every consumer. This closes the top-ranked finding of both prior reports outright, not
by narrowing it.

Three findings named "unchanged" across `f2cdd3f` and `5f8192b` are now closed by PR #181, landed
the same day as this run: the accent color is called "blue" everywhere it's named (was "teal" in
three component specs), the Export panel's documented primary button matches the live one ("Export
print-ready 3MF"), and the sidebar's first panel is named "Part" everywhere (was "Base part" in two
places). `preview.html`'s own staleness disclosure was rewritten alongside the fix rather than left
to drift further — it now names 5 divergences instead of undercounting at 3.

`GOVERNS` is still not warranted for the whole system: three findings first named at `f2cdd3f` are
**still open, unchanged for a third consecutive run** — `ColorRow.prompt.md`'s sample markup still
collides with an unrelated `.row` class, "exactly one gradient" is still contradicted by two grid
gradients two inches below the claim in the same file, and `Slider.prompt.md` still undersells the
shipped component as read-only. And the token win is narrower than "100% resolving" makes it sound:
of the 8 tokens that were UNSET in the last report (`--weight-*`, `--tracking-label`,
`--leading-*`, `--border-width`, `--transition-fast`), all 8 now resolve, but the CSS rules that
should reference them by name still hardcode the same literals they did last run — 7 `font-weight`
sites, 4 `transition` sites, 2 `border` sites. The token layer moved from "unset" to "inherited but
still not referenced" for this cluster, which is real progress but not adoption in the sense the
headline number implies.

## Findings, ranked by impact

1. **Token resolution reached 100% inherited, 0% co-declared — a structural change, not a bigger
   number on the same measurement.** `src/styles.css` `@import`s all three token files
   (`design-system/tokens/{colors,spacing,typography}.css`) and declares no custom property of its
   own anywhere (`grep -n '^\s*--[a-zA-Z0-9-]*\s*:' src/styles.css` returns nothing). All 41
   declared tokens resolve on `document.documentElement`. Landed in PR #154
   ("Import design-system tokens instead of redeclaring them"), not measured by name in either
   prior report (both predate it). This is the top-ranked finding from both prior reports, closed.

2. **8 tokens that resolved nowhere last run now resolve everywhere — but the CSS that should use
   them still hardcodes the literal it always did.** `--weight-regular`/`semibold`/`bold`,
   `--tracking-label`, `--leading-tight`/`normal`, `--border-width`, `--transition-fast` are no
   longer UNSET (closed by the same `@import`). Live this run: `font-weight: 600` or `700` as a
   bare literal at 7 sites (`src/styles.css:88,128,418,545,784,902,964`) where
   `var(--weight-semibold)`/`var(--weight-bold)` now exist and resolve; `transition: …0.12s` as a
   literal at 4 sites (`:134-136` two-in-one declaration, `:536`, `:585`) where
   `var(--transition-fast)` exists; `border: 1px solid …` as a literal at 2 sites (`.swatch`,
   `.member-swatch`) where `var(--border-width)` exists. Unchanged counts from the last report —
   this cluster's usage layer wasn't touched by PR #154/#156, only its resolution layer was.

3. **`ColorRow.prompt.md`'s own example still uses a class name that collides with something else.**
   Unchanged for a third run. Its sample markup wraps the row in `<div class="row">…</div>`; the
   live component's real outer class is `.color-row` (confirmed in `src/ui/colorList.ts`, live
   `outerHTML` this run: `<div class="color-row" data-hexes="#2e9e4f">`), and `.row` is a distinct,
   unrelated pattern used throughout the app's Panel forms.

4. **"Exactly one gradient" still underclaims by two.** Unchanged for a third run.
   `design-system/README.md`: "Exactly one gradient…Add no further gradients." `src/styles.css`
   still has three `linear-gradient()` declarations: the documented `.accent-stripe` (line 71 this
   run) plus two more forming `#right`'s grid backdrop (lines 320–321,
   `linear-gradient(var(--accent-glow) 1px, transparent 1px)` on both axes).

5. **`Slider.prompt.md` still undersells the real component.** Unchanged for a third run. Its JSX
   (`valueLabel={scale + '%'}`) implies a static, read-only readout; the live implementation pairs
   the range input with a genuinely editable, two-way-synced number input (`src/ui/fitPanel.ts`'s
   `syncPair`).

6. **The assembly-part dropzone's hardcoded `border-radius:6px` is unchanged in source, but PR #166
   (landed the day before this run, unrelated to design-system work) confined its rendering to a
   fallback path no shipped kind reaches.** `docs/tech-debt.md`'s open section on this still frames
   the drift as reachable via "however many assembly parts are loaded," and cites a prior
   `system-audit.md` run's 6-element census row as "very likely" its source — that framing is now
   stale. `buildAsmPartRow`'s dropzone only renders when `canSwapMesh: true`, which since PR #166
   is true only when the parts library is unreachable (`asmKindCanAutoLoad(kind)` false); every
   shipped kind (Wheel, Footrest, Hubcap, Chair body) auto-loads from the library, so this run's
   full-page census found **0** elements at 6px, down from the prior report's 6, across every state
   this run drove including all four shipped kinds' default view. The source literal is unchanged
   (`src/ui/assemblyPanel.ts:428`) — this is a reachability narrowing PR #166 verified deliberately
   ("0 drop targets... on the auto-load chair"), not a token fix, and not something this lens's own
   run can take credit for. Worth a one-line update to the tech-debt section so it doesn't cite a
   census row this run no longer reproduces.

7. **A newly added, explicitly-proposed component spec cites a bug in `src/styles.css` that has
   never existed there.** `ZoneListRow.prompt.md` (new since the last report, marked "PROPOSED, not
   built" throughout — correctly excluded from the fiction count, see Confirmed accurate) states in
   an aside: "there is no `--font-mono` token. `src/styles.css:1091` references `var(--font-mono)`,
   which is declared nowhere." `git log -S"font-mono" -- src/styles.css` across all reachable
   history returns nothing — that string has never appeared in this file. Live this run, all 13
   `font-family: var(--mono)` sites resolve to `"IBM Plex Mono", ui-monospace, monospace` correctly
   (see Confirmed accurate, mono/sans split). The claim likely conflates the deleted
   `zone-first-selection` spike prototype's own throwaway CSS with the real stylesheet. Low impact —
   it's an aside inside a file that already declares itself non-authoritative — but worth a
   one-line correction since a future reader could otherwise go looking for a bug that isn't there.

8. **`design-system/README.md`'s own Fidelity section describes the token relationship one notch
   weaker than it now is.** "`tokens/colors.css` declares the same names the app declares in
   `src/styles.css`, so the two are one vocabulary" describes co-declaration (two independent
   declarations, agreeing today). Since PR #154, the app declares nothing — it imports the system's
   own file — which is the stronger, inheritance relationship Finding 1 above measures. This is a
   doc that undersells its own current state rather than overselling it, and costs nothing today,
   but is worth a word-swap ("imports" for "declares") the next time this section is touched, so the
   README doesn't read as a weaker claim than what PR #154 actually shipped.

## Confirmed closed this run (independently reconfirmed, not taken on the branch's own word)

- **Token adoption (prior Finding 1, both runs).** See Verdict and Finding 1 above — 100%
  inherited, 0% co-declared, 0% UNSET.
- **Accent color naming (prior Finding 2, unchanged across `f2cdd3f` and `5f8192b`).**
  `Button.prompt.md`, `Checkbox.prompt.md`, `Dropzone.prompt.md` now all say "blue"; live computed
  style this run confirms blue on all three: primary Export button `backgroundColor rgb(109, 147,
255)`, checkbox `accent-color: var(--accent)` (source-confirmed, `src/styles.css:485,520,522`),
  dropzone drag-over `borderColor rgb(109, 147, 255)`.
- **Export panel primary action (prior Finding 3, unchanged across two runs).**
  `design-system/README.md` and `preview.html` now both name `#btn-export` ("Export print-ready
  3MF") as primary and `#btn-export-stl` ("Export STL set (.zip)") as the small secondary below it.
  Live this run: `#btn-export` is `class="btn primary full"`, text "Export print-ready 3MF";
  `#btn-export-stl` is `class="btn small full"`, text "Export STL set (.zip)". Matches.
- **Panel name and order (part of prior Finding 3/4, unchanged across two runs).** Live
  `panelTitles` census this run: `['Part', 'Artwork', 'Artwork fit', 'Depth', 'Colors detected',
'Export']` — "Part" first, matching `design-system/README.md`'s corrected panel list and
  `Panel.prompt.md`'s corrected example list.
- **`preview.html`'s staleness disclosure (prior Finding 4, unchanged across two runs).** Now lists
  5 known divergences (was 3): the two new ones are the panel order (Part first, not Artwork) and
  the two-button Export panel — both independently confirmed live above.
- **`--space-panel` render-confirmed (prior Finding 9, `5f8192b`).** PR #156 added the
  narrow-viewport pass this run replayed: at ≤899px, `#narrow-notice`'s computed `padding` is
  `24px`, matching the token's declared value exactly.

## Confirmed accurate (checked, not just assumed)

- **The two new component specs are correctly self-flagged as proposals, not fiction.**
  `FilamentSlotStrip.prompt.md` and `ZoneListRow.prompt.md` are new since the last report, both
  titled "PROPOSED, not built" in their first line, both explicit that they describe a prototype
  spike (`zone-first-selection`) rather than shipped UI. Neither has a live counterpart, and neither
  should — they're excluded from the "components with a live counterpart" denominator (still 10/10
  for the specs that claim to be live) rather than counted as the "spec describing UI the app
  doesn't have" failure `design-system/README.md`'s own Fidelity section warns against.
- **Font-size scale.** Rendered, unioned across every scale-census state this run measured (initial,
  help dialog open, final): exactly `{11px, 12px, 16px, 20px}` — the full declared scale, 0
  fiction, 0 undocumented drift. `13.2px` (`.warn-dismiss`/`.color-row .depth-reset`) and `15px`
  (`.close-btn`) are the branch's own documented `em`-sized icon exceptions, not drift.
- **Font-weight scale.** `{400, 600, 700}` rendered, matching all 3 declared values, 0 fiction, 0
  drift.
- **`--radius-xl` stays gone.** `tokens/spacing.css` still declares only `--radius-sm`/`md`/`lg`/
  `2xl`; nothing to be a value-duplicate of `--radius-lg`.
- **The mono/sans split** ("mono = a value the user might copy or that came from computed
  geometry") — held with no exceptions found this run: hex codes (`.hex`), the slot-count line
  (`#slot-count`), the "Merge with…" select, the help dialog's TOC links, and the depth `mm` input
  all resolve to `"IBM Plex Mono", ui-monospace, monospace`; panel labels, warning pills, and the
  help dialog's headings (`Outfit` — the heading token, not mono/sans at all) resolve correctly for
  their role. All 13 `font-family: var(--mono)` sites in `src/styles.css` are live and correct (see
  Finding 7 — the one design-system doc claiming a break in this rule is itself wrong).
- **Danger stays reserved for warnings/invalid state.** Live grep of every `var(--danger` usage site
  in `src/styles.css`: `.warn-pill`'s base (info variant overrides it), `input[type=number].invalid`,
  and `.slot-count.over-capacity` only — no decorative use found. Live computed style confirms both
  `WarningPill` tones match `WarningPill.prompt.md`'s table: info `backgroundColor rgba(109, 147,
255, 0.1)`, danger `backgroundColor rgba(249, 67, 138, 0.12)`.
- **Swatches render square (0px radius), per `design-system/README.md`'s spacing section.** Live
  `.swatch` computed `borderRadius: 0px` this run.
- **Panel, TextInput, Select, LoadingOverlay, Checkbox, WarningPill** specs match their live
  counterparts structurally and in computed style this run (uppercase-label-plus-hairline shell;
  mono numeric/select fields at `--radius-md` 1px; overlay dim + `position:relative` host).
- **Hover, focus, and drag-over states** work as specified: `.btn:hover`/`#dropzone:hover`/
  `input:focus` border-color → `--accent`; the confirm dialog's OK button matches `Button`'s primary
  spec (`backgroundColor rgb(109, 147, 255)`, `fontWeight 600`).
- **Specimen font-loading (unchanged since last report — no diff in `design-system/guidelines/` or
  `preview.html` since `5f8192b`, confirmed via `git diff --stat`).** 10/11 specimen files use a
  real loaded font family; `brand-makegood-site.html` remains the documented exception.

## Measurements

### Structural

Diff this block against the last full report (`5f8192b`) to see whether conformance moved. Rows
marked `†` are state-sensitive — this run's drive-script hash differs from that report's (see "State
coverage changed" above), so treat `†` rows as a fresh baseline, not a diff, until a future run
replays this run's hash.

| Metric                                                                                           | This run (`3288f6a`)                                                               | Prior full run (`5f8192b`)       |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------- |
| Tokens declared (all 3 files)                                                                    | 41                                                                                 | 41                               |
| Tokens resolving under declared name                                                             | 41 (100%)                                                                          | 33 (80%)                         |
| — inherited (via `@import`)                                                                      | 41 (100%)                                                                          | 0                                |
| — co-declared (independent, matching value)                                                      | 0                                                                                  | 33                               |
| Tokens UNSET under declared name                                                                 | 0                                                                                  | 8 (19.5%)                        |
| Scale-relevant declarations using `var()` in `src/styles.css`§                                   | 160                                                                                | 160                              |
| Scale-relevant declarations using a literal                                                      | 40                                                                                 | 40                               |
| var() adoption rate (scale-relevant declarations)                                                | 80.0% (unchanged)                                                                  | 80.0%                            |
| — of which, the referenced token now resolves but the site still hardcodes a literal (Finding 2) | 13 sites (7 `font-weight`, 4 `transition`, 2 `border`)                             | same 13 sites, tokens then UNSET |
| Components with a live counterpart                                                               | 10 / 10                                                                            | 10 / 10                          |
| Components that are fiction (no live counterpart)                                                | 0 / 10                                                                             | 0 / 10                           |
| Components explicitly marked proposed (excluded from the above, correctly)                       | 2 / 2 self-flagged, 0 live (by design)                                             | 0 (didn't exist yet)             |
| Font-size scale entries rendering nowhere (fiction) †                                            | 0 / 4 distinct px values (5 named tokens, 2 share a value)                         | 0 / 4                            |
| Font-size values rendered outside the scale, undocumented (drift) †                              | 0                                                                                  | 0                                |
| Font-size values rendered outside the scale, documented icon exception †                         | 2 distinct (`13.2px`, `15px`)                                                      | 2 distinct                       |
| Font-weight scale entries rendering nowhere                                                      | 0 / 3                                                                              | 0 / 3                            |
| Font-weight values rendered outside the scale                                                    | 0                                                                                  | 0                                |
| Border-radius named steps duplicating another step's value (system-internal)                     | 0 (`--radius-xl` still gone)                                                       | 0                                |
| Specimen files (10 guidelines + preview.html) confirmed loading every font they use              | 10 / 11 (unchanged — no diff in these files since `5f8192b`)                       | 10 / 11                          |
| Documented component states confirmed live this run †                                            | 10 (9 unchanged + narrow/mobile notice, newly driven by PR #156's extended script) | 9                                |
| Documented component states not reached this run (see header) †                                  | 8 (unchanged list, narrow notice moved to "confirmed" above)                       | 9                                |
| Semantic rules checked                                                                           | 4 (mono/sans split, danger-for-warnings-only, accent color naming, gradient count) | 4                                |
| Semantic rules holding as documented                                                             | 3 (mono/sans split, danger-for-warnings-only, accent color naming — newly closed)  | 2                                |
| Semantic rules contradicted by the system's own docs                                             | 1 (gradient count)                                                                 | 2                                |

§ `font-size`, `font-weight`, `border-radius`, `color`, `background`/`background-color`,
`border`/`border-color` — the properties Scale Adherence and Adoption both depend on. Raw
declaration count in the app's own bundled stylesheet. Identical mechanism and identical count to
`5f8192b` — PR #154/#156/#181 touched the top-of-file `@import` block and doc/copy text, not any of
the 200 scale-relevant declarations counted here, so this row is a genuine "unchanged," not a stale
census.

### Incidental

Per-element counts, unioned across the three states this run's `scaleCensus()` was called in
(initial load, help dialog open, final state with artwork loaded and the confirm/narrow passes
behind it). These move with the DOM (which panels are open, what artwork is loaded, window size)
independent of any real conformance change — sized here to show how much evidence backs each
structural row above, not tracked as its own trend. Expected to churn between runs; an element
visible across more than one of the three states is counted once per state it appeared in, not
once overall.

| Metric                                                                                             | Value                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distinct rendered font-size values (union of 3 states)                                             | 6 (`12, 11, 16, 20, 15, 13.2`px — 4 on-scale, 2 documented icon exceptions)                                                                                                                                                                                      |
| Distinct rendered font-weight values                                                               | 3 (`400, 700, 600`)                                                                                                                                                                                                                                              |
| Distinct rendered border-radius values (excl. `50%` circles)                                       | 4 (`1, 2, 3, 10`px — down from `5f8192b`'s 5; the 6px assembly-dropzone value didn't render this run, see Finding 6, not a fixed token)                                                                                                                          |
| Distinct rendered text colors (`color`)                                                            | 8 (5–6 map to real tokens; remainder are native-control UA defaults on textless elements — buttons, range inputs — verified false leads)                                                                                                                         |
| Distinct rendered background colors                                                                | 27 (most are single/few-occurrence artwork swatch fills reflecting the loaded 6-color SVG, not app chrome)                                                                                                                                                       |
| Font-size = 12px (`--text-body`)                                                                   | 1040 element-states                                                                                                                                                                                                                                              |
| Font-size = 11px (`--text-label` / `--text-meta`)                                                  | 290 element-states                                                                                                                                                                                                                                               |
| Font-size = 16px (`--text-emphasis`)                                                               | 27 element-states                                                                                                                                                                                                                                                |
| Font-size = 20px (`--text-display`)                                                                | 3 element-states                                                                                                                                                                                                                                                 |
| Font-size = 15px (documented icon exception, `.close-btn`)                                         | 3 element-states                                                                                                                                                                                                                                                 |
| Font-size = 13.2px (documented icon exception, `.warn-dismiss`/`.depth-reset`)                     | 2 element-states                                                                                                                                                                                                                                                 |
| Font-weight = 400                                                                                  | 1244 element-states                                                                                                                                                                                                                                              |
| Font-weight = 700                                                                                  | 105 element-states                                                                                                                                                                                                                                               |
| Font-weight = 600                                                                                  | 16 element-states                                                                                                                                                                                                                                                |
| Border-radius = 1px (`--radius-md`)                                                                | 119 elements                                                                                                                                                                                                                                                     |
| Border-radius = 2px (`--radius-lg`)                                                                | 80 elements                                                                                                                                                                                                                                                      |
| Border-radius = 3px (`--radius-2xl`)                                                               | 31 elements                                                                                                                                                                                                                                                      |
| Border-radius = 50% (circles, not on the linear scale)                                             | 12 elements                                                                                                                                                                                                                                                      |
| Border-radius = 10px (drift — `.version-tag`, literal)                                             | 3 elements                                                                                                                                                                                                                                                       |
| Border-radius = 6px (assembly dropzone, source-confirmed, not rendered)                            | 0 elements this run — see Finding 6; confirmed present in source at `src/ui/assemblyPanel.ts:428`, unreachable via any shipped kind's default view                                                                                                               |
| Scale-relevant literal declarations, by kind (of 40 total)                                         | 7 `font-weight` literals, 4 `transition …0.12s` literals, 2 `border: 1px solid …` literals, remainder one-off backgrounds/gradients/radii not on any declared scale, plus shorthand-reset serialization artifacts (`border-image: initial` etc., not a real gap) |
| Buttons found rendering in the browser UA font instead of Inter                                    | 0                                                                                                                                                                                                                                                                |
| `checkbox`/`input[type=range]` native-UA-default false leads excluded from the color/border census | `color: rgb(0, 0, 0)` on `<button class="base-swatch">` (no app `color` rule set on it), `borderColor rgb(157, 150, 142)` on range inputs — traced to source, no matching app rule, excluded as drift                                                            |

## Method note

Computed-style census cannot distinguish a `0px` (or otherwise UA-default-matching) value that was
deliberately set from one nothing ever set — both read identically. This still affects
`--radius-sm` (used by `.swatch`/`.base-swatch`/`.member-swatch`, confirmed by source read, not by
computed-style census, which can't tell it apart from "unset"; `.swatch`'s `borderRadius: 0px` this
run is consistent with the token but not distinguishable from a default by the census alone).

`scaleCensus()` also can't tell "this value doesn't render because nothing renders in that state"
apart from "this value doesn't render because it doesn't exist" — the border-radius = 6px row this
run is exactly that ambiguity resolved by source-reading and `git log`, not by the census alone (see
Finding 6). A structural row that goes to zero is worth checking against source before reporting it
as a fix.
