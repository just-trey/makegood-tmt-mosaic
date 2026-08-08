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
  screen. Treat it as the layout spec for that screen — grid, panel order, header
  composition, spacing — not as shippable markup, and read the note at the top of the file:
  three of its controls no longer match the shipped app.
- CSS custom properties in `tokens/*.css` are the canonical design tokens. `tokens/colors.css`
  declares the same names the app declares in `src/styles.css`, so the two are one vocabulary
  rather than two that happen to share hex values.

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
- Exactly one gradient: the 3px `.accent-stripe` across the top of the window,
  `linear-gradient(90deg, #7c3aed, #4c5fd7, #0d9488)`. Those three colors have no token
  identity anywhere — literals in `src/styles.css`, absent from every token file. There is no
  conic gradient; the app mark is the real logo PNG. Add no further gradients.

**Typography**

- Sans stack (system sans) for UI chrome/labels/copy.
- Monospace (IBM Plex Mono in the mockup) for every numeric/technical value — mm inputs, hex
  codes, triangle counts. This split is a firm rule: mono = a value the user might copy or
  that came from computed geometry; sans = everything else.
- Base size 13px. Never below 10.5px (uppercase section labels only, with letter-spacing).
- Heading font: Outfit (mockup only used it for the "Mosaic" wordmark + Panel section labels).

**Spacing / radius / borders**

- Compact paddings (5–8px), tight row gaps (6–8px) — this is a tool, not a marketing surface.
  Don't loosen into typical marketing whitespace.
- 1px hairline borders everywhere (`--line`), no shadows.
- Sharp, near-square corners (`--radius-*` = 0–3px, industrial/blueprint feel): inputs 1px,
  buttons/rows/thumbnails 2px, dropzones 3px, swatches square (0px). See `tokens/spacing.css`.

**States**

- Hover: border brightens to accent blue (buttons/inputs), or a `brightness(1.08)` filter bump
  on the solid primary button. No color-shift-to-lighter-bg hover.
- Focus: border turns solid blue. No glow/outline ring.
- Disabled: opacity 0.4, `cursor: not-allowed`. Never grayscale recoloring.
- Drag-over (dropzone): border + text turn blue, faint blue wash fills background.
- Transitions: 0.12s border-color/filter only. No page transitions, no spring/bounce easing
  anywhere.

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

- **Purpose**: load an SVG, pick a base part, fit and merge detected colors into recess
  depths, export an STL set.
- **Layout**: CSS grid, `340px 1fr` columns × `64px 1fr` rows. Header spans both columns.
  Left sidebar (`#left`) is `var(--panel)`, scrollable, 14px padding, holds six
  stacked `Panel` sections in order: Artwork, Base part, Artwork fit, Depth, Colors detected,
  Export. Right side (`#right`) is the 3D viewport — `var(--viewport)` with a faint
  24px grid background, a HUD readout (top-left, monospace), a warning pill (bottom, full
  width), and a loading overlay (covers viewport when busy).
- **Header**: MakeGood logo (34px tall) + "TMT Mosaic" wordmark (Outfit, 18px/600) + a version
  tag linking the changelog + subtitle ("for the MakeGood TMT · SVG or image → multicolor recess
  geometry") + two right-aligned monospace stat readouts (triangle count, color count) + a
  circular "?" help button. The stats are plain `<span class="stat">` — mono, 11px, `--text-dim`,
  no border or fill and no per-stat tone. `preview.html` draws them as bordered two-tone badges
  instead; that is mockup-only, and the `Badge` spec it implies was deleted (see Fidelity).
- **Panel: Artwork** — Dropzone + "Load sample artwork" button (small, full width) + hint text
  about flat-color-only support.
- **Panel: Base part** — a native `<select>` (`#shape-kind`) holding one option per visible
  assembly kind, by name, plus "Disc (reference)" last. Disc shows Diameter/Thickness number
  inputs (mm). Assembly shows a "↻ Reload assembly" button, a "+ Add {role}" button per role,
  and a row per part with a drop target and a `<select>` for face index. Rect, round rect and
  STL-reference modes exist in the code but are deliberately unreachable — they are never
  written into the dropdown, so do not spec UI for them.
- **Panel: Artwork fit** — Margin and Scale sliders with live `%` value labels + "Reset to
  auto-fit" button.
- **Panel: Depth** — Default depth number input (mm) + "Recess bg too" checkbox.
- **Panel: Colors detected** — a stacked ColorRow list (drag grip, swatch, hex, area %,
  "Merge with…" select, per-row depth input) + hint text. There is no bulk-select checkbox and
  no "Merge selected" button; merging is per-row. See `ColorRow.prompt.md`.
- **Panel: Export** — primary full-width "Export STL set (.zip)" button (triggers the loading
  overlay for ~900ms in the mockup) + hint text.

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
(reset depth), `⚠`/`ℹ` (warning tone prefixes). Don't introduce an icon library without
checking with the team first. If a future
screen needs icons, standardize on one CDN set (e.g. Lucide) and document it as an addition
here — don't hand-draw SVG icons.

## Assets

- `assets/makegood-logo.png` — real MakeGood wordmark, used in the header at 34px height.

## Voice / content rules (for any new copy)

- Precise, technical, first-person when explaining tradeoffs; confident but transparent about
  limitations.
- No emoji, no marketing fluff. Copy favors units and specifics (mm, %, tris) over adjectives.
- Second person for UI copy ("Drop an SVG here…"), first person for docs/changelog prose.

## Files in this bundle

- `styles.css` + `tokens/` — root stylesheet and CSS custom properties (colors, type, spacing)
- `components/` — one `.prompt.md` spec per component
- `ui_kits/mosaic/preview.html` — full screen recreation (open directly in a browser); read
  the note at the top of the file before treating any control in it as current
- `assets/makegood-logo.png` — logo asset
- `guidelines/` — foundation specimen pages (color, type, spacing/radius, brand mark) for
  quick visual reference. All ten load the declared font families; they render in Outfit /
  Inter / IBM Plex Mono, not in a fallback.

## Not in scope

Two further, distinct visual languages were referenced but not built out: a cooler
Tailwind/shadcn "ocean-blue" forum app (3d-mobility.org) and a warm rainbow-gradient nonprofit
marketing site (makegood.design). Their token files are in `tokens/colors-3dmobility.css` and
`tokens/colors-makegood.css` for reference only — do not use them for the Mosaic tool itself.
