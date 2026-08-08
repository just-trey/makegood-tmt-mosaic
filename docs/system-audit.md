# System audit

Does the design system in `design-system/` currently **govern**, **describe**, or **misdescribe**
the running app? This report is the `system` lens of `/review-gauntlet` — computed style measured
against the running app, checked against the design system's own written specs, not against a
screenshot.

## Measurement conditions

|                                    |                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App commit (SHA)                   | `5f8192b18d7ffa9db1b823901f25ddd521066576` (branch `chore/type-and-spacing-tokens`, PR #153)                                                                                                                                                                                            |
| Design system version              | same commit — `design-system/` lives in this repo, no separate SHA. **This branch renamed the design system's own token files** (`tokens/typography.css`, `tokens/spacing.css`) — see "Design system version changed" below before reading any row against the prior run as a diff.     |
| Viewport                           | 1440 × 960, device pixel ratio 1                                                                                                                                                                                                                                                        |
| Renderer                           | ANGLE (D3D12, NVIDIA GeForce RTX 2060) — hardware, not software fallback (`MOSAIC_GPU=1`, confirmed via the harness's own refuse-on-software-renderer check)                                                                                                                            |
| Drive script                       | [`scripts/system-audit-drive.mjs`](../scripts/system-audit-drive.mjs), content hash `d5a3d9543e06ae7a` (sha256, first 16 hex) — **unchanged** from the prior run (`git diff main -- scripts/system-audit-drive.mjs` is empty), replayed exactly as committed, not modified for this run |
| Console/page errors during the run | none                                                                                                                                                                                                                                                                                    |

**States measured** (identical to the prior run's, by construction — same script, same sequence):
initial load (default-selected shape kind, an assembly kind — currently "Wheel (Top ×2 + Cap)");
help dialog open; 6-color artwork loaded (Colors detected populated, default printer's
"multi-unit" info pill live); printer switched to Snapmaker U1 (its "over-max" warn pill live);
confirm dialog open (triggered by switching shape kind with artwork loaded); a hover pass (default
button, dropzone), a focus pass (text input), and a real `dragover` dispatch (dropzone) layered on
the states above.

**States _not_ reached this run** — identical list to the prior run's, for the identical reason
(same script): the loading-overlay's `visible` moment mid-rebuild; ColorRow's `.dragging` /
`.drop-target` mid-drag states; a populated Base row and a merged color group (`.member-swatch`,
`.swatch.pinned`); the primary Button variant's `:hover`; the depth-override `.overridden` input
state and its `↺` reset button; `.base-swatch`'s `:hover`; a native `<select>`'s open dropdown.

One state gap is new to this run's scope, not the prior run's: **the narrow/mobile notice
(`#narrow-notice`, `≤899px`)**. This branch's `--space-panel` token has exactly one consumer in
the whole app (`#narrow-notice { padding: var(--space-panel); }`), and `#narrow-notice` sits
outside `#app` in the DOM, shown only under a `max-width: 899px` media query. At this run's fixed
1440px viewport it is never visited by any state above, so `--space-panel` is source-confirmed as
real and used, but not confirmed as _rendering_ by anything this run measured. Noted here, not
folded into the drive script (out of scope for a replay-unchanged run) — a future revision of the
script should add a resize pass if this token's rendering needs confirming directly.

Two supplementary, ad hoc checks (not the committed drive script, so not subject to its hash
guarantee) fill gaps the drive script has never covered in either run and are cited explicitly
where used: a font-family-in-use check across all 10 `guidelines/*.html` files plus
`ui_kits/mosaic/preview.html` (`scaleCensus()` in the drive script never visits those files), and a
`padding`/`margin`/`gap` census on the running app (`scaleCensus()` only tallies `fontSize`,
`fontWeight`, `borderRadius`, `color`, `backgroundColor` — it has never included spacing
properties, in this run or the last). Also cited as corroborating, non-authoritative context: this
branch's own `scripts/check-type-scale.mjs`, which reaches two states this run's replay of
`system-audit-drive.mjs` cannot (a merged color group, the narrow viewport) and independently
confirms the font-size findings below — its PASS is not treated as this report's evidence per the
task's own instruction, only as corroboration.

### Design system version changed — read every renamed-token row as void, not as a diff

The prior report (commit `026a9cf`, before `f2cdd3f`) measured against a design system that
declared `--space-1`…`--space-9`, `--text-xs`/`sm`/`sm-plus`/`md`/`base`/`lg`, and
`--font-heading`/`--font-sans`/`--font-mono`. This branch renamed those declarations —
`design-system/tokens/typography.css` and `tokens/spacing.css` now declare `--text-label`/`meta`/
`body`/`emphasis`/`display`, `--space-hair`/`tight`/`row`/`section`/`panel`, and `--heading`/
`--sans`/`--mono` (name-identical to the app's own, closing the alias indirection that used to
exist between them). **The committed drive script's `DESIGN_TOKENS` constant was not updated for
this rename** (its own header comment says to replay it unchanged, and it wasn't touched by this
branch — `git diff` confirms). Replayed as committed, `resolveTokens()` still queries the _retired_
36 names, correctly finds them all UNSET (they no longer exist under those names anywhere), and
never asks about the 10 names that replaced them — so the script's own raw token-resolution numbers
this run are **not usable as this run's Adoption census**; they measure a vocabulary the design
system no longer declares.

The Adoption section below therefore reports two numbers side by side: the replayed script's raw
output (for the record, since replaying unmodified is the instruction), and an independently
computed census against the design system's **actual currently-declared** token names (read
directly from `design-system/tokens/*.css` and cross-checked against `src/styles.css`'s `:root`
block, both open files, not a script). Per this lens's own rule ("when the system itself changed
between runs, every row moved for that reason: say so, and treat the comparison as void rather than
reporting a diff") — **the jump from the prior run's 43% to this run's 80% co-declared is not
adoption improving 37 points; it is two different scales being measured, and the branch's own
`DECISIONS-NEEDED.md` says exactly this ("do not read the numbers below as adoption tripled").**
Restated here because it is the single easiest way this lens itself gets misread.

## Verdict

**Describes, with real gaps — narrower gaps than last time, but the same shape of gap.** Five
findings from the prior run are independently reconfirmed closed this run: the type scale is real
now (0% fiction, 0% undocumented drift — Finding 7), all three buttons that fell back to the
browser's UI font now render Inter (Finding 2), the duplicate `--radius-xl` token is gone rather
than merely fixed (Finding 8), the `brand-makegood-site.html` font exception is now stated in both
`README.md` and the page's own header comment (Finding 11), and `Badge` remains fiction-free
(closed before this branch, in `f2cdd3f`; reconfirmed: 10/10 declared components have a live
counterpart). The `var()`-vs-literal adoption rate for scale-relevant CSS rose from 62.4% to 80% —
a real, name-agnostic, structurally comparable improvement.

But `GOVERNS` is not warranted: **inherited is still 0.** The app never `@import`s
`design-system/tokens/*.css`; every token that resolves does so because `src/styles.css`
independently redeclares the same name and value, which is agreement today with nothing structural
to catch tomorrow's drift — exactly the state the prior report described, just with more tokens
now sharing a name. And six of the ten prior findings this branch didn't touch are still live,
unchanged, reconfirmed fresh this run: the accent color's own name is still contradicted in three
component specs, the Export panel's documented primary action is still backwards in two places,
`preview.html`'s own staleness disclosure still undercounts itself, `ColorRow.prompt.md`'s sample
markup still collides with an unrelated class, "exactly one gradient" is still contradicted by
three, and `Slider.prompt.md` still undersells the shipped component. One new gap surfaced by this
branch's own scope: `--weight-*`, `--tracking-label`, `--leading-*`, `--border-width`, and
`--transition-fast` — 8 of the 41 currently-declared tokens — are fully UNSET, in the same
"co-declared or nothing" pattern this branch just fixed for two other scales, left untouched.

## Findings, ranked by impact

1. **True current token adoption is 80% co-declared / 0% inherited — but the replayed drive
   script's own token census cannot see 10 of the 15 tokens this branch touched, because its
   token-name list wasn't updated for the rename.** See "Design system version changed" above for
   the full mechanism. Consequence for future runs: the raw output of `resolveTokens()` in
   `system-audit-drive.mjs` should not be trusted as an Adoption census again until its
   `DESIGN_TOKENS` constant is updated to the current names (`--space-hair`…`--space-panel`,
   `--text-label`…`--text-display`, `--heading`/`--sans`/`--mono`) — otherwise every future replay
   silently undercounts exactly the tokens the most recent rename touched, the same failure mode
   this lens exists to catch, now happening inside its own tooling.

2. **The accent color's own name is still contradicted inside the system.** Unchanged from the
   prior run, reconfirmed fresh: `design-system/README.md` states the primary accent correctly
   ("blue (primary actions/focus): `#6d93ff`"). `Button.prompt.md` ("high-emphasis 'primary' (teal
   fill)"), `Checkbox.prompt.md` ("teal accent"), and `Dropzone.prompt.md` ("lights up teal on
   drag-over") still call the identical, computed-verified color "teal." Live computed style this
   run: primary Export button `backgroundColor` `rgb(109, 147, 255)` (`#6d93ff`, blue); dropzone
   drag-over `borderColor`/`color` the same blue; focused text input border the same blue.
   `--accent-2` (`#5eead4`, the actual teal) exists and is used elsewhere (a styles.css comment on
   `.slot-count` even calls it "the resting teal") but never on any of these three components.

3. **The Export panel's documented primary action is still the wrong one.** `README.md`'s Screens
   section and `preview.html` (`'Export STL set (.zip)'` on `variant: 'primary'`) both still
   describe the full-width primary button as the STL zip. Live this run, `#btn-export` (class `btn
primary full`) reads "Export print-ready 3MF"; "Export STL set (.zip)" is `#btn-export-stl`
   (class `btn small full`, no `primary`). Unchanged from the prior run.

4. **`preview.html` still discloses only 3 stale controls; the same 2 it omitted last time are
   still omitted.** Its panel title still reads "Base part" (live app: "Part", confirmed via this
   run's `panelTitles` census: `['Part', 'Artwork', 'Artwork fit', 'Depth', 'Colors detected',
'Export']`). Its primary Export button is still "Export STL set (.zip)" (same defect as Finding
   3, independently present in the mockup). The file's own disclaimer still lists three items, not
   five.

5. **`ColorRow.prompt.md`'s own example still uses a class name that collides with something
   else.** Its sample markup still wraps the row in `<div class="row">…</div>`; the live
   component's real outer class is `.color-row` (confirmed in `src/ui/colorList.ts`), and `.row` is
   still a distinct, unrelated pattern used throughout the app's Panel forms. Unchanged.

6. **"Exactly one gradient" still underclaims by two.** `README.md`: "Exactly one gradient…Add no
   further gradients." `src/styles.css` still has three `linear-gradient()` declarations: the
   documented `.accent-stripe` (line 106) plus two more forming `#right`'s grid backdrop (lines
   353–354, `linear-gradient(var(--accent-glow) 1px, transparent 1px)` on both axes). Unchanged.

7. **8 of the 41 currently-declared tokens are fully UNSET, in the same pattern this branch just
   closed for two other scales — untouched, deliberately per `DECISIONS-NEEDED.md`, but now the
   largest remaining gap in the token layer.** `--weight-regular`/`--weight-semibold`/`--weight-bold`,
   `--tracking-label`, `--leading-tight`, `--leading-normal`, `--border-width`, and
   `--transition-fast` have no property under those names anywhere in `src/styles.css`. Concretely:
   7 separate rules hardcode `font-weight: 600` or `700` as a literal where `var(--weight-semibold)`/
   `var(--weight-bold)` exist to reference; 4 separate declarations hardcode `0.12s` where
   `var(--transition-fast)` exists; 2 rules hardcode `border: 1px solid …` where
   `var(--border-width)` exists. None of these are new to this branch — they were already UNSET in
   the prior run — but the prior run's Finding 5 folded them into one 57%-UNSET number alongside the
   type/spacing tokens this branch has now fixed, so closing those makes this the only remaining
   UNSET cluster, worth naming on its own rather than let it hide inside a average that no longer
   applies.

8. **`Slider.prompt.md` still undersells the real component.** Its JSX
   (`valueLabel={scale + '%'}`) implies a static, read-only readout; the live implementation
   (`src/ui/fitPanel.ts`'s `syncPair('#p-margin', '#p-margin-num', …)`) pairs the range input with a
   genuinely editable, two-way-synced number input. Unchanged.

9. **`--space-panel` (24px) is real but unconfirmed by anything this run's viewport reaches.** Its
   only consumer in `src/styles.css` is `#narrow-notice { padding: var(--space-panel); }` — the
   ≤899px mobile notice, a state neither this run's nor the prior run's drive script visits at
   1440px. Source-confirmed as used (not fiction), but the one declared spacing step this report
   cannot independently confirm renders anywhere.

## Confirmed closed this run (independently reconfirmed, not taken on the branch's own word)

- **Font-size scale (prior Finding 7).** Rendered, unioned across every state this run measured,
  excluding the branch's own documented `em`-sized icon glyphs: exactly `{11px, 12px, 16px, 20px}`
  — the full declared scale (`--text-label`/`--text-meta` share 11px on purpose), 0 fiction, 0
  undocumented drift. The two off-scale sizes this run did render (`13.2px` on `.warn-dismiss`/
  `.color-row .depth-reset`, `15px` on `.close-btn`) match `DECISIONS-NEEDED.md`'s stated `em`
  computations exactly and are the branch's own declared exception, not drift. Corroborated by
  `scripts/check-type-scale.mjs` (context only): 0 literal `font-size` px outside token
  declarations, 0 font-family violations across 14 `--text-meta` sites, and the same `{11, 12, 16,
20}px` union confirmed across 7 states including two this run's replay cannot reach (merged color
  group, narrow viewport).
- **Button font fallback (prior Finding 2).** `.close-btn`, `.warn-dismiss`, `.warn-clear-all` all
  resolve `fontFamily: "Inter, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif"`
  live this run (previously `Arial`). `button, input, select, textarea { font: inherit }` at the
  top of `src/styles.css` is the fix.
- **`--radius-xl` (prior Finding 8).** No longer declared anywhere — `tokens/spacing.css` now
  defines only `--radius-sm`/`md`/`lg`/`2xl`. Nothing left to be a value-duplicate of `--radius-lg`.
- **`brand-makegood-site.html` font exception (prior Finding 11).** Both `design-system/README.md`
  ("The exception is `brand-makegood-site.html`…deliberately") and the page's own header comment
  ("Deliberately outside the UI type/spacing scale…") now state it. Independently reconfirmed via a
  supplementary font-family-in-use check across all 11 specimen files: 10/11 use at least one of
  Inter/Outfit/IBM Plex Mono on a real rendered element; `brand-makegood-site.html` uses none of the
  three (confirmed: `font-family: sans-serif` throughout, Google-Fonts `<link>` present but nothing
  in the page's own rules ever selects those families).
- **Badge fiction (prior Finding 1, closed before this branch in `f2cdd3f`).** `design-system/
components/**/*.prompt.md` is 10 files; none is `Badge`. All 10 have a live counterpart confirmed
  this run (Button, Checkbox, Select, Slider, TextInput, Panel, WarningPill, LoadingOverlay,
  Dropzone, ColorRow — each snapshotted at least once above).

## Confirmed accurate (checked, not just assumed)

- **WarningPill** — both tones computed-style-verified fresh this run, triggered live (not
  simulated): info tone `backgroundColor rgba(109, 147, 255, 0.1)` / `borderColor rgb(109, 147,
255)` / `color rgb(170, 179, 207)`; danger tone `backgroundColor rgba(249, 67, 138, 0.12)` /
  `borderColor rgba(249, 67, 138, 0.4)` / `color rgb(255, 179, 209)` — matches
  `WarningPill.prompt.md`'s table exactly on both.
- **The mono/sans split** ("mono = a value the user might copy or that came from computed
  geometry") — held with no exceptions found this run: hex codes, the depth `mm` input, the
  tri/color stat counts, the slot-count line, and the help dialog's TOC links all resolve to the
  IBM Plex Mono stack; labels, hints, panel summaries, and every button resolve to Inter. Corroborated
  by `check-type-scale.mjs`'s independent `--text-meta`→mono check: 0 violations across 14 sites.
- **Danger red stays reserved for warnings/invalid state.** Live grep of every `var(--danger`
  usage site in `src/styles.css`: `input[type=number].invalid` and `.slot-count.over-capacity` only
  — no decorative use found.
- **Panel, TextInput, Select, LoadingOverlay, Checkbox** specs match their live counterparts
  structurally and in computed style this run (uppercase-label-plus-hairline shell; mono numeric
  fields; select styled identically to TextInput; overlay dim + spinner + label behind a
  `position:relative` host).
- **Hover, focus, and drag-over transitions** work as specified, measured past the 0.12s CSS
  transition (not synchronously): `.btn:hover`/`#dropzone:hover`/`input:focus` border-color →
  `--accent`; `#dropzone`'s drag-over state turns border, text, and a faint wash to the same accent
  blue, matching `Dropzone.prompt.md`.

## Measurements

### Structural

Diff this block between runs to see whether conformance moved. Rows marked `†` are state-sensitive
— see the header for which states this run covered before treating a `†` difference as drift
rather than incomparable coverage. Rows marked `‡‡` compare a scale the design system itself
renamed between runs — read as **void**, not diff, per "Design system version changed" above.

| Metric                                                                                               | This run (`5f8192b`)                                                                                      | Prior run (`026a9cf`, for reference)         |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Tokens declared (all 3 files, current names) ‡‡                                                      | 41                                                                                                        | 47                                           |
| Tokens resolving under declared name (current names, computed independently — see header) ‡‡         | 33 (80%)                                                                                                  | 20 (43%)                                     |
| — inherited (via `@import`)                                                                          | 0                                                                                                         | 0                                            |
| — co-declared (independent, matching value)                                                          | 33                                                                                                        | 20                                           |
| Tokens UNSET under declared name ‡‡                                                                  | 8 (19.5%)                                                                                                 | 27 (57%)                                     |
| — of which, value-equivalent under a different app-side name                                         | 0 (the rename eliminated this class — `--heading`/`--sans`/`--mono` are now name-identical on both sides) | 3                                            |
| Replayed drive script's own raw token census (stale vocabulary — for the record only, see Finding 1) | 23 / 47 resolving under the _retired_ names                                                               | n/a (same vocabulary as declared then)       |
| Scale-relevant declarations using `var()` in `src/styles.css`§                                       | 160                                                                                                       | 141                                          |
| Scale-relevant declarations using a literal                                                          | 40                                                                                                        | 85                                           |
| var() adoption rate (scale-relevant declarations, name-agnostic — real, comparable)                  | 80.0%                                                                                                     | 62.4%                                        |
| Components with a live counterpart                                                                   | 10 / 10                                                                                                   | 10 / 11                                      |
| Components that are fiction (no live counterpart)                                                    | 0 / 10                                                                                                    | 1 / 11 (Badge)                               |
| Font-size scale entries rendering nowhere (fiction) †                                                | 0 / 4 distinct px values (5 named tokens, 2 share a value)                                                | 1 / 6 (`--text-lg`)                          |
| Font-size values rendered that the scale doesn't contain, undocumented (drift) †                     | 0                                                                                                         | 6 distinct                                   |
| Font-size values rendered that the scale doesn't contain, documented icon exception †                | 2 distinct (`13.2px`, `15px`) — matches `DECISIONS-NEEDED.md` exactly                                     | n/a (exception didn't exist yet)             |
| Font-weight scale entries rendering nowhere                                                          | 0 / 3                                                                                                     | 0 / 3                                        |
| Font-weight values rendered outside the scale                                                        | 0                                                                                                         | 0                                            |
| Border-radius named steps duplicating another step's value (system-internal)                         | 0 (`--radius-xl` deleted, not merely fixed)                                                               | 1 (`--radius-xl` = `--radius-lg`)            |
| Specimen files (10 guidelines + preview.html) confirmed loading every font family they use           | 10 / 11                                                                                                   | 9 / 10 (preview.html not separately counted) |
| Documented component states confirmed live this run †                                                | 9                                                                                                         | 9                                            |
| Documented component states not reached this run (see header) †                                      | 9 (8 unchanged + narrow/mobile notice, new to this run's scope)                                           | 8                                            |
| Semantic rules checked                                                                               | 4 (mono/sans split, danger-for-warnings-only, accent color naming, gradient count)                        | 4                                            |
| Semantic rules holding as documented                                                                 | 2 (mono/sans split, danger-for-warnings-only)                                                             | 2                                            |
| Semantic rules contradicted by the system's own docs                                                 | 2 (accent color name, gradient count)                                                                     | 2                                            |

§ `font-size`, `font-weight`, `border-radius`, `color`, `background`/`background-color`,
`border`/`border-color` — the properties Scale Adherence and Adoption both depend on. Raw
declaration count in the app's own bundled stylesheet, not the app's full stylesheet — mechanism is
identical code across both runs (name-agnostic `val.includes('var(')` check), so this row is a real
comparison, not void.

### Incidental

Per-element counts. These move with the DOM (which panels are open, what artwork is loaded, window
size) independent of any real conformance change — sized here to show how much evidence backs each
structural row above, not tracked as its own trend. Expected to churn between runs.

| Metric                                                                                              | Value                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Elements checked in the full-page scale census (`#app *`)                                           | ~830–1400 (varies by state; artwork-loaded states add ~7 color rows)                                                                                                                                                                                  |
| Distinct rendered font-size values (union of all states)                                            | 6 (`12, 11, 16, 20, 15, 13.2`px — 4 on-scale, 2 documented icon exceptions)                                                                                                                                                                           |
| Distinct rendered font-weight values                                                                | 3 (`400, 700, 600`)                                                                                                                                                                                                                                   |
| Distinct rendered border-radius values (excl. `50%` circles)                                        | 5 (`1, 2, 3, 6, 10`px)                                                                                                                                                                                                                                |
| Distinct rendered text colors (`color`)                                                             | 9 (5–6 map to real tokens; remainder are native-control UA defaults on textless elements — checkboxes, range inputs — verified false leads, not findings)                                                                                             |
| Distinct rendered background colors                                                                 | 27 (most are single/few-occurrence artwork swatch fills reflecting the loaded 6-color SVG, not app chrome)                                                                                                                                            |
| Font-size = 12px (`--text-body`)                                                                    | 1082 elements                                                                                                                                                                                                                                         |
| Font-size = 11px (`--text-label` / `--text-meta`)                                                   | 290 elements                                                                                                                                                                                                                                          |
| Font-size = 16px (`--text-emphasis`)                                                                | 27 elements                                                                                                                                                                                                                                           |
| Font-size = 20px (`--text-display`)                                                                 | 3 elements                                                                                                                                                                                                                                            |
| Font-size = 15px (documented icon exception, `.close-btn`)                                          | 3 elements                                                                                                                                                                                                                                            |
| Font-size = 13.2px (documented icon exception, `.warn-dismiss`/`.depth-reset`)                      | 2 elements                                                                                                                                                                                                                                            |
| Font-weight = 400                                                                                   | 1274 elements                                                                                                                                                                                                                                         |
| Font-weight = 700                                                                                   | 117 elements                                                                                                                                                                                                                                          |
| Font-weight = 600                                                                                   | 16 elements                                                                                                                                                                                                                                           |
| Border-radius = 1px (`--radius-md`)                                                                 | 119 elements                                                                                                                                                                                                                                          |
| Border-radius = 2px (`--radius-lg`)                                                                 | 80 elements                                                                                                                                                                                                                                           |
| Border-radius = 3px (`--radius-2xl`)                                                                | 31 elements                                                                                                                                                                                                                                           |
| Border-radius = 50% (circles, not on the linear scale)                                              | 12 elements                                                                                                                                                                                                                                           |
| Border-radius = 6px (drift — inline literal, `src/ui/assemblyPanel.ts:413`)                         | 6 elements                                                                                                                                                                                                                                            |
| Border-radius = 10px (drift — `.version-tag`, literal)                                              | 3 elements                                                                                                                                                                                                                                            |
| Scale-relevant literal declarations, by kind (of 40 total)                                          | 7 `font-weight` literals, 4 `border-image`/`border-width`/`border-color: currentcolor` (shorthand-reset serialization, not a real gap), 2 `border: 1px solid …` literals, remainder are one-off backgrounds/gradients/radii not on any declared scale |
| Buttons found rendering in the browser UA font instead of Inter                                     | 0 (was 3: `.close-btn`, `.warn-dismiss`, `.warn-clear-all` — see Confirmed closed)                                                                                                                                                                    |
| Rendered `padding`/`margin`/`gap` values, app-authored (supplementary census, not the drive script) | `{2, 4, 8, 16}px` — all 4 non-`--space-panel` steps, 0 undocumented drift once native-control UA defaults (`<option>` internal padding/gap, checkbox default margins — `1px, 3px, 5.5px, 6px`) are excluded as false leads                            |

## Method note

Computed-style census cannot distinguish a `0px` (or otherwise UA-default-matching) value that was
deliberately set from one nothing ever set — both read identically. This still affects
`--radius-sm` (used by `.swatch`/`.base-swatch`/`.member-swatch`, confirmed by source read, not by
computed-style census, which can't tell it apart from "unset"). The same class of false lead
recurred this run in the supplementary spacing census: `<option>` elements' internal
`padding-bottom`/`gap` (`1px`, `5.5px`, `6px`) and native checkboxes' default `margin-top`/`-bottom`
(`3px`) are Chromium UA defaults the app's CSS never touches, not app-authored spacing decisions —
traced to source (`<option>`, `input[type=checkbox]` selectors, no matching rule in
`src/styles.css`) and excluded rather than reported as drift.

## Update — chore/type-and-spacing-tokens

This report **is** the measurement of that branch (commit `5f8192b`, the branch's own HEAD). The
prior "Update" section that lived at the end of this file (added by the branch's own commits,
self-reporting what it believed it had closed) is superseded by this report, which independently
re-measured every one of its claims rather than taking them on the branch's word — see "Confirmed
closed this run" above for what was verified to actually hold, and Findings 1 and 7 for the two
places a naive reading of the branch's own claim would have been wrong (the token-count "43%→80%"
delta is not adoption tripling, and the replayed audit script's own token list needs updating
before its raw numbers can be trusted again). The full prior text is preserved in git history
(`git log -- docs/system-audit.md`), not inline here, per this lens's own instruction to overwrite
rather than accumulate.
