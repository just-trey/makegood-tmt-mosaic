# System audit

Does the design system in `design-system/` currently **govern**, **describe**, or **misdescribe**
the running app? This report is the `system` lens of `/review-gauntlet` — computed style measured
against the running app, checked against the design system's own written specs, not against a
screenshot.

## Measurement conditions

|                                    |                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| App commit (SHA)                   | `026a9cf178d5744447e5ffa75fc41811c1edc2bf`                                                                                    |
| Design system version              | same commit — `design-system/` lives in this repo, no separate SHA                                                            |
| Viewport                           | 1440 × 960, device pixel ratio 1                                                                                              |
| Renderer                           | ANGLE (D3D12, NVIDIA GeForce RTX 2060) — hardware, not software fallback                                                      |
| Drive script                       | [`scripts/system-audit-drive.mjs`](../scripts/system-audit-drive.mjs), content hash `d5a3d9543e06ae7a` (sha256, first 16 hex) |
| Console/page errors during the run | none                                                                                                                          |

**States measured**: initial load (default-selected shape kind, which is an assembly kind — see
Finding 4); help dialog open; 6-color artwork loaded (Colors detected populated, default printer's
"multi-unit" info pill live); printer switched to Snapmaker U1 (its "over-max" warn pill live);
confirm dialog open (triggered by switching shape kind with artwork loaded); a hover pass (default
button, dropzone), a focus pass (text input), and a real `dragover` dispatch (dropzone) layered on
the states above.

**States _not_ reached this run** (recorded per the lens's own rule — a state not entered is not
measured, and the gap is silent unless stated): the loading-overlay's `visible` moment (rebuild
curtain — only the at-rest `display:none` state was observed); ColorRow's `.dragging` /
`.drop-target` mid-drag states (native HTML5 drag-and-drop isn't reliably scriptable headlessly);
a populated Base row and a merged color group (`.member-swatch`, `.swatch.pinned`); the primary
Button variant's `:hover` (the only enabled primary button live in this run was the confirm
dialog's OK, not hovered); the depth-override `.overridden` input state and its `↺` reset button;
`.base-swatch`'s `:hover`/beyond-default state; a native `<select>`'s open dropdown (browser
popup UI, not part of the DOM/CSSOM). Any row below drawing on one of these is marked accordingly
rather than reported as if it were checked.

`docs/system-audit.md` did not exist in this repo before this run. `design-system/README.md` and
`design-system/ui_kits/mosaic/preview.html` (both from the same commit under audit) already cite
this file as the source of prior measurements — that citation predates the file's actual
existence in the repo's history. Nothing here can confirm or deny what an earlier, uncommitted
audit found; this is the first record.

## Verdict

**Describes, with real gaps.** This is a real improvement over "misdescribes" — the repair commit
under audit (`026a9cf`) removed two components (`SegmentedControl`, `ThumbnailSelect`) that
described UI the app never had, and every component this run checked against a live element (10 of 11) does have one, mostly behaving as specced. But the pass wasn't complete: one more component is
still fiction (Finding 1), three real buttons silently render outside the declared type system in a
way no one reading the CSS would predict (Finding 2), and the token layer the whole system claims
as shared vocabulary is, for two of its three token files, essentially unused as CSS custom
properties in the app — present as matching literals, not as a link (Finding 5). None of these are
visible from a screenshot or from reading the stylesheet in isolation; all five were computed-style
measurements.

## Findings, ranked by impact

1. **Badge is fiction — no live counterpart.** `Badge.prompt.md` documents a monospace status
   readout with a `tone="accent"` variant (`<Badge tone="accent">4 / 4 AMS slots used</Badge>`),
   used per the README for the header's tri/color counts ("amber tone for the color count"). The
   live header renders both as plain `<span class="stat">`, sharing one CSS rule
   (`header .stat { font-family: var(--mono); font-size: 11px; color: var(--text-dim); }`) — no
   border, no background, no tone distinction, no "amber" anywhere in `src/styles.css` (confirmed
   by full-file search, not just the rendered instance). The only element in the entire app with
   `class="badge"` is `#btn-help-badge`, an 8px pulsing notification dot on the help icon
   (`.icon-btn .badge { border-radius: 50%; background: var(--accent-2); }`) — a different
   component doing a different job, not a text readout. This is exactly the defect class the
   audited commit's own README claims to have eliminated ("Every component documented here has a
   live counterpart in the app, verified against real computed style rather than assumed") — it
   caught two, missed a third.

2. **Three real buttons silently render outside the declared type system.** `.close-btn`
   (help dialog's `×`), `.warn-dismiss` (per-warning pill `×`), and `.warn-clear-all`
   ("Dismiss all (N)") each omit `font-family` in `src/styles.css`. Native `<button>` elements do
   not inherit typography from ancestors by default — unlike a `<span>` or `<a>`, a bare button
   falls back to the browser's own UI font. Computed style, measured live: all three resolve to
   `fontFamily: "Arial"`, not the declared Inter sans stack every other UI element in the app uses.
   This is invisible in a screenshot (Arial and Inter are close at 10.5–15px) and invisible from
   reading the stylesheet — nothing there suggests these three don't inherit like every other
   button does. One-line fix per rule, or a single `button { font: inherit; }` reset to close the
   whole class of bug at once.

3. **The accent color's own name is contradicted inside the system.** `design-system/README.md`
   states the primary accent correctly: "blue (primary actions/focus): `#6d93ff`". Three component
   specs call the identical, computed-verified color "teal" instead:
   `Button.prompt.md` ("high-emphasis 'primary' (teal fill)"), `Checkbox.prompt.md` ("teal
   accent"), `Dropzone.prompt.md` ("lights up teal on drag-over"). Live computed style settles it:
   the primary Export button's `backgroundColor` is `rgb(109, 147, 255)` (`#6d93ff`, `--accent`,
   blue); the dropzone's drag-over `borderColor`/`color` are the same blue; the focused text
   input's border is the same blue. `--accent-2` (`#5eead4`, the actual teal) exists and is used
   elsewhere (the help badge dot, `--slot-count`'s default text) but never on any of these three
   components. `ui_kits/mosaic/preview.html`'s own `Button` implementation also correctly uses
   `var(--accent)` for primary — so the mockup and the app agree with each other and disagree with
   three of the four places that describe them in prose.

4. **The Export panel's documented primary action is the wrong one.** `README.md`'s Screens
   section and `preview.html` (`'Export STL set (.zip)'` on a `variant: 'primary'` Button) both
   describe the Export panel's primary full-width button as the STL zip. Live, `#btn-export` (class
   `btn primary full`) reads "Export print-ready 3MF"; "Export STL set (.zip)" is `#btn-export-stl`
   — class `btn small full`, no `primary`, the secondary/fallback action per its own hint text
   ("3MF is print-ready … the STL set is the fallback for other slicers"). The two docs have the
   panel's hierarchy backwards, not just its copy.

5. **Two of the three token files are barely adopted as CSS custom properties — present as
   matching literals, not as a link.** Of 47 tokens declared across `tokens/colors.css`,
   `tokens/spacing.css`, and `tokens/typography.css`, 20 (43%) resolve under their declared name in
   the running app — all 16 color tokens, plus 4 of 5 radius tokens. **None are inherited**: the
   app never `@import`s `design-system/tokens/*.css` (confirmed by search — the only match is a
   comment), so every one of those 20 is **co-declared**: `src/styles.css` independently redeclares
   the same name with the same value, which is agreement today with nothing structural to catch
   tomorrow's drift. The other 27 (57%) are UNSET — no property under that name exists in the app
   at all. That includes every one of the 9 `--space-*` steps (the app hardcodes literal px
   paddings/gaps throughout instead) and every one of the 6 `--text-*` size steps, the 3
   `--weight-*` steps, and `--tracking-label`/`--leading-tight`/`--leading-normal` (the app
   hardcodes literal font-sizes and weights instead — see Finding 7 for what that produces). Three
   of the 27 are a distinct, worse case: `--font-heading`/`--font-sans`/`--font-mono` resolve to a
   matching _value_ only because the app happens to declare the same three font stacks under
   entirely different names (`--heading`/`--sans`/`--mono`) — not even name-matching, just
   coincidence. Renaming either side today would break nothing and no one would notice; that's the
   opposite of adoption.

6. **`preview.html` discloses three stale controls in its own header comment — there are at least
   two more it doesn't mention.** Its panel title reads "Base part" (`{ title: 'Base part' }`); the
   live app's is "Part". Its primary Export button is "Export STL set (.zip)" (same defect as
   Finding 4, independently present in the mockup, not just the prose docs it's supposed to
   correct for). Both are exactly the kind of drift the file's own disclaimer exists to track — its
   list should be five items, not three.

7. **The type-size scale is 17% fiction and ~21% of rendered text sits off it — split unevenly
   across "fine" and "not fine" gaps.** Declared: `--text-xs`(10.5) / `sm`(11) / `sm-plus`(11.5) /
   `md`(12) / `base`(13) / `lg`(14). Rendered, unioned across every state measured: `{10, 10.5, 11,
11.5, 12, 12.5, 13, 13.3333, 13.5, 15, 18}px`.
   - **Fiction**: `--text-lg` (14px) — zero elements render at 14px anywhere this run touched.
   - **Drift** (rendered, not declared): `10px`(14 elements), `12.5px`(54), `13.3333px`(36),
     `13.5px`(8, `.help-sec h3`), `15px`(2, `.help-head h2`), `18px`(1, `header h1`) — 115 of 559
     font-sized elements measured (21%). The two dialog-only sizes (13.5, 15) are real scale
     entries the app needed and the declared 6-step scale doesn't offer between `base` and
     nothing-above-it; the main heading's 18px sits entirely outside the numeric scale, need
     documented only in README prose, not in `tokens/typography.css` itself.
   - **Below perceptual threshold** (the scale asserts a distinction no one could see): declared
     `10.5` vs drift `10` (0.5px), declared `12` vs drift `12.5` (0.5px), declared `13` vs drift
     `13.3333` (0.33px). Three of the six declared steps have a same-or-tighter neighbor that isn't
     even declared, let alone a declared one.
   - Font-_weight_ is the clean counter-example: all three declared steps (400/600/700) render,
     nothing else does. 0% fiction, 0% drift — the scale that only has three, well-separated steps
     is the one nobody violates.

8. **`--radius-xl` fails twice over.** It's UNSET per Finding 5 (the app never declares it under
   any name), and even inside `tokens/spacing.css` itself it's a value-duplicate of `--radius-lg`
   (both `2px`) — a named scale step that was never distinguishable from its neighbor even where it
   is authored. `--radius-sm` (0px) is a different problem: computed style can't tell "an element
   deliberately styled to 0px radius" from "an element nothing ever set a radius on" — both read
   identically as `0px`. It genuinely is applied (`.swatch`, `.base-swatch`, `.member-swatch` all
   use it), but a computed-style census structurally cannot confirm that, which is a limitation of
   this method for value-`0` scale steps specifically, stated rather than papered over with a false
   "0 uses."

9. **`ColorRow.prompt.md`'s own example uses a class name that collides with something else.** Its
   sample markup wraps the row in `<div class="row">…</div>`. The live component's real outer class
   is `.color-row` (confirmed in `src/ui/colorList.ts`); `.row` is already a distinct, unrelated
   pattern used throughout the app's own Panel forms (the generic `label` + `.field` layout row —
   `display:flex; gap:8px`). A developer copying the spec's markup literally would collide with an
   existing, differently-shaped rule.

10. **"Exactly one gradient" underclaims by two.** `README.md`: "Exactly one gradient: the 3px
    `.accent-stripe`… Add no further gradients." `src/styles.css` has three `linear-gradient()`
    declarations: the documented stripe (confirmed — its three literal colors,
    `rgb(124,58,237)/rgb(76,95,215)/rgb(13,148,136)`, match the README exactly and are un-tokenized
    literals as claimed), plus two more forming `#right`'s faint 24px grid backdrop
    (`linear-gradient(var(--accent-glow) 1px, transparent 1px)`, both axes). The grid lines read as
    a repeating texture rather than a color blend, which may be what the rule is trying to exclude
    — but the rule as written doesn't say that, so as written it's contradicted by the file two
    inches below it.

11. **One of ten guideline specimens never loads any of the three declared fonts.**
    `guidelines/brand-makegood-site.html` sets `font-family: sans-serif` and never applies
    Outfit/Inter/IBM Plex Mono to any element (confirmed live: forcing `document.fonts.load()` for
    every family actually used on the page finds zero uses of any of the three). This contradicts
    the README's blanket claim ("All ten load the declared font families… they render in Outfit /
    Inter / IBM Plex Mono, not in a fallback"). Lower severity — this file is deliberately a
    reference for a different brand (makegood.design, explicitly out of scope for Mosaic per the
    same README) rather than a Mosaic component specimen — but the claim as written doesn't carve
    out that exception, and every other of the ten (including `preview.html`) does load all three
    fonts it uses, computed-verified with the same method.

12. **`Slider.prompt.md` undersells the real component.** Its JSX (`valueLabel={scale + '%'}`)
    implies a static, read-only readout beside the track. The live implementation
    (`.field.pair`) pairs the range input with a genuinely editable, two-way-synced number input —
    typing a value moves the slider and vice versa. Not wrong, but a developer building from the
    spec alone would build something less capable than what's already shipped.

## Confirmed accurate (checked, not just assumed)

- **WarningPill** — both tones computed-style-verified to match the spec's table exactly (info:
  `--accent-wash`/`--accent`/`--text-dim`; danger: `--danger-wash`/`--danger-border`/
  `--danger-text`), triggered live via real AMS-slot-budget warnings, not simulated.
- **The mono/sans split** ("mono = a value the user might copy or that came from computed
  geometry") — held with no exceptions across every text element checked: hex codes, depth/mm
  inputs, tri/color counts, the slot-count line, all resolve to the IBM Plex Mono stack; labels,
  hints, and buttons resolve to Inter.
- **Danger red stays reserved for warnings/invalid state** — no decorative use found anywhere else
  in the 141-declaration var() census.
- **Panel, TextInput, Select, LoadingOverlay** specs match their live counterparts structurally and
  in computed style (uppercase-label-plus-hairline shell; mono numeric fields; select styled
  identically to TextInput; overlay dim + spinner + label behind a `position:relative` host).
- **Hover and focus transitions work as specified** once measured past the CSS transition itself
  (`border-color` → `--accent` on `.btn:hover`, `#dropzone:hover`, and `input:focus`) — the first
  pass of this audit under-measured these by reading computed style synchronously after
  `page.hover()`/`.focus()`, before the app's own 0.12s transition had run a frame; corrected in
  the drive script (`HOVER_SETTLE_MS`), and now genuinely confirmed rather than assumed.

## Measurements

### Structural

Diff this block between runs to see whether conformance moved. Rows marked `†` are state-sensitive
— see the header for which states this run covered before treating a `†` difference as drift
rather than incomparable coverage.

| Metric                                                                                  | Value                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Tokens declared (all 3 files)                                                           | 47                                                                                 |
| Tokens resolving under declared name                                                    | 20 (43%)                                                                           |
| — inherited (via `@import`)                                                             | 0                                                                                  |
| — co-declared (independent, matching value)                                             | 20                                                                                 |
| Tokens UNSET under declared name                                                        | 27 (57%)                                                                           |
| — of which, value-equivalent under a different app-side name                            | 3 (`--font-heading/sans/mono`)                                                     |
| — of which, no equivalent under any name                                                | 24                                                                                 |
| Scale-relevant declarations using `var()` in `src/styles.css`‡                          | 141                                                                                |
| Scale-relevant declarations using a literal                                             | 85                                                                                 |
| var() adoption rate (scale-relevant declarations)                                       | 62.4%                                                                              |
| Components with a live counterpart                                                      | 10 / 11                                                                            |
| Components that are fiction (no live counterpart)                                       | 1 / 11 (Badge)                                                                     |
| Font-size scale entries rendering nowhere (fiction) †                                   | 1 / 6 (`--text-lg`)                                                                |
| Font-size values rendered that the scale doesn't contain (drift) †                      | 6 distinct                                                                         |
| Font-weight scale entries rendering nowhere                                             | 0 / 3                                                                              |
| Font-weight values rendered outside the scale                                           | 0                                                                                  |
| Border-radius named steps duplicating another step's value (system-internal)            | 1 (`--radius-xl` = `--radius-lg`, both 2px)                                        |
| Specimen files (guidelines + preview.html) confirmed loading every font family they use | 9 / 10                                                                             |
| Documented component states confirmed live this run †                                   | 9                                                                                  |
| Documented component states not reached this run (see header) †                         | 8                                                                                  |
| Semantic rules checked                                                                  | 4 (mono/sans split, danger-for-warnings-only, accent color naming, gradient count) |
| Semantic rules holding as documented                                                    | 2 (mono/sans split, danger-for-warnings-only)                                      |
| Semantic rules contradicted by the system's own docs                                    | 2 (accent color name, gradient count)                                              |

‡ `font-size`, `font-weight`, `border-radius`, `color`, `background`/`background-color`,
`border`/`border-color` — the properties Scale Adherence and Adoption both depend on. Raw
declaration count, not the app's full stylesheet.

### Incidental

Per-element counts. These move with the DOM (which panels are open, what artwork is loaded, window
size) independent of any real conformance change — sized here to show how much evidence backs each
structural row above, not tracked as its own trend.

| Metric                                                          | Value                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Elements checked in the full-page scale census (`#app *`)       | ~830 (varies by state)                                                                                                               |
| Distinct rendered font-size values (union of all states)        | 11                                                                                                                                   |
| Distinct rendered font-weight values                            | 3                                                                                                                                    |
| Distinct rendered border-radius values (excl. `50%` circles)    | 5                                                                                                                                    |
| Distinct rendered text colors (`color`)                         | 7 (5 map to real tokens; 2 are native-control UA defaults on textless elements — checkboxes, range inputs — verified, not a finding) |
| Distinct rendered background colors                             | 26 (most are single-occurrence artwork swatch fills reflecting the loaded SVG's own colors, not app chrome)                          |
| Font-size = 13px (base)                                         | 163 elements                                                                                                                         |
| Font-size = 11px (sm)                                           | 105 elements                                                                                                                         |
| Font-size = 12px (md)                                           | 103 elements                                                                                                                         |
| Font-size = 10.5px (xs)                                         | 69 elements                                                                                                                          |
| Font-size = 12.5px (drift)                                      | 54 elements                                                                                                                          |
| Font-size = 13.3333px (drift)                                   | 36 elements                                                                                                                          |
| Font-size = 10px (drift)                                        | 14 elements                                                                                                                          |
| Font-size = 13.5px (drift, help dialog only)                    | 8 elements                                                                                                                           |
| Font-size = 11.5px (sm-plus)                                    | 4 elements                                                                                                                           |
| Font-size = 15px (drift, help dialog only)                      | 2 elements                                                                                                                           |
| Font-size = 18px (drift, main heading)                          | 1 element                                                                                                                            |
| Font-weight = 400                                               | 514–ish elements (state-dependent)                                                                                                   |
| Font-weight = 700                                               | 39 elements                                                                                                                          |
| Font-weight = 600                                               | 6 elements                                                                                                                           |
| Border-radius = 1px (md)                                        | 53 elements                                                                                                                          |
| Border-radius = 2px (lg/xl, indistinguishable)                  | 38 elements                                                                                                                          |
| Border-radius = 3px (2xl)                                       | 11 elements                                                                                                                          |
| Border-radius = 50% (circles, not on the linear scale)          | 4 elements                                                                                                                           |
| Border-radius = 6px (drift, source not conclusively identified) | 2 elements                                                                                                                           |
| Border-radius = 10px (drift — `.version-tag`, literal)          | 1 element                                                                                                                            |
| Buttons found rendering in the browser UA font instead of Inter | 3 (`.close-btn`, `.warn-dismiss`, `.warn-clear-all`)                                                                                 |

## Method note

Computed-style census cannot distinguish a `0px` (or otherwise UA-default-matching) value that was
deliberately set from one nothing ever set — both read identically. This affected `--radius-sm`
(Finding 8) and produced two false leads chased and ruled out during this run: `color: rgb(0, 0, 0)`
on 26 elements (all `<input type="checkbox">`/`.base-swatch` buttons with no text content — the
`color` property is simply irrelevant to what's rendered) and `background-color: rgb(255, 255, 255)`
on 6 `<input type="range">` elements (native UA default on the outer element; the visually painted
track is a pseudo-element `getComputedStyle` on the host element doesn't see). Neither is reported
as a finding above; both are recorded here so a future run doesn't have to re-chase them.
