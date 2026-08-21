# A floor in nozzle widths under the despeckle floor

**Run**: 2026-08-20, branch `printable-despeckle-floor` against `d98cf76`. WSL2 kernel
6.18.33.2-microsoft-standard-WSL2, Node 24.18.0, Chromium via `scripts/lib/rastercorpus.ts`.

**Reproduce**: `node_modules/.bin/vite-node scripts/bench-raster.ts floor`. The `floor` mode is part
of this change.

**Closes** the despeckle-floor section of `docs/tech-debt.md`, and opens a narrower one for what is
left: the floor is fixed at the moment of the trace.

## The section's own number was wrong

It read: "a 512px image auto-fit to an 80mm face puts the photo-strength floor near 0.6mm, which is
about right". The floor is an area, `despeckleFrac x w x h`, so the side of the square it removes
is `sqrt(despeckleFrac x Wmm x Hmm)` over the design's _placed_ extent, and the working resolution
cancels out. For a square image on an 80mm face that is **0.98mm** at the flat-art fraction and
**3.75mm** at the photographic one, not 0.6mm. Nothing was "about right" by coincidence; the two
constants were never in nozzle territory at all.

What the fraction really means, per part. A square image, which is what makes each row one number:
a design of other proportions lands on the geometric mean of its two placed sides instead.

| face                                | flat floor | photo floor |
| ----------------------------------- | ---------- | ----------- |
| wheel design circle, 276mm          | 3.38mm     | 12.95mm     |
| footrest, 185mm short axis          | 2.27mm     | 8.68mm      |
| 80mm disc at the 5% margin, 72mm    | 0.88mm     | 3.38mm      |
| hubcap face at its minimum, 30.09mm | 0.37mm     | 1.41mm      |

So the fraction is not a printability rule and never was. It is a simplification rule, and a
reasonable one: a design placed small should be simplified in proportion, or a 40mm photo would
come back a blob. What it lacks is a floor under it.

## The rule

`minArea = max(fractional floor, printable floor)`, where the printable floor is one nozzle width
squared in working pixels: `(0.4mm / mmPerPixel)^2`. Assembly kinds only, for the reason below.

- **One nozzle square is the weakest claim available.** A component with less area than that cannot
  hold a single extrusion of any shape, so nothing this removes was going to print. Anything larger
  would be a taste constant, and the fraction already owns taste.
- **The Detail slider does not scale it.** Coarseness is a preference; this is not one. Detail at
  full right quarters the fractional floor, and this is what stops that from asking for detail the
  printer cannot produce.
- `printableFloorPx` returns 0 when the placement is unknown, so a bench sweep and a session saved
  before this existed behave exactly as they did.

## Where it governs

The printable floor takes over below a placed size of `0.4 / sqrt(despeckleFrac x strength)`,
measured as the geometric mean of the design's two placed sides (its short axis, for the square
image these numbers assume). Resolution cancels here too:

| regime       | Detail 0 | Detail 50 | Detail 100 |
| ------------ | -------- | --------- | ---------- |
| flat art     | 16.3mm   | 32.7mm    | 65.3mm     |
| photographic | 4.3mm    | 8.5mm     | 17.1mm     |

Against the shipped placements that means it is inert on the wheel (276mm) and the footrest (185mm)
at their normal sizes, and live on the hubcap at its minimum diameter, on a design scaled well down,
and at high Detail. 21 of 152 rows in the `floor` sweep are governed by it (19 sources x 4
placements x 2 Detail settings).

What it does on those rows, worst first:

| source                | placement    | Detail | components | painted | points       |
| --------------------- | ------------ | ------ | ---------- | ------- | ------------ |
| ui-screenshot         | hubcap min   | 100    | 91 -> 29   | 6 -> 6  | 4546 -> 1198 |
| pattern-dalmatian     | hubcap min   | 100    | 72 -> 17   | 4 -> 2  | 3863 -> 2312 |
| cartoon               | hubcap min   | 100    | 65 -> 21   | 6 -> 5  | 5252 -> 3154 |
| pattern-tiger         | hubcap min   | 100    | 55 -> 14   | 4 -> 4  | 6684 -> 1196 |
| makegood-logo         | hubcap min   | 50     | 50 -> 42   | 3 -> 3  | 2132 -> 1950 |
| gradient-illustration | footrest 25% | 100    | 12 -> 10   | 6 -> 6  | 736 -> 274   |

- **Nothing goes up.** 18 of the 21 lose components and points and the other three are
  bit-identical (the extra floor removed nothing the fraction had not already). That is the whole difference
  from the first attempt at this: run against the pre-`d98cf76` despeckle, a raised floor
  _fragmented_ the cartoon, 226 components to 413. The floor had to be made to work before anything
  could be built on it ([2026-08-20 despeckle floor](2026-08-20-despeckle-floor.md)).
- No row loses everything, and no row's time moves outside the run noise.
- `painted` drops on five of the 21, worst 4 to 2 on `pattern-dalmatian` at the smallest hubcap. Those
  colours were painted only in pieces under a nozzle width at that size, so they were never going to
  reach the plate. It is the change's whole user-visible cost, and it lands on small placements.

**The hubcap face is the disc less its chamfer**, 30.09mm at the minimum diameter, not the 32.09mm
diameter: artwork lands on the flat top, and `memoLargestDesignFace` measures that off the built
mesh. A first draft of the `floor` mode used the diameter, which put mm per pixel 6.6% high and the
printable floor 13% low in area. Conservative direction, and the live check below went through the
real app either way, but every hubcap number here is the corrected one.

## Getting mm per pixel before the trace

The raster stage runs before placement is known, which is what the section was about. It is asked
for now, from the same two rules the build scales a design by rather than a third one restated:

- **Assembly**: `designMmPerUnit`, given the image's own frame. An image anchors on its canvas on
  every kind, wheel included (`designAnchor`), so nothing here needs the traced bbox that does not
  exist yet. `designMmPerUnit` and `canvasAnchor` are narrowed to `Pick<ParsedSVG, ...>` to make
  that visible in the types rather than in a comment.
- **Flat plate modes get no printable floor, deliberately.** A plate fits the design's _drawn
  content_, which does not exist until the trace has run. The obvious stand-in, the bounds of the
  opaque pixels, is wrong in the damaging direction: one stray opaque speck in a corner inflates the
  extent, shrinks mm per pixel and raises the floor over detail that prints. It was built that way
  first and cut; `tech-debt.md` carries it.
- **With several instances**: each is asked separately and the largest answer wins. One trace serves
  them all, so a floor sized for the smallest copy would throw away detail the biggest one prints.
  Separately rather than "the largest scale", because Fill and Sticker do not share a scale rule
  (`designMmPerUnit`'s `forceRect`), and on the wheel they are different formulas: a Fill tile is a
  real-world period, a Sticker fits the Design radius. Sizing a Fill's floor with the Sticker rule
  was a defect in the first draft of this change.

**Session restore gets the number saved rather than re-derived.** Restore re-traces before the
assembly's parts are back, so the design face it would ask for does not exist yet, and the
per-instance scales are still in the session rather than in state. `mmPerPixel` therefore travels in
the saved raster payload beside `edgeDensity`, which travels for the neighbouring reason. A session
saved before this exists has no value and restores exactly as it did.

## The live check

`public/assets/makegood-logo.png` through the real app on a production build, default Colors (6)
and Detail (50), GPU path:

| placement                     | regions |
| ----------------------------- | ------- |
| footrest, 185mm face          | 66      |
| hubcap at its 32.09mm minimum | 54      |

Same file, same sliders, and the floor followed the printed size. The 32mm hubcap's wordmark is
intact in the screenshot; what went was the crumbs around it.

The hubcap's own before and after, taken from the trace at the app's default 6 colours rather than
the corpus entry's 3: **66 to 54**. The footrest reads 66 for the same reason rather than by luck:
before this change the floor had no placement input at all, so both placements traced identically.
The bench prints 50 to 42 for the same hubcap because it runs the source at the 3 colours its
corpus entry names.

A separate run on `red-sox-logo` returned 68 regions on both the footrest and the hubcap at its
default 220mm. That is the inert case, not a control for the table above: `red-sox-logo` is 300px
and is governed at no placement, so the two numbers agreeing says only that an ungoverned source is
left alone.

Two traps this run hit, worth not repeating:

- `afterRebuild` around the hubcap diameter field times out. Setting the diameter goes through
  `applyBuildParam`, and waiting on the rebuild counter for it never resolved; `settle()` after the
  change works. The artwork load after it is a normal `afterRebuild`.
- A source has to be governed for the check to show anything. `red-sox-logo` is 300px, so its
  fractional floor stays over a nozzle width at every placement and the run compared two identical
  numbers. Read the `floor` mode's `D50`/`D100` columns before choosing the file.
