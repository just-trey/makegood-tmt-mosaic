# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Design templates are now generated from the part meshes
  (`scripts/gen-templates.mjs`) and share one visual language: a `#bcbcbc`
  printable-surface grey and a single blue guide ink for all non-printing
  marks. The footrest template now shows the part's real printable outline
  (not a plain rectangle) with all four mounting slots punched out as real
  gaps in the grey, so an absence of material reads at a glance. The wheel
  template gains a dotted blue ring marking where the center cap lands (a
  reference — that area still prints), and both templates share one guide-label
  size so they read as a matched set.
- Typed number fields (Design radius, shape dimensions, fit values) now wait
  550ms after the last keystroke before rebuilding, up from 350ms, so
  deliberately-typed multi-digit values don't trigger an intermediate rebuild
  mid-entry.

### Added

- Footrest assembly kind: a second selectable part alongside the wheel, with
  a true-to-size (1:1mm) design-face SVG template.
- Footrest export ships with a verified plate pose (centered on any printer's
  build plate), a prime/wipe tower placement that rides along with it, and
  per-part print overrides (support off, no brim) baked from a user-verified
  reference 3MF.
- Exported print-ready 3MF files are now named after the selected part (e.g.
  `mosaic-footrest.3mf`) instead of always `mosaic-wheel.3mf`.

### Fixed

- Artwork for an assembly part (e.g. the footrest) that was exported without an
  absolute mm size — as Affinity does, writing `width="100%"` and rescaling the
  viewBox to its own resolution — now auto-fits to the part face via its viewBox
  instead of landing ~2.8× oversized. A template trace drops in life-size at
  Scale 100% again. SVGs that declare a real mm size are unaffected.
- The "AMS slots needed" counter under Colors detected undercounted by one —
  it left out the body's own filament slot (materials[0], always present in
  both export paths). It now reports cut colors + 1. The "N colors → M AMS
  slots" merge hint also compared detected colors against slots instead of
  against cut colors, so it showed even when no colors were merged; it now
  appears only when merging actually reduced the count.

### Removed

- The Rectangle, Rounded rectangle, and STL-reference options from the part
  picker. The dropdown now lists the real MakeGood TMT parts (Wheel,
  Footrest) plus a single "Disc (reference)" flat-plate insert. The
  flat-shape code paths remain but are no longer offered in the UI.

## [0.4.1] - 2026-07-19

### Changed

- Analytics on the hosted page switched from Cloudflare Web Analytics to
  Umami. Still opt-in and disabled by default: the script is injected at
  build time only when `UMAMI_WEBSITE_ID` is set, so forks build and deploy
  without it. See `.env.example`.

### Fixed

- Wheel assembly's second Top half (the rotated copy, exported onto its own
  build plate) is now named "Bottom" instead of "Top (rotated copy)".

## [0.4.0] - 2026-07-17

### Added

- Auto-merge similar colors: a stepped slider (None/Slight/Medium/Strong) in
  Colors detected collapses visually similar fill colors into shared AMS
  slots, live and fully reversible — drag it back down to pull colors apart
  again, or pull just one color out of a merged group with its "×". Slight
  (dedupe) is on by default.
- Group colors into the base material: the Base is now a slot pinned at the
  top of Colors detected, alongside the cut slots. "→ base" (or dragging a
  color, or a whole merged group, onto the Base row) adds it in; the row
  shows every color it contains and prints as the dominant member's color.
  "×" a base color to send it back to being cut. Previously the only option
  was a generic filament swatch for the body.

### Changed

- Merged color slots now print in the group's dominant (largest-area)
  member's real color instead of an RGB-averaged blend.
- Similar colors are now deduped by default (auto-merge Slight) — this
  changes the detected-color count/output for existing artwork with
  near-identical export/anti-aliasing color artifacts.
- The base can now hold more than one color/merged group at once: dragging a
  color (or merged group) onto the Base row adds it alongside what's already
  there, while the "→ base" button switches the base to that color (releasing
  the previous members back to being cut). Removed the duplicate
  artwork-color swatches from the top base-color area (and the reorder jump
  that came with picking one there) — grouping artwork colors into the base
  is now done from the color list's Base row alone.
- Renamed the Part panel's "Base color" picker to "Body / blank color" and
  reframed it as the physical blank's own fallback color (the body prints it
  whenever no artwork color is grouped into the base). This disambiguates it
  from the Base row in Colors detected, which the two shared name made read
  as the same control in two places.
- The Base row in Colors detected now shows an empty-state line ("Base —
  empty; body uses the blank color set in Part") instead of disappearing
  when nothing's grouped in, so the "no artwork color as body" case reads as
  a normal choice. Its label also dropped "(not cut)" in favor of "prints as
  the body" to avoid overloading the word "cut".
- Removed the per-color checkbox + "Merge selected" button in Colors
  detected — it duplicated drag-to-merge and read as unclear/dead-looking
  next to the newer auto-merge slider and drag-and-drop flow. Manual merges
  are still made by dragging one color onto another.

### Fixed

- The auto-merge slider's None/Slight/Medium/Strong labels didn't line up
  under their thumb stops. They're now anchored to the track's own width
  instead of the full (wider) panel row.
- A merged group with many members (e.g. a long shading ramp collapsed at
  Strong) could push its "→ base" button off the edge of the panel. The
  member swatches now wrap onto their own line below the row's controls
  instead of competing with them for space.
- Area percentages and dominant-member color picks could be wildly wrong on
  complex artwork (e.g. a Base row claiming 740% of the design, or the body
  printing the wrong member's color). Region areas were measured with turf's
  geodesic area function, which treats SVG coordinates as latitude/longitude
  and returns garbage outside real-world ranges — all area comparisons now
  use plain planar (shoelace) area. Flat mode's base share also mixed raw
  SVG units with millimeter units in the same percentage; both sides now use
  the same scale.

### Removed

- The "unmerge" button on merged rows. It only ever affected manual
  drag-merges, so it silently did nothing on the auto-merged groups the
  slider now produces (most of them). Its jobs are covered: drag the
  auto-merge slider down to split slider-made groups, or click a group
  member's "×" to pull colors out one at a time.

## [0.3.1] - 2026-07-16

### Fixed

- GPU memory no longer grows while adjusting sliders. Rebuilding the model
  now disposes the previous build's geometry and materials instead of
  leaking them.
- Assembly color regions now clip to the part face more reliably. Clipping a
  color region to a part's boundary used to give up and leave the region
  unclipped after a single failed attempt on degenerate geometry, instead of
  being retried the way the other boolean operations already were.

### Changed

- Geometry rebuilds no longer freeze the tab on dense artwork. The polygon
  boolean pass (the bulk of a rebuild) now runs cooperatively — yielding to the
  browser as it works — so the UI stays responsive instead of triggering the
  "Page Unresponsive" dialog, and the "Rebuilding…" curtain shows a live
  percentage (with a "hang tight" note once it's been a while) instead of a
  frozen line.
- Dense-artwork rebuilds are also faster: the flat-plate background and
  base-slab region unions now merge via balanced pairs instead of one long
  accumulation (~3x faster on that phase, ~18% off the whole rebuild on a
  135-path test SVG).
- SVG curves are now flattened to an adaptive deviation tolerance instead of a
  fixed 18-segment count per Bezier — gentle curves emit only as many points
  as they need. ~77% fewer polyline points on the 135-path test SVG, with
  worst-case deviation from the true curve measured at ~0.002 SVG units
  (well under the fidelity that mattered before), which speeds up every
  downstream step that scales with vertex count.
- Assembly-mode rebuilds no longer freeze the tab either: the per-part
  cutting pass (the bulk of an assembly rebuild) now yields to the browser
  as it works, the same way the flat-mode boolean pass already did, and the
  "Rebuilding…" curtain shows a live percentage through the whole rebuild
  instead of jumping to 100% and then hanging until the cut finishes.
- Depth/fit/color tweaks no longer recompute the artwork's per-color regions
  — the polygon boolean pass (the dominant cost of a rebuild) is now skipped
  when the change didn't touch the parsed artwork itself, so large SVGs
  respond much faster to slider drags.

## [0.3.0] - 2026-07-16

### Added

- Snapmaker U1 (270 × 270 build plate) as a print-ready 3MF export target,
  alongside the existing Bambu Lab printers. The exported project settings
  resolve directly in Snapmaker Orca, Bambu Studio, and OrcaSlicer.
- In-app help panel (the "?" button in the header) walking through each
  left-panel section — Part, Artwork, Fit, Depth, Colors, Export — so new
  users don't need to leave the app to learn the workflow. A pulsing badge
  draws attention to it until it's opened once.
- Print-ready 3MF exports now name each build plate (e.g. "Top + Cap") in the
  plate list/preview instead of leaving it blank.
- Wheel assembly exports now pin the prime/wipe tower's plate position too,
  as a fixed offset from the wheel Top half — reused on every plate a Top
  half lands on and on every supported printer — instead of leaving it to
  each slicer's own default placement.

### Changed

- Print-ready 3MF exports now default to Generic PETG filament (was PLA) and
  embed 15% gyroid sparse infill with tree (auto) support enabled, layered on
  top of the target printer's standard process profile. These are now marked
  as explicit per-project overrides, so they survive a reload/resave in Bambu
  Studio, OrcaSlicer, and Snapmaker Orca instead of silently reverting to the
  named preset's own defaults.
- Wheel assembly exports now use a fixed, externally-verified layout instead
  of a computed one: the half-wheel's rotation and the cap's position
  relative to it are constants taken from a real, tested MakeGood TMT export,
  reused unchanged across every supported printer and identically on the
  rotated-duplicate half's own plate. Also fixed the recess/inlay meshes on a
  part (e.g. the cap's color recess) being able to sit below the build plate
  (Z<0) — the plate-flush height now accounts for every sub-mesh of a part,
  not just its uncut body.
- The cap's fixed position relative to the wheel Top was updated to match a
  second externally-verified reference export (a real print-tested layout,
  tuned in Snapmaker Orca).
- On a printer with a bigger plate than the wheel layout above was authored
  for (H2D, Snapmaker U1), every plate's wheel-half group (plate 1's top half
  and cap, and each rotated-duplicate half's own plate) is now re-centered as
  a rigid group on the larger plate instead of sitting in the corner the
  reference layout was placed for — each part's position relative to the
  others on its plate is unaffected, and the X1C plate (which the layout
  matches exactly) is unchanged.

### Removed

- Bambu Lab A1 mini (180 × 180) as an export target — the build plate is too
  small for these parts.

### Fixed

- Cloudflare Web Analytics beacon was silently broken since it was added: the
  injected `data-cf-beacon` attribute had its embedded quotes backslash-escaped
  instead of HTML-entity-escaped, so browsers truncated the attribute at the
  first literal quote and the beacon script never received a token.

## [0.2.1] - 2026-07-15

### Fixed

- SVGs that declare fill colors via CSS classes in a `<style>` block (the
  common Illustrator/Inkscape "presentation attributes → CSS" export shape,
  e.g. `<path class="cls-1"/>` with `.cls-1 { fill: #… }` in `<defs>`) loaded
  as a single solid-black shape instead of their real colors, since the parser
  only read inline `style` attributes and `fill` presentation attributes.
  Class-based fills are now resolved.
- Assembly cutting could silently drop a color's recess on some parts —
  clipping dense/detailed line-work to a part's face boundary can leave the
  region touching itself in a way Manifold's boolean engine rejects as
  non-watertight, even though the shape is otherwise valid. Failed regions are
  now automatically repaired (via Manifold's own 2D boolean engine) and
  retried before falling back to a warning.
- Typing a multi-digit value into a numeric field (scale, margin, depth,
  dimensions) no longer kicked off a rebuild on the first digit and stacked a
  second one behind it — number fields now debounce until you stop typing,
  and the "Rebuilding…" overlay no longer flashes on every keystroke.
  Dragging a slider on a complex/heavy model no longer stutters either: it
  now rebuilds once on release instead of flooding redraws mid-drag, while
  cheap models keep live preview during the drag.
- On a heavy model, changing a value used to make the viewport appear to
  freeze with no indication anything was happening until the redraw finished.
  The "Rebuilding…" overlay now reliably shows during the freeze (it's given
  a paint frame before the geometry work blocks the main thread), and heavy
  rebuilds are recognized up front so even the first one shows it — while
  light rebuilds still update instantly with no overlay.

### Changed

- The "no `<circle>` marking the design boundary" message (shown when an SVG
  has no explicit design-boundary circle and auto-centering is used instead)
  is now a quieter info note instead of an error-styled warning pill — it's
  expected for most artwork, not a sign something broke.

## [0.2.0] - 2026-07-15

### Fixed

- Print-ready export was pathologically slow — a real assembly 3MF took ~90s,
  and time scaled with mesh size (large mosaics ran into minutes). JSZip's
  `generateAsync` pumps its worker through nested `setTimeout(0)` calls that
  browsers clamp to a 4ms floor, so multi-megabyte archives crawl. Replaced it
  with a direct synchronous STORE-zip writer (a 3MF is just an uncompressed
  zip); the same assembly export now finishes in ~5s. The STL-set export uses
  the same writer. Assembly 3MF also now emits Manifold's native vertex index
  directly instead of re-welding the triangle soup.
- Fixed the deployed GitHub Pages site failing to load (CSS/JS 404s): a stray
  `vite.config.js` was shadowing `vite.config.ts` — Vite loads `.js` before
  `.ts` — so the production build silently dropped the real config (asset base,
  version token, analytics) and fell back to a root base whose `/assets/…` URLs
  404 under the `/<repo>/` project path. Removed the duplicate and folded its
  preview-server settings into `vite.config.ts`.
- Prevented the app from crashing on startup when the build-time version token
  was unavailable, which was causing the Playwright smoke check to time out.
- Assembly artwork on a +Y-facing design face (e.g. the wheel's default face)
  loaded mirrored left-to-right, so text read backwards. Placement now
  auto-corrects per face so artwork is right-reading by default, viewed from
  that face's front, on any face and in both modes.

### Added

- **Flip H / Flip V** mirror toggles in Artwork fit, layered on top of the
  automatic orientation — for artwork you deliberately want mirrored, or a
  design meant to be read from the back of a face. Reset with "Reset to
  auto-fit".
- Cloudflare Web Analytics on the hosted page (cookieless, no personal data
  collected). The beacon is injected at build time only when `CF_BEACON_TOKEN`
  is set, so forks build and deploy without it. See `.env.example`.

## [0.1.1] - 2026-07-15

### Fixed

- Assembly mode's wheel **Cap** part: the design was clipped to whatever small
  flat patch got auto-detected as its face (~16.35mm radius), leaving an
  uncut collar around the rest of the domed ~18.4mm cap instead of covering
  the whole curved top. The cut now spans the part's full curved surface,
  fixed to a 3mm depth matching the cap's shell thickness above its
  mounting boss so the clamp fit stays intact.

## [0.1.0] - 2026-07-14

Initial public alpha. Baseline feature set as of this release:

### Added

- SVG-to-3MF color-inlay pipeline: parses `<path>`/`<rect>`/`<circle>`/etc.
  geometry directly, groups shapes by fill color, and computes each color's
  net visible region (paint order aware) via 2D polygon booleans.
- **Flat-plate mode**: builds a stack of flat slabs between depth boundaries.
- **Assembly mode**: cuts pockets into real part meshes via Manifold (WASM
  CSG), including support for rotated-copy parts.
- Print-ready Bambu Studio 3MF export — parts placed on build plates, each
  recess pre-named and pre-assigned to its detected color's filament slot.
- Per-color STL export as a fallback for other slicers.
- Automatic boolean-failure recovery: vertex deduplication, degenerate-sliver
  scrubbing, and reduced-precision retries for self-intersecting source paths.

[Unreleased]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/just-trey/makegood-tmt-mosaic/releases/tag/v0.1.0
