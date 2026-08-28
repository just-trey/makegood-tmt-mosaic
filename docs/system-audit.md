# System audit

Does the design system in `design-system/` currently **govern**, **describe**, or **misdescribe**
the running app? This report is the `system` lens of `/review-gauntlet` — computed style measured
against the running app, checked against the design system's own written specs, not against a
screenshot.

## Measurement conditions

|                                    |                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App commit (SHA)                   | `2c28f54` (`main`, after PR #248)                                                                                                                                                                                                                       |
| Design system version              | same commit — `design-system/` lives in this repo, no separate SHA. The token vocabulary **changed** since the last report: 42 names now, against 41 at `3288f6a`, so the token-census rows below are a diff of a changed set, not of the same set      |
| Viewport                           | 1440 × 960, device pixel ratio 1                                                                                                                                                                                                                        |
| Renderer                           | ANGLE (D3D12, NVIDIA GeForce RTX 2060) — hardware, not software fallback (`MOSAIC_GPU=1`)                                                                                                                                                               |
| Drive script                       | [`scripts/system-audit-drive.mjs`](../scripts/system-audit-drive.mjs), content hash `2a33fe34398b6bea` (sha256, first 16 hex). **Replayed unchanged.** Its hash differs from the `3288f6a` report's `2b952a34c0ef25da` — see "Why the hash moved" below |
| States driven                      | `initial`, `helpDialogOpen`, `artworkLoaded`, `overMaxWarning`, `confirmDialogOpen`, `narrowNotice`, `finalUnion` — the same seven as the last report                                                                                                   |
| Console/page errors during the run | none                                                                                                                                                                                                                                                    |

### Why the hash moved, and what it costs

The script was **not** rewritten for this run. It changed once between the two reports, in PR #243:
the Checkbox sample was repointed from `#p-recess-bg` to `#p-flip-x`, because #243 hid the
"Recess bg too" row and an ancestor's `display: none` does not change a child's own computed
values. The last report's Checkbox row was therefore measured off a control no user can reach.

Consequences, stated rather than papered over:

- The seven driven states are **identical**, so state coverage did not change.
- Every `†` row below is still marked incomparable to the `3288f6a` report, because the rule is
  the hash, not a judgement about how big the change was. This run is the new baseline for them.
- The Checkbox rows are a **correction**, not drift: the previous value described an unreachable
  element.

## Verdict

**The design system governs the app.** Every token the system declares is inherited by the app
through three `@import`s in `src/styles.css`, none are co-declared, and none resolve UNSET. No
component the system specifies is fiction, and no rendered value falls outside a declared scale
except the two documented icon exceptions.

Governance strengthened since `3288f6a` on the one number that measures it directly: `var()`
adoption across scale-relevant declarations rose from **80.0% to 87.3%**, while the absolute count
of literals fell from 40 to 30 — against a stylesheet that grew by 36 declarations. The help-dialog
restyle (#242) added surface and reduced hardcoding at the same time, which is the direction this
lens exists to confirm.

One measurement the system claims and this lens cannot verify is named in Finding 1.

## Findings, ranked by impact

### 1. The Checkbox spec's central claim is not measured by the drive script

`design-system/components/forms/Checkbox.prompt.md` specifies "a checkbox with an inline label,
**blue accent**". `accent-color` is not in the drive script's captured property list, so this run
has **no computed value** for the one property the spec is about. The previous report closed this
row as "source-confirmed, `src/styles.css:485,520,522`" — which is reading the stylesheet, exactly
what this lens's evidence rule forbids, because it reports intent rather than what the user got.

Not drift, and not a defect in the app. It is a gap in the instrument: the row has been reported
as verified twice without a measurement behind it. Closing it means adding `accentColor` to the
snapshot property list, which moves the script's hash and so should ride a run that expects to.

### 2. `#btn-help .badge` and `.close-btn` hardcode `border-radius: 50%`

Three of the 30 surviving literals are `border-radius: 50%` on circular elements
(`#btn-help .badge`, `.close-btn`, and the base swatch). The radius scale is a px ladder and has no
"full circle" entry, so there is nothing to reference — the literal is correct and the **scale is
incomplete**. Per this lens's own rule, that is a finding about the system, not the code.

Recommend a `--radius-full: 50%` entry so a circle stops reading as drift in every future census.

### 3. `#help-dialog` and `#confirm-dialog` carry four UA-reset literals each

`border-width: medium`, `border-style: none`, `border-color: currentcolor`, `border-image: initial`
— eight of the 30 literals, all of them the browser's own `<dialog>` defaults being reset. They
count against the adoption rate while expressing no design decision. Cosmetic, and listed so the
30 is not read as 30 opportunities.

### 4. Backgrounds render 28 distinct values, against 17 declared colour tokens

Expected, and re-confirmed rather than assumed: most are per-swatch fills from the loaded 6-colour
artwork, not app chrome. Sized here so the number is not mistaken for chrome drift.

## Confirmed closed this run

- **The Checkbox exemplar is reachable again.** #243 repointed both the drive script and
  `design-system/`'s canonical Checkbox exemplar (prompt, panel inventory, UI kit) from
  "Recess bg too" to "Flip H". The spec's `label="Flip H"` matches the live `#p-flip-x`.
- **`design-system/README.md` no longer describes the header help control as a circular "?" icon.**
  #242 replaced the control with a labelled button and corrected the screen spec in the same PR.

## Measurements

### Structural

Diff this block against the last full report (`3288f6a`) to see whether conformance moved. Rows
marked `†` are state-sensitive; this run's drive-script hash differs from that report's, so `†`
rows are a fresh baseline, not a diff, until a future run replays hash `2a33fe34398b6bea`.

| Metric                                                                              | This run (`2c28f54`)                                                         | Prior full run (`3288f6a`)                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Tokens declared (all 3 files)                                                       | 42                                                                           | 41                                                     |
| Tokens resolving under declared name                                                | 42 (100%)                                                                    | 41 (100%)                                              |
| — inherited (via `@import`)                                                         | 42 (100%)                                                                    | 41 (100%)                                              |
| — co-declared (independent, matching value)                                         | 0                                                                            | 0                                                      |
| Tokens UNSET under declared name                                                    | 0                                                                            | 0                                                      |
| Scale-relevant declarations using `var()` in `src/styles.css`§                      | 206                                                                          | 160                                                    |
| Scale-relevant declarations using a literal                                         | 30                                                                           | 40                                                     |
| var() adoption rate (scale-relevant declarations)                                   | **87.3%**                                                                    | 80.0%                                                  |
| — of which, the token resolves but the site still hardcodes a literal               | 3 sites (`border-radius: 50%`, no scale entry — Finding 2)                   | 13 sites (7 `font-weight`, 4 `transition`, 2 `border`) |
| Components with a live counterpart                                                  | 10 / 10                                                                      | 10 / 10                                                |
| Components that are fiction (no live counterpart)                                   | 0 / 10                                                                       | 0 / 10                                                 |
| Components explicitly marked proposed (excluded from the above, correctly)          | 2 / 2 self-flagged, 0 live (by design)                                       | 2 / 2                                                  |
| Font-size scale entries rendering nowhere (fiction) †                               | 0 / 4 distinct px values                                                     | 0 / 4                                                  |
| Font-size values rendered outside the scale, undocumented (drift) †                 | 0                                                                            | 0                                                      |
| Font-size values rendered outside the scale, documented icon exception †            | 2 distinct (`13.2px`, `15px`)                                                | 2 distinct                                             |
| Font-weight scale entries rendering nowhere                                         | 0 / 3                                                                        | 0 / 3                                                  |
| Font-weight values rendered outside the scale                                       | 0                                                                            | 0                                                      |
| Border-radius named steps duplicating another step's value (system-internal)        | 0                                                                            | 0                                                      |
| Border-radius values rendered with no scale entry to reference                      | 1 (`50%`, circles — Finding 2)                                               | not separately reported                                |
| Specimen files (10 guidelines + preview.html) confirmed loading every font they use | 10 / 11 (unchanged — no diff in these files since `3288f6a`)                 | 10 / 11                                                |
| Documented component states confirmed live this run †                               | 10                                                                           | 10                                                     |
| Documented component states not reached this run (see header) †                     | 8                                                                            | 8                                                      |
| Semantic rules checked                                                              | 4 (mono/sans split, danger-for-warnings-only, accent naming, gradient count) | 4                                                      |
| Semantic rules holding as documented                                                | 3                                                                            | 3                                                      |
| Semantic rules contradicted by the system's own docs                                | 1 (gradient count)                                                           | 1 (gradient count)                                     |
| Component specs whose central claim this run could not measure                      | **1** (Checkbox `accent-color` — Finding 1)                                  | 0 reported (claimed source-confirmed)                  |

§ `font-size`, `font-weight`, `border-radius`, `color`, `background`/`background-color`,
`border`/`border-color` — the properties Scale Adherence and Adoption both depend on. Raw
declaration count in the app's own bundled stylesheet. The denominator grew from 200 to 236 this
run (#236's feedback widget, #242's help-dialog restyle), so the rate moved on both a larger
numerator and a smaller literal count.

### Incidental

Per-element counts, unioned across the states this run's `scaleCensus()` was called in. These move
with the DOM (which panels are open, what artwork is loaded, window size) independent of any real
conformance change. Expected to churn between runs.

| Metric                                                        | Value                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Distinct rendered font-size values                            | 6 (`11, 12, 13.2, 15, 16, 20`px — 4 on-scale, 2 documented icon exceptions) |
| Distinct rendered font-weight values                          | 3 (`400, 600, 700`)                                                         |
| Distinct rendered border-radius values                        | 5                                                                           |
| Distinct rendered text colors (`color`)                       | 7                                                                           |
| Distinct rendered background colors                           | 28 (mostly per-swatch artwork fills, not app chrome)                        |
| Elements rendering at `border-radius: 0px`                    | 15 sampled (header, chrome, dialog scaffolding — square by design)          |
| Elements rendering black text (UA default, textless controls) | 10 sampled (native checkbox and base swatches — verified false leads)       |

## Method note

Measurements come from `scripts/system-audit-drive.mjs`, replayed unchanged against a fresh
`npm run build`. Token adoption is resolved on the running document rather than read from
`design-system/tokens/*.css`, and the `@import` chain in `src/styles.css:4-6` is what makes every
token inherited rather than co-declared. Console and page errors during the run: none.
