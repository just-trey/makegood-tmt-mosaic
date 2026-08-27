# Handoff: TMT Mosaic Design System

## Overview

This is the component library and visual language for **Mosaic**, the internal tool that
converts a flat-color SVG into per-color recess geometry for multicolor 3D printing (one STL
per color + base plate, for Bambu Studio/AMS). It supports MakeGood's open-source Toddler
Mobility Trainer (TMT) project. The system was reverse-engineered from an early single-file
`index.html` version of the app. The app has since been restructured into TypeScript modules
under `src/` on Vite, and this bundle has been corrected against the running app rather than
against that snapshot — see [docs/system-audit.md](../docs/system-audit.md).

## About the design files

Everything in this bundle is a **design reference**, not production code to import as-is:

- `components/**/*.prompt.md` are the written specs — purpose, structure, states, usage
  notes. These are the component contract. Read the spec, build it in whatever the app
  already uses.
- `ui_kits/mosaic/preview.html` is a full recreation of the Mosaic left-panel + viewport
  screen. Treat it as the layout spec for that screen (grid, header composition, spacing), not
  as shippable markup, and read the note at the top of the file: five things in it no longer
  match the shipped app, panel order among them.
- CSS custom properties in `tokens/*.css` are the canonical design tokens, and the app
  **imports** them: `src/styles.css` opens with `@import` of `tokens/colors.css`,
  `tokens/spacing.css` and `tokens/typography.css` and declares no custom property of its own.
  The two cannot drift apart, because there is only one declaration of each name.

**Removed, deliberately — do not rebuild.** This bundle used to carry `components/**/*.jsx`
React implementations, matching `*.d.ts` prop contracts, and `*.card.html` specimen harnesses
that rendered them. All were deleted: the app is vanilla TypeScript on Vite and can never
import a React component, the harnesses depended on a `_ds_bundle.js` that was never in the
repo (so they had rendered blank for their whole life), and two of the components specified
UI the app has never had. They were vestigial from the day they landed. If you find yourself
wanting them back, you want the `.prompt.md` spec instead.

## Fidelity

**Every component documented here has a live counterpart in the app**, verified against real
computed style rather than assumed. Colors, spacing, type and states were lifted from the app,
not invented — recreate them exactly.

**One exception, and it is a tier rather than a leak: a proposal.** Convention 31 of
[docs/ui-conventions.md](../docs/ui-conventions.md) requires a change needing a component the
system lacks to file a spec instead of inventing markup inline, so proposals have to live
somewhere. They are `Name.prompt.md` files titled `PROPOSED, not built`, they carry the status in
their first line, and the claim above does not cover them: they describe UI the app does not have,
which is the point. `ZoneListRow` and `FilamentSlotStrip` are the two on file. A proposal graduates
by being built and then re-verified against real computed style like any other spec, or it is
deleted. What is barred is the middle state the three deletions below were about: an aspirational
spec presented as a description.

Holding that claim has cost three specs so far, each deleted rather than kept as an aspiration,
because a spec that describes UI the app doesn't have is worse than no spec: a developer reading
it builds the wrong thing confidently.

- `SegmentedControl` — a five-shape base-part picker. The app renders a native `<select>`.
- `ThumbnailSelect` — a thumbnail part library. The app has no such control.
- `Badge` — a bordered monospace status readout with an accent/amber `tone` variant, claimed for
  the header's triangle and color counts. Those render as plain `<span class="stat">` sharing one
  rule (mono, 11px, `--text-dim`): no border, no fill, no tone distinction, and no "amber"
  anywhere in `src/styles.css`. The one element in the app actually classed `badge` is the 8px
  pulsing dot on the help button — a different component doing a different job.

The first two were caught in the pass that wrote this section; `Badge` survived it and was caught
by the next audit. See [docs/system-audit.md](../docs/system-audit.md) for how each gap was
measured.

## Design tokens

See `tokens/colors.css`, `tokens/typography.css`, `tokens/spacing.css` (imported together via
`styles.css`). Key values:

**Colors** (v3 navy/blue palette — see `tokens/colors.css`, WCAG AA re-tuned)

- Canvas: `#0c1220` · Panel: `#141b30` · Panel-2 (inputs/rows): `#1c2440`, raised from panel
- Viewport (3D stage): `#070a13` · Border (hairline, everywhere): `#2b3457`
- Text primary: `#f5f7fb` near-white cool gray · Text secondary: `#aab3cf` muted gray
- Accent primary (blue, primary actions/focus): `#6d93ff`
- Accent secondary (cyan, sparse highlight): `#5eead4`
- Danger (warnings only): `#f9438a`
- Exactly one gradient is used as **colour**: the 8px `.accent-stripe`,
  `linear-gradient(90deg, var(--accent), var(--accent-2))`. One rule, drawn twice, once above the
  header and once along the bottom of the window. Both stops are tokens, so it cannot drift from
  the palette. There is no conic gradient; the app mark is the real logo PNG.
  **Add no further colour blends.**
- The rule bars blends, not the `linear-gradient()` function. `#right`'s viewport backdrop uses
  two more, one per axis, each a 1px `--accent-glow` line against transparent on a 24px tile.
  That is a texture built from hairlines, not a blend between colours, and it is the one
  sanctioned exception. Counting declarations gives three; counting blends gives one.

**Typography**

- Inter (sans, a real webfont — 9 faces load, not a system-sans fallback) for UI
  chrome/labels/copy.
- IBM Plex Mono (also a real loaded webfont, not mockup-only) for every numeric/technical
  value — mm inputs, hex codes, triangle counts. This split is a firm rule: mono = a value the
  user might copy or that came from computed geometry; sans = everything else.
- Five tokens, whole pixels, named by role — see `tokens/typography.css`:
  - `--text-label` (11px) — uppercase section labels, tracked. Only size below body.
  - `--text-meta` (11px, **mono only**) — tris counts, hex, filenames, HUD, version. Shares its
    numeric value with `--text-label` on purpose and is not merged into it: mono at 11px
    optically matches sans at 12px, so the two diverge the moment body size moves.
  - `--text-body` (12px) — everything else: control labels, inputs, buttons, help prose. Also
    the document root size.
  - `--text-emphasis` (16px) — the one size above body. Empty states, dialog titles. Rare.
  - `--text-display` (20px) — wordmark only.
- A handful of glyphs used as icons (▸ disclosure, × dismiss, ↺ reset) are sized in `em` against
  their inherited text context instead of a token — see Iconography below.
- Heading font: Outfit, for the "Mosaic" wordmark + Panel section labels.
- Weight is `--weight-regular` (400), `--weight-semibold` (600) or `--weight-bold` (700). Nothing
  else renders.
- Tracking: `--tracking-label` (0.08em) on the uppercase Panel labels. Nowhere else.
- Leading, three roles by what a block is for, not by how tight it looks:
  - `--leading-none` (1) — glyph-as-icon buttons, where the glyph is the box.
  - `--leading-normal` (1.5) — UI text: hints, empty states, the viewport HUD.
  - `--leading-prose` (1.55) — paragraphs meant to be read: help sections, dialogs, the narrow
    notice.

**Spacing / radius / borders**

- Five tokens — see `tokens/spacing.css`:
  - `--space-hair` (2px) — optical correction inside a control: swatch-grid gaps, badge
    insets. Never rhythm between rows — that is `--space-row` up.
  - `--space-tight` (4px) — inside a control: label-to-input, icon-to-text.
  - `--space-row` (8px) — between rows within a panel.
  - `--space-section` (16px) — between labelled groups inside a panel.
  - `--space-panel` (24px) — between panels.
- Compact by default — this is a tool, not a marketing surface. Don't loosen into typical
  marketing whitespace; a conversion that reads airier than today picked the wrong step.
- 1px hairline borders everywhere (`--line`), no shadows. There is deliberately no
  `--border-width` token: the width is fixed by this rule, so a token buys nothing, and the three
  exceptions (1.5px badge ring, 1.5px dashed dropzone, 2px spinner) are each their own decision.
- Swatches are the one border exception, and they use `--swatch-line` (translucent white), not
  `--line`. A swatch outlines a filament colour the user picked, and a dark navy hairline vanishes
  against a dark swatch.
- Sharp, near-square corners (`--radius-*` = 0–3px, industrial/blueprint feel): inputs 1px,
  buttons/rows/thumbnails 2px, dropzones 3px, swatches square (0px). See `tokens/spacing.css`.

**States**

- Hover: border brightens to accent blue (buttons/inputs), or a `brightness(1.08)` filter bump
  on the solid primary button. No color-shift-to-lighter-bg hover.
- Focus: border turns solid blue. No glow/outline ring.
- Disabled: opacity 0.4, `cursor: not-allowed`. Never grayscale recoloring.
- Drag-over (dropzone): border + text turn blue, faint blue wash fills background.
- Transitions: `--transition-fast` (0.12s) for border-color, color and filter, which is every
  hover and focus state above. Opacity and transform fades run 0.1–0.15s and stay literals: they
  are per-element feel rather than a scale, and three sites do not make one. No page transitions,
  and no spring or bounce easing anywhere.

## Components

Each component in `components/<category>/` is one file: `Name.prompt.md`, the written spec —
purpose, structure, states, usage notes.

Categories:

- **forms/** — Button, TextInput, Select, Checkbox, Slider
- **layout/** — Panel (repeating uppercase-label + hairline-rule sidebar section shell — not a
  bordered card)
- **feedback/** — WarningPill, LoadingOverlay
- **misc/** — Dropzone, ColorRow

There are no per-category specimen sheets. `guidelines/*.html` cover the foundations (color,
type, spacing/radius, brand mark) and open directly in a browser.

## Screens

### Mosaic — main tool screen (`ui_kits/mosaic/preview.html`)

- **Purpose**: load an SVG, pick a part, fit and merge detected colors into recess
  depths, export a print-ready 3MF.
- **Layout**: CSS grid, `340px 1fr` columns × `64px 1fr` rows. Header spans both columns.
  Left sidebar (`#left`) is `var(--panel)`, scrollable, `--space-section` (16px) padding, holds
  six stacked `Panel` sections in order: Part, Artwork, Artwork fit, Depth, Colors detected,
  Export. Right side (`#right`) is the 3D viewport — `var(--viewport)` with a faint
  24px grid background, a HUD readout (top-left, monospace), a warning pill (bottom, full
  width), and a loading overlay (covers viewport when busy).
- **Header**: MakeGood logo (34px tall) + "TMT Mosaic" wordmark (Outfit, `--text-display`
  20px/600) + a version tag linking the changelog + subtitle ("for the MakeGood TMT · SVG or
  image → multicolor recess geometry") + two right-aligned monospace stat readouts (triangle
  count, color count) + a labeled "Help" button (`.btn.small`, matching the Feedback trigger's
  treatment). The stats are plain `<span class="stat">` —
  mono, `--text-meta` (11px), `--text-dim`, no border or fill and no per-stat tone. `preview.html`
  draws them as bordered two-tone badges instead; that is mockup-only, and the `Badge` spec it
  implies was deleted (see Fidelity).
- **Panel: Part** — a native `<select>` (`#shape-kind`) holding one option per visible
  assembly kind, by name, plus "Disc (reference)" last. Disc shows Diameter/Thickness number
  inputs (mm). Assembly shows a "↻ Reload assembly" button, a "+ Add {role}" button per role,
  and a row per part with a drop target and a `<select>` for face index. Rect, round rect and
  STL-reference modes exist in the code but are deliberately unreachable — they are never
  written into the dropdown, so do not spec UI for them.
- **Panel: Artwork** — Dropzone + "Load sample artwork" button (small, full width) + hint text
  about flat-color-only support.
- **Panel: Artwork fit** — Margin and Scale sliders with live `%` value labels + Flip H / Flip V
  checkboxes + "Reset to auto-fit" button. Margin is hidden on an assembly part, which is every
  part the dropdown offers.
- **Panel: Depth** — Default depth number input (mm). The "Recess bg too" checkbox is hidden on an
  assembly part: it only ever cut a background on the flat plate modes.
- **Panel: Colors detected** — a stacked ColorRow list (drag grip, swatch, hex, area %,
  "Merge with…" select, per-row depth input) + hint text. There is no bulk-select checkbox and
  no "Merge selected" button; merging is per-row. See `ColorRow.prompt.md`.
- **Panel: Export** — primary full-width "Export print-ready 3MF" button (`#btn-export`, triggers
  the loading overlay for ~900ms in the mockup) + a small full-width "Export STL set (.zip)"
  button below it (`#btn-export-stl`, the fallback for other slicers) + hint text.

## Interactions

- Dropzone: drag-over turns border, text and background to accent blue; drop hands over the
  files.
- ColorRow: drag the grip onto another row to merge, or use the row's "Merge with…" select for
  the same operation by keyboard. A merged row shows member swatches, each removable. Swatch,
  hex (mono), area %, and a depth number input.
- Buttons/inputs: see hover/focus/disabled states under Design tokens → States above.
- Loading overlay: full-viewport dim (rgba(13,15,17,.85)) + spinner (0.8s linear rotate) +
  label text; blocks interaction with the viewport while visible.

## Iconography & imagery

No icon font or SVG icon set — text labels carry the UI, and the mark is the real MakeGood
logo PNG in the header. A handful of inline glyphs are load-bearing and count as the
exceptions: `⠿` (ColorRow drag grip), `×` (dismiss / remove), `↻` (reload assembly), `↺`
(reset depth), `⚠`/`ℹ` (warning tone prefixes), `▸`/`▾` (section disclosure). Don't introduce
an icon library without checking with the team first. If a future screen needs icons,
standardize on one CDN set (e.g. Lucide) and document it as an addition here — don't hand-draw
SVG icons.

Five of these glyphs (`▸`, the two `×` dismiss/close glyphs, `↺`, the member-swatch `×`) are
sized in `em` against their inherited text context rather than a `--text-*` token: an icon's
size is optical, relative to the text beside it, which `em` expresses and a fixed token cannot —
and it means they never need re-tuning when body size moves. They are deliberately off the
5-step type scale; a system audit should read that as intended, not as drift.

## Assets

- `assets/makegood-logo.png` — real MakeGood wordmark, used in the header at 34px height.

## Voice / content rules (for any new copy)

- Precise, technical, first-person when explaining tradeoffs; confident but transparent about
  limitations.
- No emoji, no marketing fluff. Copy favors units and specifics (mm, %, tris) over adjectives.
- Second person for UI copy ("Drop an SVG here…"), first person for docs/changelog prose.
- **"Technical" here means technical in printing, not in CAD.** For any user-facing string,
  conventions 33–37 of `docs/ui-conventions.md` decide which technical words are free: one from a
  slicer's UI is (filament, layer height, prime tower), one from ours is not (quantize, boolean,
  cut solid, viewBox). Those conventions do not override the three rules above. "Units and
  specifics over adjectives" still governs the numbers inside the sentence: never drop a
  measurement to sound friendlier.

## Files in this bundle

- `styles.css` + `tokens/` — root stylesheet and CSS custom properties (colors, type, spacing)
- `components/` — one `.prompt.md` spec per component
- `ui_kits/mosaic/preview.html` — full screen recreation (open directly in a browser); read
  the note at the top of the file before treating any control in it as current
- `assets/makegood-logo.png` — logo asset
- `guidelines/` — foundation specimen pages (color, type, spacing/radius, brand mark) for
  quick visual reference. Nine of ten load the declared font families and render in Outfit /
  Inter / IBM Plex Mono, not in a fallback. The exception is `brand-makegood-site.html`: it
  sets `font-family: sans-serif` and applies none of the three, deliberately — it documents
  makegood.design, a different brand with its own typography, not a Mosaic component specimen.

## Not in scope

Two further, distinct visual languages were referenced but not built out: a cooler
Tailwind/shadcn "ocean-blue" forum app (3d-mobility.org) and a warm rainbow-gradient nonprofit
marketing site (makegood.design). Their token files are `tokens/colors-3dmobility.css` and
`tokens/colors-makegood.css`, for reference only. Do not use either for the Mosaic tool itself.

**`tokens/colors-makegood-dark.css` is not one of those two, and this rule does not apply to it.**
It is makegood.design's dark palette, re-tuned for WCAG AA, and it is the direct source of Mosaic's
own: nine of its entries are the app's colors verbatim, name-for-name.

| `colors-makegood-dark.css` | `colors.css` | Value     |
| -------------------------- | ------------ | --------- |
| `--mgd-bg`                 | `--bg`       | `#0c1220` |
| `--mgd-surface`            | `--panel`    | `#141b30` |
| `--mgd-surface-2`          | `--panel-2`  | `#1c2440` |
| `--mgd-border`             | `--line`     | `#2b3457` |
| `--mgd-text-primary`       | `--text`     | `#f5f7fb` |
| `--mgd-text-secondary`     | `--text-dim` | `#aab3cf` |
| `--mgd-accent-blue`        | `--accent`   | `#6d93ff` |
| `--mgd-accent-cyan`        | `--accent-2` | `#5eead4` |
| `--mgd-accent-pink`        | `--danger`   | `#f9438a` |

Read it as the provenance of the palette, not as a foreign one to keep out. Changing a color in
one and not the other is what puts them out of step.
