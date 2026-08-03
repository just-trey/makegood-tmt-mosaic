# TMT Mosaic — SVG Color-Inlay Generator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.6.0--beta-orange.svg)](CHANGELOG.md)

A browser app that turns a flat-color SVG into per-color recess geometry for
multicolor/AMS 3D printing, and exports a print-ready project 3MF — parts
placed on build plates, every recess pre-named and pre-assigned to its own
Generic PETG filament slot with the detected colors, 15% gyroid infill and
tree (auto) support pre-set, so it opens ready to slice in **Bambu Studio,
OrcaSlicer, or Snapmaker Orca** (pick your printer from the export panel —
Bambu X1C/P1S/A1/H2D or Snapmaker U1). A per-color STL set is available as a
fallback for other slicers.

Built for [MakeGood](https://makegood.design)'s Toddler Mobility Trainer
(TMT) — a free, open-source 3D-printable mobility device for children ages
1–8, distributed via [3d-mobility.org](https://3d-mobility.org).

This project is in **beta** (pre-1.0, see [Versioning](CONTRIBUTING.md#versioning))
— exported file formats and supported inputs may still change between minor
releases.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
PR guidelines, and the versioning policy. This project follows a
[Code of Conduct](CODE_OF_CONDUCT.md). Released under the [MIT License](LICENSE).

## Running it

Development:

```bash
npm install
npm run dev      # dev server with hot reload
```

Other scripts:

```bash
npm test             # unit tests (Vitest)
npm run typecheck    # TypeScript, no emit
npm run build        # typecheck + production build to dist/
npm run preview      # serve the production build locally
npm run smoke        # builds, then drives the real app end-to-end
```

The full pre-PR checklist is in
[CONTRIBUTING.md](CONTRIBUTING.md#development-setup).

Everything runs client-side — no backend, no data leaves the browser. All
dependencies (three.js, Turf, JSZip, the Manifold WASM engine) are bundled at
build time, so the deployed app has no runtime CDN dependencies. The Google
Fonts stylesheet is the only external request.

The app opens on the wheel. `?kind=` opens it on a given assembly kind instead
— `?kind=chair-body`, `?kind=footrest` — so a link can point at the part being
discussed, and a script driving the app can skip building a part it doesn't
want. An unknown or absent value opens the wheel, as before.

## Deployment

Pushing a version tag (`vX.Y.Z`) builds and deploys `dist/` to **GitHub
Pages** via [.github/workflows/deploy.yml](.github/workflows/deploy.yml) — see
[CONTRIBUTING.md](CONTRIBUTING.md#versioning). Merging to `main` does not
deploy by itself; a manual `workflow_dispatch` run is also available for an
out-of-band deploy. One-time setup: repo **Settings → Pages → Source → GitHub
Actions**.

**Analytics (optional).** The Umami analytics script is injected at build
time only when `UMAMI_WEBSITE_ID` is set — as a repo **Variable**
(Settings → Secrets and variables → Actions → Variables) for the deploy, and in
a local `.env.local` for local builds (see [.env.example](.env.example)).
Unset — as in any fork — and no script is injected, so forks never report to
your account. Beyond pageviews, a few cookieless custom events track feature
usage (artwork loaded, mode switched, export completed) — no file names, file
contents, or other personal data are ever sent. See
[docs/analytics.md](docs/analytics.md) for the full event catalog.

## How it works

1. **Parse** the SVG as vectors, not pixels — shapes grouped by fill color,
   curves flattened adaptively.
2. **Resolve each color's net visible region**, paint order and holes taken
   into account (2D polygon booleans via Turf.js), then merge visually
   similar colors into recess slots.
3. **Place** the artwork on the part — fit sliders, or drag it directly on the
   3D model with a selection frame.
4. **Cut**: flat-plate mode stacks flat slabs (pure 2D, no CSG); assembly mode
   extrudes each region into a prism and booleans it into the part mesh with
   [Manifold](https://github.com/elalish/manifold) (WASM CSG). Parts with more
   than one design surface (**design zones**, e.g. the chair body) wrap
   artwork **conformally** onto a baked UV chart per zone, split across
   printed part seams as needed.
5. **Export** a Bambu Studio project 3MF — named parts, per-part filament
   slots, multi-plate placement — resolved for the selected printer. Placement
   for parts with a verified real-world pose is baked from a hand-checked
   reference file, never computed at runtime.

Full walkthrough, code layout, and how to add a new assembly/library part:
**[docs/pipeline.md](docs/pipeline.md)**.

## Known limitations

- Flat, roughly horizontal faces only, unless the part ships baked design
  zones — see [docs/pipeline.md](docs/pipeline.md).
- A design crossing a printed join lines up only as well as the print does.
- A design can't flow across a zone boundary — on the chair it stops where
  "Left side", "Back" and "Right side" meet. Three ways of making it continuous
  were prototyped and measured as dead ends; the numbers are in
  [docs/tech-debt.md](docs/tech-debt.md).
- Large wrapped surfaces stretch the artwork somewhat (the chair's worst spots
  run 1.11–1.28×).
- "Largest flat patch" auto-face-detection is a heuristic; use the Advanced
  per-part controls to pick a different face.
- Input parts must be watertight/manifold for assembly cutting.
- No wall-thickness safety check — pocket depth is user-supplied.
- Gradients/patterns are detected and skipped with a warning.
- Fill (repeat the design across a surface) is assembly-mode only.
- The chair body's prime-tower positions are verified on 270mm and 256mm beds
  only; other bed sizes inherit the 270mm positions untested — see
  [docs/tech-debt.md](docs/tech-debt.md).
- Parts the reference sets to manual tree support arrive without the painted
  enforcers; paint them yourself or switch to auto support.
- The caster mounts can't carry artwork — see
  [docs/tech-debt.md](docs/tech-debt.md).
- Session autosave/restore covers artwork, placement, colors, depth, part,
  and printer — not an uploaded STL reference mesh, which isn't kept.

Full detail on any of these: [docs/pipeline.md](docs/pipeline.md) and
[docs/tech-debt.md](docs/tech-debt.md).

## Troubleshooting

Seeing a "Boolean union/subtraction failed" or "Couldn't build the cut solid"
warning? **[docs/troubleshooting.md](docs/troubleshooting.md)** has one
section per warning string, what it means, and how to fix it.

## Design system

The visual language is the TMT Mosaic design system — dark navy/blue,
sharp-cornered, WCAG AA contrast. Tokens live in
[design-system/tokens/](design-system/tokens/) (the spec) and are mirrored in
[src/styles.css](src/styles.css) (the shipped copy) — update both when tokens
change. Everything else under [design-system/](design-system/) is
**reference only** (specimen pages and React component examples); none of it
is imported by the app. Two other brand themes in the tokens folder
(3d-mobility.org, makegood.design marketing) are not used by this tool.

## Docs

- [docs/pipeline.md](docs/pipeline.md) — the full "how it works" walkthrough,
  code layout, and how to add a new assembly/library part.
- [docs/tech-debt.md](docs/tech-debt.md) — deferred work, known-wrong
  behavior, and measurements worth not re-taking.
- [docs/troubleshooting.md](docs/troubleshooting.md) — one section per
  user-visible warning string.
- [docs/roadmap.md](docs/roadmap.md) — ideas not yet built.
- [docs/analytics.md](docs/analytics.md) — the event catalog.
- [CHANGELOG.md](CHANGELOG.md) — what changed per release.
