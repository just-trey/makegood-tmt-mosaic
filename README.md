# TMT Mosaic — Multicolor Color-Inlay Generator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.7.0--beta-orange.svg)](CHANGELOG.md)

A browser app that turns flat-color SVG artwork — or a PNG/JPG/WebP image — into
per-color recess geometry for multicolor/AMS 3D printing, and exports a
print-ready project 3MF. Parts are placed on build plates, and every recess is
named and assigned its own Generic PETG filament slot with the detected colors,
with 15% gyroid infill and tree (auto) support pre-set. It opens ready to slice
in **Bambu Studio, OrcaSlicer, or Snapmaker Orca** (pick Bambu X1C/P1S/A1/H2D or
Snapmaker U1 in the export panel). It covers four TMT parts: the wheel, the
hubcap, the footrest, and the chair body.

Built for [MakeGood](https://makegood.design)'s Toddler Mobility Trainer
(TMT) — a free, open-source 3D-printable mobility device for children ages
1–8, distributed via [3d-mobility.org](https://3d-mobility.org).

This project is in **beta** (pre-1.0, see [Versioning](CONTRIBUTING.md#versioning)):
exported file formats and supported inputs may change between minor releases.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
PR guidelines, and the versioning policy. This project follows a
[Code of Conduct](CODE_OF_CONDUCT.md). Released under the [MIT License](LICENSE).

## Running it

```bash
npm install
npm run dev           # dev server with hot reload
npm test              # unit tests (Vitest)
npm run test:coverage # the same tests + coverage floors — what CI gates on
npm run typecheck     # TypeScript, no emit
npm run build         # typecheck + production build to dist/
npm run preview       # serve the production build locally
npm run smoke         # builds, then drives the real app end-to-end
```

The full pre-PR checklist is in
[CONTRIBUTING.md](CONTRIBUTING.md#development-setup).

Everything runs client-side: no backend, no data leaves the browser. All
dependencies (three.js, Turf, JSZip, the Manifold WASM engine) are bundled, so
the deployed app has no runtime CDN dependencies. The Google Fonts stylesheet is
the only external request.

The app opens on the wheel. `?kind=footrest`, `?kind=hubcap` or
`?kind=chair-body` opens another part, so a link can point at the part being
discussed and a script can skip building one it doesn't want. An unknown or
absent value opens the wheel.

## Deployment

Pushing a version tag (`vX.Y.Z`) builds and deploys `dist/` to **GitHub
Pages** via [.github/workflows/deploy.yml](.github/workflows/deploy.yml) — see
[CONTRIBUTING.md](CONTRIBUTING.md#versioning). Merging to `main` doesn't deploy;
a manual `workflow_dispatch` run does an out-of-band deploy. One-time setup:
repo **Settings → Pages → Source → GitHub Actions**.

**Analytics (optional).** The Umami script is injected at build time only when
`UMAMI_WEBSITE_ID` is set — a repo **Variable** (Settings → Secrets and
variables → Actions → Variables) for the deploy, a local `.env.local` for local
builds (see [.env.example](.env.example)). Unset, as in any fork, nothing is
injected and nothing reports to your account. Beyond pageviews, a few cookieless
events track feature usage (artwork loaded, mode switched, export completed);
no file names, contents, or other personal data are sent. Catalog:
[docs/analytics.md](docs/analytics.md).

**Feedback widget (optional).** The in-app Feedback button posts to Formspree
and appears only when `FEEDBACK_ENDPOINT` is set at build time — a repo
**Variable** for the deploy, a local `.env.local` for local builds (see
[.env.example](.env.example)). Unset, as in any fork, no button appears, so a
fork never posts to our inbox.

## How it works

1. **Read the artwork.** An SVG is parsed as vectors — shapes grouped by fill
   color, curves flattened adaptively. A PNG or JPG is quantized into flat color
   regions and traced back to vectors, with smoothing and speckle removal
   auto-tuned to the image's detail. Everything below is identical for either.
2. **Resolve each color's net visible region**, paint order and holes included
   (2D polygon booleans via Turf.js), then merge visually similar colors into
   recess slots.
3. **Place** the artwork on the part: fit sliders, or drag it on the 3D model
   with a selection frame.
4. **Cut**: each region is extruded into a prism and booleaned into the part
   mesh with [Manifold](https://github.com/elalish/manifold) (WASM CSG). A part
   with baked design zones wraps artwork **conformally** onto a UV chart per
   zone, split across printed part seams as needed.
5. **Export** a Bambu Studio project 3MF: named parts, per-part filament slots,
   multi-plate placement, resolved for the selected printer. Placement for parts
   with a verified real-world pose is baked from a hand-checked reference file,
   never computed at runtime.

Walkthrough, code layout, and how to add a part:
**[docs/pipeline.md](docs/pipeline.md)**.

## Known limitations

Detail on any of these: [docs/pipeline.md](docs/pipeline.md) and
[docs/tech-debt.md](docs/tech-debt.md).

- Flat, roughly horizontal faces only, unless the part ships baked design zones.
- A design crossing a printed join lines up only as well as the print does.
- A design bound to one zone can't flow across its boundary. Three ways of
  making it continuous were prototyped and measured as dead ends
  ([docs/pipeline.md](docs/pipeline.md)). Mirror doesn't cross it either: it
  cuts a reflected copy on the zone's twin, or across the zone's own centre line.
- On the chair, a design bound to **Whole chair** crosses two boundaries
  (left/back, back/right), but only over part of each.
  - The sheets abut along the whole boundary. The surface under them meets only
    over the stretch the registration was fitted through.
  - Measured by `npx vite-node scripts/bake-zones.mjs scripts/zone-configs/chair-body.json`
    (`net:` lines): left/back joins over 61 of 197 rows, right/back over 8 of 99.
  - Elsewhere the sheets sit side by side. A design drawn across there prints in
    two pieces 33.6mm apart at the median (164.4mm on right/back), and the build
    warns, naming both zones and the distance.
  - The whole-part sheet draws a real join dashed and everything else solid; its
    other sheets sit apart with a visible gap. A point on it cuts in exactly one
    place: where two sheets overlap, the seam decides, and the sheet hatches the
    part each gives up. The 3D view does too while a **Whole chair** row is active.
- Large wrapped surfaces stretch the artwork. On the chair: Right side 1.23x,
  Left side 1.22x, Back 1.13x, Front 1.11x, seat sides 1.08x, fenders 1.02x. The
  bake prints these; they are in `public/stl/chair-body-zones.json`.
- **Fill isn't offered on the chair body.** One zone took 93.6s to settle, "All
  zones" didn't finish inside 900s, and it dropped a color on one part. Sticker
  works normally. See [docs/tech-debt.md](docs/tech-debt.md).
- Three of the chair's thirteen pieces can't carry artwork, because no design
  zone reaches them: the two caster mounts, and Seat center, which the cushion
  covers whole.
- The chair's prime-tower positions are verified on 270mm and 256mm beds only
  (Snapmaker and Bambu A1). Any other bed inherits the 270mm positions untested:
  check the tower in your slicer. See [docs/tech-debt.md](docs/tech-debt.md).
- "Largest flat patch" auto-face-detection is a heuristic; pick another face in
  the Advanced per-part controls.
- A part that isn't a watertight mesh can't be cut. It exports uncut, with a
  warning.
- On a sideways face picked by hand, nothing bounds a depth: a pocket deeper
  than the wall cuts a hole clean through. Every default face and every chair
  zone cut a too-deep pocket at the wall under it instead, with a warning
  naming the color and the part. A zero or negative depth is caught up front and
  raised to a safe minimum. See [docs/tech-debt.md](docs/tech-debt.md).
- Fill can't repeat a very detailed design. Past 600k points across the copies
  the design is placed once, with a warning: the cut ran out of memory at 720k on
  the one part measured. Raising Scale fixes it where a bigger tile gets under
  the budget; the warning says when it can't.
- Gradients/patterns in an SVG are detected and skipped with a warning.
- A raster is processed at 1024px on its long edge for flat art (logos,
  drawings, cartoons) and 512px for photographs, chosen from the image itself.
  That caps how much _detail_ a trace picks out, not edge quality: outlines are
  fitted as curves between pixels, so they stay smooth at any print size.
- A traced image's colors come from the image, not your filament list; use the
  Colors slider and Auto-merge to get down to the slots you own.
- Detail too fine to print isn't cut, and the app names the color and part. On a
  very busy image, specks are merged into their surroundings rather than traced,
  and a warning says so.
- Two designs placed over each other are warned about by name, not resolved:
  their recesses still both get cut. A Fill under a sticker is the exception:
  the fill is cut back from under it.
- The hubcap's plate is verified up to 220mm on 256mm and 270mm beds only.
  - Within that it exports at a hand-checked position, prime tower clear of it
    (7mm clearance on a 256mm bed, 19mm on a 270mm one).
  - Larger than 220mm, or on any other bed, nothing was verified: it exports
    centred, with the prime tower in the freest corner. Where every corner
    overlaps a part, the app says so. Where that holds for every plate printing a
    tower, it saves no position and the slicer places it. Check both in your
    slicer.
  - The part is generated, so this can't be a fingerprint-sealed pose like the
    fixed parts: it's an arrangement verified at one size, which is why it stops
    applying above it.
  - **Cut to artwork shape** always uses the computed centred placement: the
    verified arrangement was checked with a round disc, and a silhouette can reach
    further off-axis than a circle of the same nominal size.
- On a hubcap **cut to artwork shape**, colors reaching the outline are always
  cut the disc's full 3mm so the rim prints in them. There is no way to opt one
  back to a recess short of scaling the artwork clear of the edge; the app names
  the colors it did this to. This covers the **outside** edge only: if your
  silhouette encloses a hole (a letter "O", a doughnut), the rim around that
  hole still prints in the base color. See [docs/tech-debt.md](docs/tech-debt.md)
  and [docs/troubleshooting.md](docs/troubleshooting.md).
- Parts the reference sets to manual tree support arrive without the painted
  enforcers; paint them yourself or switch to auto support.
- Session autosave/restore covers SVG artwork, loaded images, placement, colors,
  depth, part, and printer. An image is saved as its re-encoded working copy, so
  restoring re-traces it (a moment on a photograph). If your browser refuses to
  encode it, that image is left out and you are asked before leaving the page.
- Desktop/laptop screens only, by design: one fixed-width left column, no
  responsive breakpoint. Verified usable from 900px up (1920 down to 900 driven
  and screenshotted). Below that, a plain message asks for a wider window.

## Design system

The visual language is the TMT Mosaic design system: dark navy/blue,
sharp-cornered, WCAG AA contrast. Tokens live in
[design-system/tokens/](design-system/tokens/) (the spec) and are mirrored in
[src/styles.css](src/styles.css) (the shipped copy) — update both when tokens
change. The rest of [design-system/](design-system/) is **reference only**
(specimen pages, component prompt specs); the app imports none of it. The two
other brand themes in the tokens folder (3d-mobility.org, makegood.design
marketing) aren't used by this tool.

## Docs

- [docs/pipeline.md](docs/pipeline.md) — how it works, code layout, adding a part.
- [docs/tech-debt.md](docs/tech-debt.md) — deferred work, known-wrong behavior,
  measurements worth not re-taking.
- [docs/troubleshooting.md](docs/troubleshooting.md) — one section per warning string, such as "Couldn't merge the shapes": what it means and how to fix it.
- [docs/roadmap.md](docs/roadmap.md) — ideas not yet built.
- [docs/analytics.md](docs/analytics.md) — the event catalog.
- [CHANGELOG.md](CHANGELOG.md) — what changed per release.
