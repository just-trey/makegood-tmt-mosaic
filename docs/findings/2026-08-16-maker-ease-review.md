# Maker ease-of-use review: driven first-timer walkthrough

Four new defects found, three known items confirmed with new evidence. The
sharpest: a decorative `<circle>` in user artwork silently hijacks wheel
placement, and colors clipped off a face still cost AMS slots in the export.

- Run: 2026-08-16, commit e0ed92c, production build, WSL2, RTX 2060 via
  ANGLE d3d12, `MOSAIC_GPU=1`.
- Method: drove the app as a first-time volunteer (wheel, raster, chair),
  dumping every user-visible string, screenshotting each step, then opened
  the exported 3MFs. Test SVG: 7 colors, four of them `<circle>` elements.
- Graded against [audience.md](../audience.md). Cross-referenced against
  [tech-debt.md](../tech-debt.md) and [roadmap.md](../roadmap.md).

## New: the largest `<circle>` in artwork silently becomes the wheel's design boundary

`designAnchor` ([src/geometry/assembly.ts](../../src/geometry/assembly.ts))
anchors wheel-fit artwork on the SVG's largest `<circle>`, assuming it is the
template's boundary marker. On artwork not drawn over a template, any
decorative circle wins.

- Repro: 7-color SVG, viewBox 0 0 100 100, four r=18 circles at the
  corners, rect + path shapes between them.
- Observed: the first circle (a red dot at 30,30) was scaled to the full
  276mm face and centered on the hub. The rect and path shapes kept their
  positions relative to it. The three other circles landed ~300mm off the
  face and vanished.
- Control: the same shapes as `<path>` arcs load correctly, all 7 colors
  present, sane auto-fit.
- The warning is inverted. The no-circle case, which behaves well
  (bbox auto-center), warns. The hijack case says nothing.
- The parser comment ([src/svg/parse.ts:220](../../src/svg/parse.ts#L220))
  already notes boundary markers are commonly `fill="none"`. A filled circle
  is artwork; that discriminator is in reach and unused.
- Why it matters for this audience: kid-oriented clipart is full of circles
  (suns, balloons, eyes, polka dots). Failure is silent and looks bizarre.
- Null result: declaring `width="100mm" height="100mm"` changes nothing.
  Unit handling is not involved.

## New: colors clipped off the face are phantoms with three disagreeing counters

Colors whose regions fall entirely off the design face disappear from the
color list but keep costing slots everywhere else.

| Surface                        | Says (same screen, same state) |
| ------------------------------ | ------------------------------ |
| Header chip                    | 4 colors                       |
| Colors detected list           | 4 rows                         |
| Slot line                      | 7 colors → 7 AMS slots needed  |
| AMS capacity pill              | 7 AMS slots needed             |
| Exported 3MF `filament_colour` | 7 entries                      |
| Extruders actually referenced  | 5                              |

- At Scale 400% the face is one color, the chip says "1 colors", the slot
  line still says 7. No warning names the colors that fell off.
- The exported wheel project asks the user to load 7 filaments. Two print
  nothing (verified in `Metadata/model_settings.config`).
- The chair's zone-coverage warning proves the app can say "artwork didn't
  reach X". The flat face has no equivalent.

## New: the camera never looks at what you just did (chair)

- A design loaded on the chair binds to "Left side", which faces away from
  the default camera. First sight of your artwork is an edge-on sliver.
- Switching the zone to "Back" rebuilds for ~3s and shows an unchanged grey
  chair. The artwork is on the far side.
- The coverage pill names the zone, but nothing shows it. A first-timer who
  hasn't discovered orbit cannot tell whether anything worked.
- Cheapest fix is a camera turn to the bound zone on bind. The roadmap's
  surface-first picking is the fuller answer; this doesn't need to wait
  for it.

## New: the bundled sample immediately overflows a single AMS unit

"Load sample artwork" is 4 colors + body = 5 slots. On the default printer
the info pill fires at once: "5 AMS slots needed — more than the 4 in a
single AMS unit". The app's own demo tells a first-timer their AMS can't do
it. A 3-color sample (or one color pre-grouped into base) demos clean.

## Known items, new evidence

- **Auto-merge does nothing on real-shaped input**
  ([tech-debt](../tech-debt.md), "Auto-merge is a similarity control").
  Sweep on the 7-color file: None 8, Slight 7, Medium 7, Strong 7 slots.
  Second data point matching the measured volunteer SVG.
- **Export is a blind leap** ([tech-debt](../tech-debt.md), "The export
  button doesn't say what it's about to produce"). Chair export: 0.8s,
  34.0 MB, 11 plates, zero on-screen change (left-panel text byte-identical
  before and after). The post-export coverage warning is the only feedback.
- **No cancel on the rebuild overlay** ([tech-debt](../tech-debt.md), "The
  long assembly-mode rebuild has no cancel"). Overlay DOM captured
  mid-rebuild: spinner + "Rebuilding geometry…", no controls.

## What measured well

Recorded so nobody re-derives the negative.

- Raster path: mario.png to a clean 6-color, 66-region trace placed on the
  wheel in 2.3s. This is the app's best moment and it is genuinely better
  than the Mesh Graffiti comparison for this use.
- Cold load 1.7s; chair fully loaded 4.7s; chair zone rebuild ~3s; wheel
  export 0.3s (all GPU path).
- Warning copy is plain and specific throughout the run. "4 surfaces will
  print body-colored with no design" is exactly right. "Dismiss all (2)"
  works.
- Zone dropdown + "+zone" + "All zones" were understandable cold; the
  coverage pill teaches the model.

## Wrong turns

- The skewed white line across the wheel in the first screenshot read as
  the tech-debt gizmo-angle bug. It was the placement frame correctly
  enclosing the hijacked anchor. The conventions 13-14 item is untouched by
  this run: neither confirmed nor cleared.
- Circles were first suspected as a primitive parsing bug. The sample badge
  disproved that: its circles are centered, so the anchor heuristic is
  invisible on it.

## Promotion candidates

Findings are recorded here, not promoted; adjudication is the owner's call.

- The circle-anchor hijack and the phantom-slot counters belong in
  [tech-debt.md](../tech-debt.md) as defects if confirmed worth fixing.
- The camera-turn-on-bind idea belongs in [roadmap.md](../roadmap.md)
  beside surface-first picking if not done directly.
- The sample-artwork slot count is a one-line change and could skip the
  list entirely.
