# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/just-trey/makegood-tmt-mosaic/releases/tag/v0.1.0
