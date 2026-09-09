# TMT Inlay

Turn a flat-color design into a multicolor print of a MakeGood Toddler Mobility Trainer part,
with no CAD. Load an SVG or a picture, drag it onto the wheel, hubcap, footrest or chair
body, export a 3MF, open it in Bambu Studio, OrcaSlicer or Snapmaker Orca, print.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. Then:

```bash
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173). Everything runs in your browser;
nothing you load leaves your computer.

To put it on a web server: `npm run build`, then upload the `dist/` folder anywhere static
files are served.

## Use it

1. **Part.** Pick Wheel, Hubcap, Footrest or Chair body. On the chair, pick the surface. The
   hubcap is built at the diameter you type.
2. **Design.** Drop in an SVG with flat colors, or a PNG/JPG/WebP. A picture gets a Colors
   slider and a Detail slider. **Download design template** gives you the surface at true
   size to draw over.
3. **Fit.** Drag the design on the part. Corners scale it, the green handle rotates it. Or
   use the sliders.
4. **Depth and colors.** One depth for all, or per slot. Auto-merge joins look-alike colors.
   `→ body` prints a color as the part itself. The line under the list counts slots against
   your printer.
5. **Export.** Pick the printer, click Export 3MF. Read the warnings under the button: they
   name anything that was left out, capped, or not checked on a printer.

The Help button in the app covers each panel.

## Checks

```bash
npm test            # unit tests (vitest)
npm run typecheck   # TypeScript
npm run evidence    # builds, then drives the app through EVAL.md in headless Chromium
```

`npm run evidence` needs Chromium for Playwright. It looks for the one Playwright installs
(`npx playwright install chromium`) or the path in `CHROME_PATH`.

## Layout

| Path | What |
| --- | --- |
| `src/design/` | SVG reading, path flattening, polygon booleans, paint-order regions, picture tracing, placement, slot planning |
| `src/geometry/` | 3MF reading, mesh utilities, height sampling, cutter solid, the cut itself, hubcap solid |
| `src/export/` | Printers, plate layout, 3MF writing, the template SVG |
| `src/app/` | State, session save, design sources, part loading, the build orchestrator |
| `src/ui/` | The 3D view with drag handles, the left panel, help |
| `reference/` | Parts, test designs, brand tokens (served as static files) |
| `evidence/` | Output of the last evidence run |

`NOTES.md` has the decisions, assumptions and limits.
