# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- In-app help panel (the "?" button in the header) walking through each
  left-panel section — Part, Artwork, Fit, Depth, Colors, Export — so new
  users don't need to leave the app to learn the workflow. A pulsing badge
  draws attention to it until it's opened once.

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

[Unreleased]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/just-trey/makegood-tmt-mosaic/releases/tag/v0.1.0
