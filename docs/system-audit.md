# System audit

Does the design system in `design-system/` currently **govern**, **describe**, or **misdescribe**
the running app? This report is the `system` lens of `/review-gauntlet` — computed style measured
against the running app, checked against the design system's own written specs, not against a
screenshot.

## Measurement conditions

|                                    |                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App commit (SHA)                   | `32c7ebf` (`main`, after PR #263), measured from branch `chore/measure-checkbox-accent`, whose only diff is to the drive script — no app code, no CSS                                                                                             |
| Design system version              | same commit — `design-system/` lives in this repo, no separate SHA. **Byte-identical to the `2c28f54` report's**, as is `src/styles.css`, so the token census and the literal census below are a diff of the same set against the same stylesheet |
| Viewport                           | 1440 × 960, device pixel ratio 1                                                                                                                                                                                                                  |
| Renderer                           | ANGLE (D3D12, NVIDIA GeForce RTX 2060) — hardware, not software fallback (`MOSAIC_GPU=1`)                                                                                                                                                         |
| Drive script                       | [`scripts/system-audit-drive.mjs`](../scripts/system-audit-drive.mjs), content hash `d3b61ea4b35c37e4` (sha256, first 16 hex). **Extended, not replayed.** The `2c28f54` report's hash was `2a33fe34398b6bea` — see "Why the hash moved" below    |
| States driven                      | `initial`, `helpDialogOpen`, `artworkLoaded`, `overMaxWarning`, `confirmDialogOpen`, `narrowNotice`, `finalUnion` — the same seven as the last two reports                                                                                        |
| Console/page errors during the run | none                                                                                                                                                                                                                                              |

**States _not_ reached this run** — eight, the same eight as the `2c28f54` run, enumerated here
because that report pointed at a header that did not list them: the loading overlay's `visible`
moment mid-rebuild; ColorRow's `.dragging`; ColorRow's `.drop-target`; a merged colour group
(`.member-swatch`); `.swatch.pinned`; the depth-override `.overridden` input and its `↺` reset;
`.base-swatch`'s `:hover`; the primary Button's `:hover` (`brightness(1.08)`). A native
`<select>`'s open dropdown is drawn by the browser and specified nowhere in the system, so it is
out of scope rather than unreached.

### Why the hash moved, and what it costs

Three changes, all of the same kind — measure the state the run meant to measure:

1. **`accentColor` added to the snapshot property list.** This closes the last report's Finding 1:
   the Checkbox spec's central claim had been reported as verified twice with no computed value
   behind it. Adds a property to every snapshot; adds no state.
2. **The pointer is moved off `#dropzone` before the `dragover` dispatch.** It was previously
   still hovering, so the drag-over snapshot was hover + drag-over combined and could not isolate
   either. This is what makes Finding 1 below measurable.
3. **A 0.12s settle after the `dragleave` dispatch.** Without it the next state's census caught
   `#dropzone` and its two children mid-fade from accent back to `--text-dim`, tallying one
   interpolated colour that is in no token and differed on every run (`rgb(138, 162, 233)`,
   `rgb(161, 174, 214)`, `rgb(152, 170, 221)` across three runs). With the settle, two consecutive
   runs return the identical 7-colour set, matching the `2c28f54` report's 7.

Consequences, stated rather than papered over:

- The seven driven states are **identical**. Nothing here reaches anywhere new.
- Every `†` row below is still marked incomparable to the `2c28f54` report, because the rule is
  the hash, not a judgement about how big the change was. This run is the new baseline for them.
  Finding 2 argues that rule now costs more than it buys.
- In fact every structural and incidental number below is unchanged from `2c28f54`, on a
  byte-identical stylesheet and design system. That agreement is reported here, not used to
  license reading the `†` rows as a diff.

## Verdict

**The design system governs the app**, with one state it describes that the app does not draw.

Every token the system declares is inherited through three `@import`s in `src/styles.css`, none
are co-declared, none resolve UNSET, `var()` adoption holds at 87.3%, and no component the system
specifies is fiction. The Checkbox spec's "blue accent" is now measured rather than
source-confirmed: `#p-flip-x` renders `accent-color: rgb(109, 147, 255)`, exactly `--accent`
(`#6d93ff`), and `#p-scale` renders the same.

The exception is `#dropzone`, where the system documents two states and the app renders one
(Finding 1).

## Findings, ranked by impact

### 1. `#dropzone` renders its full drag-over appearance on plain hover

The system separates the two states. `README.md` → States: "Hover: border brightens to accent
blue"; "Drag-over (dropzone): border + text turn blue, faint blue wash fills background".
`Dropzone.prompt.md` says the target "lights up blue on drag-over".

Measured, with the pointer moved off between reads so the two are isolated:

| Property          | Base (no pointer)    | `:hover`                    | drag-over                   |
| ----------------- | -------------------- | --------------------------- | --------------------------- |
| `color`           | `rgb(170, 179, 207)` | `rgb(109, 147, 255)`        | `rgb(109, 147, 255)`        |
| `backgroundColor` | `rgba(0, 0, 0, 0)`   | `rgba(109, 147, 255, 0.06)` | `rgba(109, 147, 255, 0.06)` |
| `borderColor`     | `rgb(43, 52, 87)`    | `rgb(109, 147, 255)`        | `rgb(109, 147, 255)`        |

Hover and drag-over are identical across all 16 captured properties — the diff between those two
snapshots is empty. Hovering already spends the whole accent treatment, so arriving over the
dropzone with a file changes nothing on screen, and the one signal that says "this drop will land
here" is indistinguishable from moving the mouse across the panel.

Not a token or scale problem: every value is `--accent` / `--accent-glow`, correctly referenced.
The system claims a distinction the app does not make. Either the app should hold hover to the
border-only treatment the README's own hover rule describes, or the system should stop documenting
two states. This is a **behaviour** call, so the recommendation goes to `ui-conventions.md` /
`ux-review`; this lens only reports that the two render the same.

### 2. The drive-script hash covers the whole file, so a captured property voids `†` comparability

Two consecutive reports have now marked every state-sensitive row incomparable for a change that
touched no state. #243 repointed the Checkbox sample; this run added a property and two waits. In
both cases the seven driven states were identical, and in both cases the mechanical rule — the
hash is over the whole file — threw away the comparison anyway.

The rule exists so that a changed drive _sequence_ cannot silently pass as drift. A captured
property, a settle, or a comment does not change the sequence. The script's own header already
says as much: "a hash diff now means the sequence changed, which is the only thing this clause was
ever trying to signal." It no longer does.

Recommend hashing the driven sequence rather than the file — for instance the ordered list of
states the run reports plus the selectors it snapshots, emitted by the script into its own output
so it cannot drift from what actually ran. Not done here: it changes what the header's headline
number means, and that should ride a run whose job is that change, not this one.

### 3. `#btn-help .badge` and `.close-btn` hardcode `border-radius: 50%`

Three of the 30 surviving literals are `border-radius: 50%` on circular elements
(`#btn-help .badge`, `.close-btn`, and the base swatch). The radius scale is a px ladder and has no
"full circle" entry, so there is nothing to reference — the literal is correct and the **scale is
incomplete**. Per this lens's own rule, that is a finding about the system, not the code.

Recommend a `--radius-full: 50%` entry so a circle stops reading as drift in every future census.
Unchanged from the `2c28f54` report, re-measured rather than carried.

### 4. `#help-dialog` and `#confirm-dialog` carry four UA-reset literals each

`border-width: medium`, `border-style: none`, `border-color: currentcolor`, `border-image: initial`
— eight of the 30 literals, all of them the browser's own `<dialog>` defaults being reset. They
count against the adoption rate while expressing no design decision. Cosmetic, and listed so the
30 is not read as 30 opportunities.

### 5. Backgrounds render 28 distinct values, against 17 declared colour tokens

Expected, and re-confirmed rather than assumed: most are per-swatch fills from the loaded 6-colour
artwork, not app chrome. Sized here so the number is not mistaken for chrome drift.

## Confirmed closed this run

- **The Checkbox spec's "blue accent" is measured** (`2c28f54` Finding 1). `#p-flip-x` renders
  `accent-color: rgb(109, 147, 255)` = `--accent` (`#6d93ff`). `#p-scale` renders the same, so the
  accent reaches both native controls the system specifies. Every other snapshotted element
  reports `accent-color: auto`, which is the correct value for an element that has no accent to
  draw. The row is no longer read off the stylesheet.
- **The distinct-colour census is reproducible.** The interpolated seventh-plus colour described
  above is gone; two consecutive runs return the same seven.

## Measurements

### Structural

Diff this block against the last full report (`2c28f54`) to see whether conformance moved. Rows
marked `†` are state-sensitive; this run's drive-script hash differs from that report's, so `†`
rows are a fresh baseline, not a diff, until a future run replays hash `d3b61ea4b35c37e4`.

| Metric                                                                              | This run (`32c7ebf`)                                                         | Prior full run (`2c28f54`)                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| Tokens declared (all 3 files)                                                       | 42                                                                           | 42                                               |
| Tokens resolving under declared name                                                | 42 (100%)                                                                    | 42 (100%)                                        |
| — inherited (via `@import`)                                                         | 42 (100%)                                                                    | 42 (100%)                                        |
| — co-declared (independent, matching value)                                         | 0                                                                            | 0                                                |
| Tokens UNSET under declared name                                                    | 0                                                                            | 0                                                |
| Scale-relevant declarations using `var()` in `src/styles.css`§                      | 206                                                                          | 206                                              |
| Scale-relevant declarations using a literal                                         | 30                                                                           | 30                                               |
| var() adoption rate (scale-relevant declarations)                                   | **87.3%**                                                                    | 87.3%                                            |
| — of which, the token resolves but the site still hardcodes a literal               | 3 sites (`border-radius: 50%`, no scale entry — Finding 3)                   | 3 sites (same three)                             |
| Components with a live counterpart                                                  | 10 / 10                                                                      | 10 / 10                                          |
| Components that are fiction (no live counterpart)                                   | 0 / 10                                                                       | 0 / 10                                           |
| Components explicitly marked proposed (excluded from the above, correctly)          | 2 / 2 self-flagged, 0 live (by design)                                       | 2 / 2                                            |
| Font-size scale entries rendering nowhere (fiction) †                               | 0 / 4 distinct px values                                                     | 0 / 4                                            |
| Font-size values rendered outside the scale, undocumented (drift) †                 | 0                                                                            | 0                                                |
| Font-size values rendered outside the scale, documented icon exception †            | 2 distinct (`13.2px`, `15px`)                                                | 2 distinct                                       |
| Font-weight scale entries rendering nowhere                                         | 0 / 3                                                                        | 0 / 3                                            |
| Font-weight values rendered outside the scale                                       | 0                                                                            | 0                                                |
| Border-radius named steps duplicating another step's value (system-internal)        | 0                                                                            | 0                                                |
| Border-radius values rendered with no scale entry to reference                      | 1 (`50%`, circles — Finding 3)                                               | 1 (`50%`)                                        |
| Specimen files (10 guidelines + preview.html) confirmed loading every font they use | 10 / 11 (byte-identical to `2c28f54`, not re-driven)                         | 10 / 11                                          |
| Documented component states confirmed live this run †                               | 10 (enumerated below)                                                        | 10 (not enumerated)                              |
| Documented component states not reached this run (see header) †                     | 8 (enumerated in the header)                                                 | 8 (not enumerated)                               |
| Documented component states the app renders indistinguishably from another †        | **2** (`#dropzone` `:hover` and drag-over — Finding 1)                       | 0 reported (drag-over read while still hovering) |
| Semantic rules checked                                                              | 4 (mono/sans split, danger-for-warnings-only, accent naming, gradient count) | 4                                                |
| Semantic rules holding as documented                                                | 3                                                                            | 3                                                |
| Semantic rules contradicted by the system's own docs                                | 1 (gradient count)                                                           | 1 (gradient count)                               |
| Component specs whose central claim this run could not measure                      | **0** (Checkbox `accent-color` now measured)                                 | 1 (Checkbox `accent-color`)                      |

§ `font-size`, `font-weight`, `border-radius`, `color`, `background`/`background-color`,
`border`/`border-color` — the properties Scale Adherence and Adoption both depend on. Raw
declaration count in the app's own bundled stylesheet, which is byte-identical to `2c28f54`'s.

**The 10 documented component states confirmed live**, enumerated so the row is auditable:
Button `primary` (solid `--accent` fill, `--on-accent` text); Button `default` (bordered, panel
fill); Button `small`; Button `disabled` (`opacity: 0.4`, `cursor: not-allowed`); hover → accent
border (`#btn-sample`); focus → accent border (`#p-depth`); Dropzone drag-over (accent border,
text and wash); WarningPill info tone; WarningPill danger tone; the ≤899px narrow notice
(`padding: 24px` = `--space-panel`, `#app` at `display: none`). This enumeration is new; the count
is unchanged.

### Incidental

Per-element counts, unioned across the states this run's `scaleCensus()` was called in. These move
with the DOM (which panels are open, what artwork is loaded, window size) independent of any real
conformance change. Expected to churn between runs.

| Metric                                                        | Value                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Distinct rendered font-size values                            | 6 (`11, 12, 13.2, 15, 16, 20`px — 4 on-scale, 2 documented icon exceptions) |
| Distinct rendered font-weight values                          | 3 (`400, 600, 700`)                                                         |
| Distinct rendered border-radius values                        | 5 (`1, 2, 3, 10`px and `50%`)                                               |
| Distinct rendered text colors (`color`)                       | 7                                                                           |
| Distinct rendered background colors                           | 28 (mostly per-swatch artwork fills, not app chrome)                        |
| Elements rendering at `border-radius: 0px`                    | 15 sampled (header, chrome, dialog scaffolding — square by design)          |
| Elements rendering black text (UA default, textless controls) | 10 sampled (native checkbox and base swatches — verified false leads)       |

## Method note

Measurements come from `scripts/system-audit-drive.mjs` against a fresh `npm run build`, extended
this run as described above. Token adoption is resolved on the running document rather than read
from `design-system/tokens/*.css`, and the `@import` chain in `src/styles.css:4-6` is what makes
every token inherited rather than co-declared. Console and page errors during the run: none.

Two rows are not re-driven and say so in place: the specimen font check (`design-system/` is
byte-identical to the `2c28f54` report's, so the file-level conclusion carries) and the gradient
rule (a source-level rule about `src/styles.css`, likewise byte-identical). Every other number
here comes from computed style in the running app.

Every reported count in this file was re-derived twice from consecutive runs of the drive script
and agreed both times. The one number that did not agree between runs — the distinct text-colour
count — was the instrument, and is change 3 in "Why the hash moved" above.
