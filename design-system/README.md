# Handoff: TMT Mosaic Design System

## Overview

This is the component library and visual language for **Mosaic**, the internal tool that
converts a flat-color SVG into per-color recess geometry for multicolor 3D printing (one STL
per color + base plate, for Bambu Studio/AMS). It supports MakeGood's open-source Toddler
Mobility Trainer (TMT) project. The system was reverse-engineered from the real Mosaic app
(a single-file `index.html`) and formalized into reusable, documented components.

## About the design files

Everything in this bundle is a **design reference**, not production code to import as-is:

- `components/**/*.jsx` are close-to-final React implementations meant to be **ported into
  the target codebase's existing environment** (whatever framework/build setup
  makegood-tmt-mosaic actually uses), adapting to its conventions (state management, file
  layout, existing utilities) rather than copy-pasted wholesale.
- `ui_kits/mosaic/preview.html` is a full recreation of the Mosaic left-panel + viewport
  screen, built from the components below, matching the real app's layout. Treat it as the
  layout/behavior spec for that screen, not as shippable markup.
- CSS custom properties in `tokens/*.css` are the canonical design tokens — port these into
  whatever the codebase uses for global styles/theme (CSS vars are portable as-is if the
  codebase serves plain CSS).

## Fidelity

**High-fidelity.** Every component here has a direct counterpart already in the real
makegood-tmt-mosaic source (`index.html`) — colors, spacing, type, and states were lifted
from its inline `<style>` block and DOM, not invented. Recreate pixel-perfectly.

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
- No gradients except one conic-gradient app mark in the header.

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
- 1px hairline borders everywhere (`--border-default`), no shadows.
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

Each component in `components/<category>/` ships three files — use all three:

- `Name.jsx` — reference implementation (props, markup, inline styles using the CSS vars above)
- `Name.d.ts` — prop types/contract
- `Name.prompt.md` — written spec (purpose, states, usage notes) — read this first per component

Categories:

- **forms/** — Button, TextInput, Select, ThumbnailSelect, Checkbox, Slider, SegmentedControl
- **layout/** — Panel (repeating uppercase-label + hairline-rule sidebar section shell — not a
  bordered card)
- **feedback/** — WarningPill, Badge, LoadingOverlay
- **misc/** — Dropzone, ColorRow

`*.card.html` files per category are visual specimen sheets (all states/variants side by side)
— open in a browser to see every state without wiring up the real app.

## Screens

### Mosaic — main tool screen (`ui_kits/mosaic/preview.html`)

- **Purpose**: load an SVG, configure a base part (disc/rect/round rect/STL ref/assembly),
  fit and merge detected colors into recess depths, export an STL set.
- **Layout**: CSS grid, `340px 1fr` columns × `64px 1fr` rows. Header spans both columns.
  Left sidebar (`#left`) is `var(--surface-panel)`, scrollable, 14px padding, holds six
  stacked `Panel` sections in order: Artwork, Base part, Artwork fit, Depth, Colors detected,
  Export. Right side (`#right`) is the 3D viewport — `var(--surface-viewport)` with a faint
  24px grid background, a HUD readout (top-left, monospace), a warning pill (bottom, full
  width), and a loading overlay (covers viewport when busy).
- **Header**: MakeGood logo (34px tall) + divider + "Mosaic" wordmark (Outfit, 18px/600) +
  subtitle ("for MakeGood TMT · SVG → multicolor recess geometry") + two right-aligned Badges
  (triangle count, color count — amber tone for the color count).
- **Panel: Artwork** — Dropzone + "Load sample artwork" button (small, full width) + hint text
  about flat-color-only support.
- **Panel: Base part** — SegmentedControl (Disc/Rect/Round rect/STL ref/Assembly). Disc shows
  Diameter/Thickness number inputs (mm). Assembly shows a hint line + two ThumbnailSelect
  dropdowns (Top, Cap) each with a 3D-thumbnail placeholder + STL filename meta + a
  "+ Add rotated copy of Top" button.
- **Panel: Artwork fit** — Margin and Scale sliders with live `%` value labels + "Reset to
  auto-fit" button.
- **Panel: Depth** — Default depth number input (mm) + "Recess bg too" checkbox.
- **Panel: Colors detected** — conditional "Merge selected into one recess" button (only shown
  when ≥1 color row is checked) + stacked ColorRow list (swatch, hex, area %, per-row depth
  input) + hint text.
- **Panel: Export** — primary full-width "Export STL set (.zip)" button (triggers the loading
  overlay for ~900ms in the mockup) + hint text.

## Interactions

- Dropzone: drag-over toggles a teal border/text/background state; drop calls `onFiles`.
- ThumbnailSelect: click toggles an absolutely-positioned dropdown list (max-height 220px,
  scrollable); each option shows a thumbnail + label + meta; selecting closes the dropdown.
  Rows highlight with the teal wash on hover.
  a
- SegmentedControl: single-select row of equal-width buttons; active segment gets a teal
  border + teal wash background + teal text.
- ColorRow: optional checkbox (bulk-select for merging) + swatch + hex (mono) + area% + a
  depth number input.
- Buttons/inputs: see hover/focus/disabled states under Design tokens → States above.
- Loading overlay: full-viewport dim (rgba(13,15,17,.85)) + spinner (0.8s linear rotate) +
  label text; blocks interaction with the viewport while visible.

## Iconography & imagery

None. No icon font or SVG icon set — text labels and a single conic-gradient swatch serve as
the mark. Don't introduce an icon library without checking with the team first. If a future
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
- `components/` — per-component `.jsx` + `.d.ts` + `.prompt.md`, plus `*.card.html` specimens
- `ui_kits/mosaic/preview.html` — full screen recreation (open directly in a browser)
- `assets/makegood-logo.png` — logo asset
- `guidelines/` — foundation specimen pages (color, type, spacing/radius, brand mark) for
  quick visual reference

## Not in scope

Two further, distinct visual languages were referenced but not built out: a cooler
Tailwind/shadcn "ocean-blue" forum app (3d-mobility.org) and a warm rainbow-gradient nonprofit
marketing site (makegood.design). Their token files are in `tokens/colors-3dmobility.css` and
`tokens/colors-makegood.css` for reference only — do not use them for the Mosaic tool itself.
