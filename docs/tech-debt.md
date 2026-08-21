# Tech debt

**Open** deferred work and known-wrong behavior. One section per item, each
stating what was measured, why it was deferred, and what closing it would
take. Update the relevant section instead of re-deriving the number from
scratch.

**When an item is fixed, delete its section — don't mark it `FIXED` and leave
it.** The CHANGELOG entry and the commit are the record of the fix. Anything a
future reader still needs — the measurement behind a constant, an approach
that was tried and lost — belongs in a comment next to the code it constrains,
not here: that is where someone changing the line will actually see it. Keep a
closed item only where it is still load-bearing for something open.

**Before deleting, read what the section still owes and move that out first.** A
section can be almost entirely closed and still carry the one thread that isn't
— a follow-up, an unclaimed optimization, a caveat nobody has measured. That
survives as its own section; only the closed part goes. Checking that the diff
removed only the lines you meant to remove is _not_ this check: it confirms the
scope of the edit, not that what left was finished.

## Selection in the panels is still an accent tint, and two of convention 19's neighbours are open

The viewport half is closed. The frame and its handles are `--text`, and every measurement behind
that (the dark/light pair that lost at 1.06:1, and the `--text`-over-light-body case still open at
1.50:1) is on `FRAME_COLOR` in [src/scene/designGizmo.ts](../src/scene/designGizmo.ts), where
someone changing the colour will meet it.

**The fix used one of convention 19's three mechanisms, and the unused one closes two items at
once.** Dimming the unselected surroundings is the only mechanism that doesn't depend on what the
artwork happens to be, and it is what convention 20 below asks for on its own account. Not
attempted: it changes the model's materials in an app whose subject is showing true colour, so
"how much dim, and only while something is selected?" is a decision, not a tweak.

Three places in `src/styles.css` still say "selected" with the accent:

- `.artwork-row.active` — `border-color: var(--accent)` plus `--accent-wash`.
- `.base-swatch.selected` — `outline: 2px solid var(--accent)`, and this is the sharp one: the
  thing being outlined **is a filament swatch**, so a blue ring around a blue filament is exactly
  the collision convention 19 names, in the one list where it matters most.
- `.auto-merge-labels span.active` — `color: var(--accent-2)`.

Not measured; these are read off the stylesheet, not off a screenshot. Closing it means the same
decision applied in a DOM context, where the tools differ from the viewport's (an outline offset,
a weight change, a checkmark) and where the accent may well be fine for a row that carries no
color of its own. Settle the swatch first.

**Two neighbours of the same rule, both still open**, and the second now has a second instance. Convention 20: greyed-back excluded geometry
must not look like geometry printing in grey — untested either way, and the body renders `#b9c0c6`,
which is a grey somebody prints in. Convention 21: a meaning-carrying overlay has to be
distinguishable from artwork by pattern or motion rather than hue alone, and the placement frame's
off-surface warning state is still hue alone (amber `0xe0a33a`, which matches no token). That one
is deliberately as it is: it is a warning rather than a selection, and the comment on it defends
the choice against a desaturated alternative. The sharper version of the point, from a conventions
review of the shipped screenshots: with the resting frame `--text` and the off-surface frame
amber, **the app has two different frame treatments in the same widget**, one on-token and one not.

**Legibility is not the thing to trade against here.** On the one instance already converted (the
part thumbnail, `src/ui/shapeThumb.ts`), the neutral measured _more_ legible than the accent it
replaced: 7.3:1 against 5.3:1, where the accent's farthest shaded surface was 2.9:1, under WCAG's
3:1 non-text minimum. Don't assume the remaining instances cost legibility to fix.

## A filament's name is nowhere on screen, only its hex

Convention 16 asks for swatches carrying their filament name. No surface does it:

| Where                          | Shows                  | Name available?                                            |
| ------------------------------ | ---------------------- | ---------------------------------------------------------- |
| Colors detected rows           | the raw hex, `#1e5fa8` | `title` on nothing; the row has no name at all             |
| Body / blank color swatch grid | colour only            | `title` and `aria-label` only, so hover or a screen reader |
| Export summary, exported 3MF   | the name               | already resolved via `nearestFilamentName`                 |

So the app knows the name everywhere it writes a file and shows it nowhere the user is choosing.
A volunteer matching rows to spools reads hex codes off a screen and colours off a shelf.

This is the surviving half of the section that closed when the slot count went live and slot
numbering was settled against (convention 16's exception, reasoned on the sort in
[src/ui/colorList.ts](../src/ui/colorList.ts)). Deleting it whole was wrong and a review caught it:
the count complaint closed, this one never did.

Closing it: `nearestFilamentName` ([src/state/filaments.ts](../src/state/filaments.ts)) is the same
lookup the export already uses, so this is presentation over a resolved value, not new matching.
The open questions are what to show when a colour is far from anything owned, and whether the hex
stays alongside the name (it is what a user pastes back into Illustrator, so probably yes).

## The body-color help text tells the user to act in a different panel

Convention 4 of [ui-conventions.md](ui-conventions.md), which states that no control's
explanation may reference a control in another panel: if it must, the model is wrong and the
layout should change rather than the copy grow. The live instance: "Body / blank color … To print
an artwork color as the body instead, use '→ base' (or drag it onto the Base row) in Colors
detected further down."

Not measured; carried from the rubric's conflicts table. The copy is a symptom, so the fix is not
a rewrite — closing it means putting base assignment where the body color is chosen, or accepting
that these are one decision presented in two places. Worth settling alongside the swatch-grid item
above, since both are about the same panel.

**The quoted sentence is gone** as of the copy-tightening pass; the hint is now "The body color
used when no artwork color is grouped into the base." That removed the pointer, not the split. The
item stays open, and the live instance is now the layout rather than a sentence to grep for.

## Colors detected needs a paragraph of prose because none of its mechanisms are visible

Convention 5 of [ui-conventions.md](ui-conventions.md): prose in a panel is a symptom, and a panel
needing several sentences to explain what its controls do to each other is describing a
relationship that should be visible instead. This is the rubric's own worked example.

Measured before the copy-tightening pass: the hint ran 96 words and carried six mechanisms.

| Mechanism                                                     | Why copy was carrying it                           |
| ------------------------------------------------------------- | -------------------------------------------------- |
| Drag one row onto another to merge                            | Drag targets are not indicated                     |
| The ⠿ grip marks what is draggable                            | A glyph that has to be named in prose              |
| The "Merge with…" dropdown does the same thing                | Two paths to one result, neither obviously primary |
| A merged group shares one depth                               | Not shown on the group                             |
| A merged group prints in its dominant member's color          | Not shown on the group                             |
| "→ base" replaces the base, dragging onto Base row adds to it | Two gestures, opposite semantics, same target      |

The hint is now two sentences and the detail lives in the help dialog, which is where mechanism
belongs (convention 6). That is the copy fix and it is done. What remains is the reason the copy
existed: closing this means making the affordances legible, in particular the last row — an
asymmetry between two gestures on the same target is not something help text can rescue.

## User-facing strings still use em dashes, which CLAUDE.md bars

CLAUDE.md's code conventions say UI copy follows "the same sentence rules as docs: short, no em
dashes". Counted 2026-08-16 with a comment-stripping tokenizer over `src/**/*.ts` (a grep first
gave 35, which was wrong: it missed literals on lines that also carry a trailing comment, and
block-comment interiors were not the problem): **57 lines carry an em dash inside a string
literal**, plus 2 in the help dialog markup. That 57 is an upper bound on the copy problem, since
it counts every literal rather than only the ones a user reads. Mostly `title=` tooltips in
[src/ui/colorList.ts](../src/ui/colorList.ts), where the dash joins a clause that would read fine
as a second sentence.

Not a defect a user can hit, which is why it is deferred rather than fixed alongside the warning
rewrites that found it: those passes replaced the dash wherever they touched a string, so the
count only falls as copy is otherwise reworked. Closing it is one mechanical pass, and the trap is
convention 36: splitting a clause into a sentence must not add words. Count after, do not eyeball.

## The placement frame's angle is unrelated to the face it acts on, and it shares the viewport with a second affordance

Conventions 13–14 of [ui-conventions.md](ui-conventions.md): a gizmo is aligned to the frame of
the thing it acts on, and only one manipulation affordance is offered at a time. Both are
reported broken — the placement frame renders at an angle with no relation to the part face, and
corner handles compete with an axis handle for the same drag.

Not measured, and the one item in this group where that matters most: an arbitrary gizmo angle is
either a genuine frame bug in the placement math or a rendering choice, and those close very
differently. Establishing which comes before any fix — it touches placement, so treat it as
geometry work rather than UI. The competing-affordances half is separable and is a UI decision.
This is the last of the group that made the viewport not behave like the direct-manipulation
surface it looks like; the other one, "Zone picking has no occlusion test," is closed
(`npm run check:zone-occlusion` re-measures it — by hand, it is not in CI).

**Still unmeasured after the 2026-08-16 run, and that run recorded a way to get it wrong**
([findings report](findings/2026-08-16-maker-ease-review.md)): a skewed frame across the wheel
read as this bug and was not. It was the frame correctly enclosing an anchor the largest-circle
heuristic had hijacked (its own section below). A skewed-looking frame is evidence of the anchor,
not of the angle, until the anchor is ruled out.

## The chair's prime-tower positions have only been verified on one bed size

All of its export placement — plate assignment, rotation, position,
the per-part brim/support/infill overrides, and now the tower — is baked by
[scripts/bake-chair-placement.mjs](../scripts/bake-chair-placement.mjs) into
[src/export/chairPlacement.ts](../src/export/chairPlacement.ts) from two
human-checked files: MakeGood's 12-plate Bambu Studio project for the poses
(the script re-verifies every shipped mesh against it before writing, worst
plate-space disagreement 0.024 mm), and a four-filament export with every
tower dragged into place for the towers. The second one had to exist
separately because the first prints in one or two filaments and never had a
real tower on it.
What's left: both shipped bed sizes have had that pass (270mm Snapmaker,
256mm A1), and the deltas are stored relative to each plate's anchor part so
they follow the part when a bed re-centers the group. Seven of the ten
transferred between the two beds unchanged, which is the evidence the
relative model works; the two wheel-mount plates (1.8mm and 3.9mm) and one
handle plate (1.2mm) did not, and carry a `primeTowerDeltaByPlate` entry for
256x256. **Any third bed size inherits the 270mm numbers untested** — the
350x320 `bambu-h2d` entry in [src/export/printers.ts](../src/export/printers.ts)
is the one that exists today, and the first non-square bed of the three.
Adding a bed means another pass:
`scripts/export-chair-examples.mjs` builds the files, and the bake takes one
`--towers` file per bed and works out for itself which plates disagree.
The caster plates stay on `suggestTowerPos` in
[src/export/threemf.ts](../src/export/threemf.ts), which is correct — they
print one filament and get no tower.
One loose end in the tooling: whether `wipe_tower_x/y` names the tower's
center or its origin corner isn't pinned down, so the export script only
checks that a tower lands on the bed, not that a given footprint clears the
edge. Both reference files put a tower at exactly x = 15 on a 256mm bed,
which a center-based check would wrongly reject.

## The caster mounts have no design zone, and settling that means settling what the "central rear brace" is

They are absent from
[scripts/zone-configs/chair-body.json](../scripts/zone-configs/chair-body.json)'s
part list — the other eleven pieces are all in it — on the chair body plan's
call that "caster mounts and wheel mounts are structural-only". (That plan was
deleted once the chair shipped; it is in git history.) That call was already
revised for half of
it: the wheel mounts now carry `left`, `right`, and `seat`. The casters are
decoratable too (10,395 mm² of flat upward face at y = 120, the same in both
variants), so this is worth revisiting.
What makes it more than adding four lines to the config: that file's `_note`
reserves a volume for "the central rear brace in the CAD assembly ... the app
has no part for it, so a zone must never grow onto it", and the bounds it
quotes (x −90..90, y 92..186, z −663..−455) are exactly the two caster
mounts' combined bounding box (x −89.9..89.9, y 92..185.6, z −662.5..−454.9,
the note's numbers rounded outward). Either the note is describing the
casters — in which case the 1.008 mm gap it protects is the gap _to_ them,
and raising `seamWeldTolMm` past it would grow a neighbouring zone onto them
as intended — or there really is an unshipped brace inside that same volume
and the note stands as written. Resolve that against the CAD assembly before
touching the tolerance, because it is the tolerance the existing seven zones'
measured coverage was tuned against; changing it re-bakes all of them.

## Rebuild performance needs ongoing work — this is a heavy application

A dense 135-path SVG still takes ~13s to rebuild in flat mode, ~9s of
which is the paint-order boolean pass in
[src/geometry/regions.ts](../src/geometry/regions.ts)
(`computeNetRegionsByColor`). The rebuild is already cooperative (yields to
the browser, live progress %) and the flat union phases use balanced tree
merging (~3x faster than the old left-fold), so the tab never freezes —
but the compute floor is still high. Measured leads for a follow-up, best
first: (1) call the `polygon-clipping` engine directly with n-ary
union/difference (one sweep instead of dozens of pairwise ops — but it
bypasses Turf's wrappers, so the safeUnion/safeDiff fallback machinery
needs care); (2) move the boolean pass into a Web Worker (doesn't reduce
compute, makes the wait invisible). Dead end, already measured: bbox
pre-filtered per-shape diffs benchmarked ~2x SLOWER than the accumulator
on real artwork (full-canvas backgrounds overlap everything) — see the
comment on `computeNetRegionsByColor`.

The chair-body/Fill combination is an order of magnitude worse than the
number above, measured on `MOSAIC_GPU=1` production build, 2026-08-02: the
bundled `public/patterns/zebra.svg` in Fill mode on the chair's Left side
alone (one of five zones) took **405.6s** to settle, non-linear progress
(41% at t+15s, 43% at t+60s, 52% at t+180s). The same design set to "All
zones" (all five zones, the conformal-recut cost `state/artwork.ts`'s
zone-binding-default comment already warns about) did not finish inside a
900s timeout. This is the conformal-wrap + per-part CSG path specifically,
not the flat-mode boolean pass measured above — the per-part cut solids and
the cross-part zone triangulation both scale with triangle count, and the
chair's zones carry hundreds of thousands of triangles (see the "1.7 MB raw"
sidecar-size section below). See the next section for the interaction
consequence.

**Partly superseded, 2026-08-03.** Those numbers were taken against a zebra
asset carrying 13.6k vertices per tile, most of which were marching-squares
oversampling rather than shape (see "Turf's tile union has a vertex ceiling"
below). With the thinned asset the same single-zone case measures
**93.6s**, against **468.7s** re-measured on the old one — and it is doing
_more_ work, not less: 2.07M triangles against 853k, because the old asset's
tile union was failing and falling back to unmerged shapes. So a large share
of what was recorded here as "conformal-wrap + per-part CSG is slow" was one
bad asset. The path is still slow enough to want the accumulator or worker
fix above — 93.6s is not interactive — but re-measure before quoting the
405.6s figure as the cost of the pipeline itself. The "All zones" >900s
result has not been re-measured.

**Withheld from users, 2026-08-05.** The chair-body kind now carries
`withholdFill` (`src/types.ts`), so Fill and the pattern strip are not offered
on it and no user can reach the numbers above. This is a gate, not a fix: the
path is unchanged and every measurement here still stands. Clearing the flag
needs the accumulator-or-worker fix and the "Handle (left)" color loss below.
Sticker on the chair is unaffected and was measured at 19.5s for a full
five-zone rebuild on the same box, which is why only Fill was withheld.

**Don't quote that 19.5s without saying at what design size.** It used a design
covering the zones;
[docs/findings/zone-rebuild-cost.md](findings/zone-rebuild-cost.md) reproduces it
at 400% (17.0s) and measures an ordinary auto-fit sticker on all five zones at
4.0s — a 5x spread on the same path. What is paid for is pocket area, not
surfaces touched.

## Cancelling a rebuild waits for the current part, and flat rebuilds cannot be cancelled at all

Measured on the chair, 2026-08-17, `MOSAIC_GPU=1`: a dense 676-circle design took **79.1s** to
rebuild, and Cancel returned the UI at **23.7s**. The 55s saved is the point; what follows is what
that design bought.

**One check, at the top of the part loop** in `buildAssemblyGeometry`
([src/geometry/assembly.ts](../src/geometry/assembly.ts)). That is the only place in that loop
where nothing is owned: `owned` and `partMan` are Manifold solids freed by hand on each branch,
with no outer try/finally around the per-part body. Three cancels in a row held the heap flat at
177.0 MB.

Three consequences, all open:

- **Latency is one part.** 23.7s of 79.1s above.
- **A single-part assembly cannot be cancelled**, nor can a press that lands during the last part.
  The button sits at "Cancelling…" for the rest of the build.
- **Flat rebuilds are not offered a Cancel.** The obvious place to check, `unionAllCooperative`
  ([regions.ts](../src/geometry/regions.ts)), is shared with Fill's tiling, which runs _inside_ the
  per-part body holding Manifold solids. A check there leaks on the Fill case the button exists
  for. Flat rebuilds measured 1.8-4s on 169 paths, so this costs little today; the dense
  135-path case is ~13s.

Closing all three is one job: give the per-part loop body a `finally` that releases what it holds.
The frees are spread across the branches and would have to become idempotent first, so a `finally`
could call them without double-freeing. Then the existing yield points become safe cancellation
points, latency drops to the yield budget, and the flat path can check too. Worth doing when
someone is already in that code; not worth a delicate refactor of the CSG memory management on its
own.

## Auto-merge is a similarity control; the user's actual constraint is a slot count

The slider (`None`/`Slight`/`Medium`/`Strong` — `src/ui/colorList.ts`,
`initColorListPanel`) walks a ΔE similarity threshold, merging colors that
look alike. Measured against a real 7-color volunteer SVG on the chair,
2026-08-02: `None` → 7 AMS slots, `Slight` (the default) → 7, `Medium` → 7,
`Strong` → 6. Second data point, 2026-08-16, a 7-color test SVG on the wheel:
`None` 8, `Slight` 7, `Medium` 7, `Strong` 7. The audience's actual question — per
[docs/audience.md](audience.md) — is "I have a 4-slot AMS Lite, make this
fit," a target-count constraint, not a similarity tolerance. The near-term
fix landing now (see the plan that added this section) reconciles the
computed slot count against the selected printer's capacity and warns when
it's over, which makes the mismatch visible; it does not change what the
slider controls. Closing this properly means re-deriving the ΔE thresholds
against a wider sample of real volunteer SVGs and either replacing the
aggressiveness slider with a "fit N slots" input that binary-searches a
threshold, or adding one alongside it. Needs real artwork to tune against,
not just the one measured sample — that's the reason it's deferred rather
than done alongside the reconciliation warning.

## Two open defects in the chair / pattern-library workflow

Two of four defects the maintainer named on 2026-08-05; the other two are fixed.
Both features are offered in the UI again. The report is the maintainer's, the
diagnosis is not, and where the cause is confirmed it says so.

1. **Dead zones still need defining — open.** It is written up in
   [roadmap.md](roadmap.md) ("Dead zones: mark the parts of a design zone that
   are hidden by an adjacent part"). Without it a design placed across a joint
   spends filament changes on surface nobody sees.

2. **The SVG templates have odd/wrong edges — confirmed, same root as the cut
   outline.** Every shipped template in `public/templates/` is a pure `L`
   polyline with no curve commands: the zone boundary is traced along mesh
   triangle edges and emitted vertex-for-vertex. So a template's outline is as
   faceted as the tessellation under it. Two of them are also very ragged
   rather than merely faceted — `back` carries a 355-point boundary with **18
   holes**, `front` 146 points with 3 — which is what a grown-region boundary
   looks like when it stops mid-surface, and is the same boundary the cut
   clips to. Note the repo already has curve fitting for the raster tracer
   (`src/raster/curve.ts`); nothing equivalent runs on a zone boundary.

The `AssemblyKind.hidden` machinery is kept working although nothing ships
hidden; the reasons are on `renderShapeKindOptions` in
[src/ui/partPanel.ts](../src/ui/partPanel.ts), `savedSessionIsOnHiddenKind` in
[src/state/persist.ts](../src/state/persist.ts), and at the top of
`tests/persist-hidden-kind.test.ts`.

## The display meshes re-derive a vertex weld the build already did

`bufferGeometryFromTris()` in [src/app/rebuild.ts](../src/app/rebuild.ts)
shades via `toCreasedNormals`, which buckets vertices by position to find the
faces sharing each one — for the chair that is a string hash per vertex across
368k triangles, on **every rebuild**, not just on load.

Manifold already welded those vertices during the boolean, and the result is
sitting on the same object the display path destructures: `bodyIndexed` /
`inlayIndexed` on `AssemblyPartOutput` ([src/types.ts](../src/types.ts)), which
3MF export consumes rather than re-welding. The display path ignores them.
Recorded here because the PR that added the creased shading (#140) claimed the
opposite — that no vertex-count saving was available — which was wrong, and
wrong in the direction that hides work.

**Not a drop-in.** Handing the indexed geometry to `toCreasedNormals` is
strictly _worse_: it opens with
`geometry.index ? geometry.toNonIndexed() : geometry`, so an indexed input is
expanded and then hashed anyway. Capturing the saving means a crease-aware
normal pass that consumes an index directly — real work, not a swap. Measure
first: the shading swap cost 3.0s → 4.1s on a chair load, and the weld is the
plausible cause but was never isolated, so confirm the attribution before
building anything.

Two more things worth knowing before touching this:

- `toCreasedNormals` matches vertices by **truncating to 0.01mm**
  (`hashMultiplier = (1 + 1e-10) * 1e2`, then `~~`), which is bucketing, not an
  exact or epsilon match. Cut bodies are safe — Manifold emits exactly
  coincident vertices, which always land in one bucket. A **user-uploaded STL**
  has no such guarantee (`renderRawAssemblyParts`): a shared corner whose
  coordinates straddle a bucket boundary stays unwelded and renders as an
  isolated flat facet. Cosmetic, source-dependent, unmeasured.
- Whatever replaces it has to keep the crease behaviour rather than drop it.
  A blanket weld plus `computeVertexNormals()` was measured and rejected — it
  melted the embossed logo on the storage box; see `CREASE_ANGLE_RAD`.

## The raster edge-density reading depends on how big the file is

**Measured**: [2026-08-19 photo cluster](findings/2026-08-19-raster-photo-cluster.md) supersedes
result 1 of
[2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md). Six of
seven photographs separate cleanly from the flat cluster and the 0.285 cutoff sits in that gap;
the seventh, a balloon against a clear sky, stays inside the flat band. The size dependence below
is what is left open.

`measureImage().edgeDensity` counts the share of pixels that differ from a neighbour, and that
share depends on the size the image is measured at. `MEASURE_EDGE` caps rather than resamples, so
a source under 512px is measured at its own size and reads higher for it.

| Source                                        | Measured         | Reads                                 |
| --------------------------------------------- | ---------------- | ------------------------------------- |
| `public/patterns/zebra.svg` exported at 128px | 0.6324           | photo                                 |
| the same file exported at 256px               | 0.3661           | photo                                 |
| the same file exported at 384px               | 0.2430           | flat, and this is where it flips      |
| the same file at 512px and above              | 0.1823 to 0.2086 | flat, a noisy band and not one number |
| `red-sox-logo`, a real 300px logo             | 0.2531           | flat, 0.03 from the cutoff            |

Two flat colours at every size. Only the export resolution changed.

The `sizes` bench mode shows the same effect from the other direction, on the measurement rather
than the file: `mario` reads 0.433 (photo) measured at 256 and 0.253 (flat) at 512. That rung is
diagnostic rather than shipping, since `mario` is always worked at 1024, but it isolates the
measurement size from the file size.

**Closing it**: derive the reading from something size-independent, or measure at a fixed size the
source is always resampled _to_ rather than capped at. The second is the smaller change and would
alter what every existing threshold means, so it wants its own measurement pass.

### Still unmeasured

Where volunteer uploads land. Six of the seven photographs are CC-licensed Commons files, which is
sound for asking whether the statistic _can_ score a busy photograph high and is not a sample of
what this app receives. `FLAT_EDGE_DENSITY` (0.12) and `PHOTO_EDGE_DENSITY` (0.45) are untested by
that run, which exercised only the midpoint. Flat art reaching 0.2532 is mild evidence against the
flat endpoint.

## Colors is the one trace control still fixed, and no single value suits real artwork

**Rejected, measured**: [2026-08-20 knee detector](findings/2026-08-20-knee-detector.md). Picking
the palette size from a knee in the region-count curve is right on two of the four sources that
have a column at their shipping size, moves with working size without a trend, and costs 3.5 to 5
seconds. Supersedes the "6 of 8" reading in
[2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md), which
was hand-scored off one full-resolution curve. **The problem below is unchanged and unfixed.**

Working resolution, blur and despeckle are all chosen from the image. The default palette size is
not — it is a constant, and measured across the sample corpus (`stubs/raster test/`, 2026-08-04) no
constant works. Asking for more colours than an image actually has does not return fewer, the way
it does on synthetic flat art: real files are lossy and anti-aliased, so the quantizer always finds
more tones and spends the surplus on the fringe around every edge.

Measured on the 300x300 Boston Red Sox logo, which has three real colours:

| Colors | Regions | Slots | Result                                            |
| ------ | ------- | ----- | ------------------------------------------------- |
| 3      | 37      | 4     | clean                                             |
| 4      | 56      | 5     | clean                                             |
| 6      | 364     | 7     | pale halo rings around the ring, letters and sock |
| 8      | 712     | 9     | worse                                             |

The same default is right for a five-colour cartoon (Tweety traces cleanly at 6) and too low for a
nine-colour one (Mario loses its yellow buttons at 6, and recovering them at 8 costs the blue iris
to a desaturated entry). So the harm runs both ways, but not symmetrically: too few colours reads as
a simplification, while too many reads as a defect — halos look broken, cost filament slots, and
multiply region count tenfold.

The region count looked like a usable signal for choosing it automatically, and is not: see the
rejection above. The curve is unstable across working size, the full ladder costs seconds rather
than the tens of milliseconds a quantize pass suggested, and the rule is right on two of the four
sources that have a column at their shipping size.

What closing it needs is a different signal, measured. Distinct colours surviving a coarse
quantize, or the ΔE spread of the palette, are both single-pass and neither has been looked at.
Whatever the candidate, it has to be checked on photographs, where region growth is smoothest and
any signal weakest, and the traces have to be **judged by eye**: region count cannot tell a cleaner
trace from a coarser one.

## The trace parameters are calibrated against a downscale that is no longer constant

**Measured**: [2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md)
quantifies the cost; [2026-08-20 blur vs downscale](findings/2026-08-20-blur-vs-downscale.md) is an
invalid test of the fix this section proposes. Read the second before designing another.

`decode.ts` has always noted that the downscale to the working size "doubles as the first noise
filter", and the blur/despeckle endpoints in [stats.ts](../src/raster/stats.ts) were tuned with
that filter in place. It was doing more work than the note implies: a 1588px source averaged 3:1
down to 512px loses the anti-aliased fringe on every colour boundary outright.

Making the working size adaptive broke that assumption without touching the parameters. Flat art
now averages about 1.5:1, the fringe survives, and those pixels sit between two palette entries and
get assigned alternately — a cartoon's eye came back striped blue and white. Flat art carries a
one-pixel blur to compensate, and quantization was split so that the palette is discovered from the
source while only assignment reads the blurred copy (otherwise a blend tone that exists nowhere in
the file wins an entry and costs a filament slot; `tests/raster-quantize.test.ts` pins both halves).

What is still unresolved: the compensation is a constant, not a function of how much downscaling
actually happened. A small source that is never downscaled at all gets the same one-pixel blur as a
1588px one that was halved, and neither is the case the endpoints were tuned for.

**Still open, and one attempt to test it was invalid.**
[2026-08-20 blur vs downscale](findings/2026-08-20-blur-vs-downscale.md) tried to check whether the
benefit tracks the ratio by re-rendering vector patterns at several sizes. It cannot: the working
size is always 1024, and a vector baked large then filtered down gives essentially the same raster
as one baked small, so the anti-aliased fringe the compensation exists to replace is never created.
Four of the five sources' control arms do not change at all across the ladder, and the fifth moves
with its own base-blur flip rather than with the ratio. Read it before designing another test.

A valid version needs genuinely different raster pixels per rung, one large flat-art image resampled
the way a user's exports would be. `bench-raster.ts blur` is the harness for it.

What is not in doubt, from the earlier corpus run: the constant is wrong for some artwork. It
quadruples region count on `cartoon` at the size the app ships it, and across five vector sources at
a fixed working size it helps exactly one and hurts or no-ops the rest.

**Closing it** still means deciding what the compensation should be a function of, and the ratio is
the untested candidate rather than a rejected one. Whatever the test, it needs raster inputs
resampled to several sizes on disk, since no mode here can produce them, and the traces need looking
at rather than counting: region count cannot tell a cleaner trace from a coarser one.

## An empty trace says the wrong thing, and its pill never leaves

`parseRasterImage` throws when nothing survives the despeckle floor, and the printable floor
(2026-08-20) made that reachable from a placement rather than only from a noisy image: a
transparent-background image of small marks on a 32mm hubcap can come back with nothing. The
sliders no longer die on it (`artworkListPanel`'s catch puts them back), but everything the user
then reads is off:

- **The message is "try raising Detail, or use a less noisy image".** Detail cannot help when the
  printable floor is what emptied the trace, since Detail deliberately does not scale that half.
  Measured on a 256px confetti image at 0.05mm per pixel: it throws identically at Detail 0, 50 and 100. The remedy that works, make the part or the design bigger, is not offered.
- **The pill it raises is a `warn()` that nothing retracts**, so it outlives the setting that
  caused it. The capped notice next to it shows the pattern (`dismissNotice` on the next clean
  trace), but that needs a per-source identity the message does not have: it carries no image name,
  and adding one collides for two files of the same name.
- **The load path and the slider path disagree**: a fresh load reports through `reportLoadFailure`,
  which names the file in a dialog, while the slider raises an unnamed pill.

Closing it means one message with the right remedies for both causes, and one identity scheme for
retracting it. Three review rounds on this branch each produced a new defect in it, which is why it
was cut rather than patched again.

## Flat plate modes have no printable despeckle floor

The floor that stops the trace keeping detail under one nozzle width
([2026-08-20 printable floor](findings/2026-08-20-printable-floor.md)) applies on assembly kinds
only. `rasterMmPerPixel` returns nothing in disc/rect/round/STL-plate mode, so those keep the
fraction-of-the-image floor alone, which is what every mode had before.

- **Why**: a plate fits the design's drawn content (`fitTransform` over `parsed.bbox`), and that
  bbox does not exist until the trace has run. The pre-trace stand-in, the bounds of the opaque
  pixels, is wrong in the damaging direction: a stray opaque speck in a corner inflates the extent,
  shrinks mm per pixel and raises the floor over detail that would print. It was built that way and
  cut on review rather than shipped.
- **What it costs**: an 80mm disc at the 5% margin is a 72mm design, where the flat-art fraction is
  already a 0.88mm floor, so the printable one is inert at Detail 50 and would bite below about
  65mm placed at Detail 100. Small plates and scaled-down designs are the gap.
- Closing it means an extent the trace agrees with: either trace once at the fractional floor and
  re-trace when the printable one turns out to bind (two passes, ~830ms each on a photograph), or
  a cheap despeckle-equivalent pass over the alpha channel before measuring.

## The printable despeckle floor is fixed at the moment of the trace

`rasterMmPerPixel` ([src/state/artwork.ts](../src/state/artwork.ts)) reads the placement when an
image is traced, which is at load and again whenever Colors or Detail re-runs it. Nothing else
re-traces, because a trace measured ~830ms on a photograph and a slider drag would fire it per
step.

**Every input to the floor can move afterwards, and Scale is the smallest of them**: hubcap
diameter (32mm to the plate's short side, up to 270mm), the wheel's Design radius, switching
assembly kind, and the one-click Sticker/Fill switch, which changes the scale _rule_ rather than a
number. Scale itself only spans 25-400%. "+ add to another zone" is the quickest of all: it places
a second instance at 100% against a trace made for a smaller one, so the largest-instance rule the
floor was chosen by is stale the moment it lands. A hubcap cut to artwork shape adds one more: the
floor is read before the new source is registered, so it sees the _previous_ design's silhouette
face. And within the Scale field's 550ms typed debounce, `ArtworkInstance.scalePct` still holds the
old value (only a rebuild syncs it), so a Detail nudge inside that window sizes the floor from the
scale before the one just typed.

- **Getting smaller after loading** leaves the older, more permissive floor: features under a
  nozzle width survive that a fresh trace would remove. That is the pre-2026-08-20 behaviour, so it
  is a missed improvement rather than a regression.
- **Getting larger is the one that loses something**: detail removed at the size it was traced for
  would print at the new size. Load onto a 32mm hubcap and raise it to 220mm and it is gone, with
  nothing said. Only a nudge of Colors or Detail brings it back.
- The help panel now says to nudge Colors or Detail after a big resize, which is a note in a
  dialog, not the app noticing. Nothing in the panel that did the resizing says anything.
- Closing it means re-tracing when the placed size moves far enough to matter, which needs the
  debounce and the cancel path the Colors and Detail sliders already have, or a notice that says
  the design was traced for a different size.

## Restoring a session re-traces every loaded image

Session restore used to do no image work at all, because images were not saved. They are now, as
the working copy re-encoded to PNG, so restore has to run quantize and trace over each one before
the app is usable. On a 512px photograph that stage measured ~830ms
([bench-raster.ts](../scripts/bench-raster.ts)); the round trip on a 96px test image is
imperceptible. Several photographs in one session would add up.

It happens inside the overlay the restore already shows, so it reads as a slower restore rather
than a hang. Closing it means caching the traced result alongside the pixels, which is a much
larger payload (the parsed regions, not a PNG) and would put the 4MB `MAX_BYTES` ceiling back in
play, so this is a deliberate trade rather than an oversight.

Sizes behind the choice, measured 2026-08-17 in this app: raw RGBA at 1024x1024 is 4.0MB, which is
the whole session budget. The same pixels as PNG are **24KB** for flat art and **703KB** for a
photograph; as WebP q92, 4KB and 108KB. PNG ships because it is lossless: a lossy copy would shift
colours before the quantizer sees them, and the design could come back with a palette, and so a
filament list, the user never chose.

## The chair's zone sidecar is 1.7 MB raw / 638 KB gzipped

(`public/stl/chair-body-zones.json`), up from 125 KB gzipped when each zone
stopped at one part. Zones that span the whole chair simply carry more
triangles. Measured composition: 41% `chartTris`, 30% `uv`, 16% `tris`, 9%
`verts` — so it is mostly index arrays, and rounding the UVs buys little.
The real fix is delta-encoding the index arrays and/or a binary format;
brotli alone would take it to 349 KB if the host serves it. Not urgent (it
loads async, after first paint, and only for the chair) but it is the
largest asset in the app. Don't quantise UVs below ~0.01 mm to chase this:
two chart vertices closer than the quantum would collapse into a
degenerate UV triangle and the warp's barycentric lookup divides by its
area.

## `CHART_SNAP_MM` tracks a bake artifact instead of guarding placement

A
part's baked claim on a zone (`subRegions`) is slightly more generous than the
triangulation inside it, so the claim outline pokes narrow tendrils past the
end of the chart. Cutter vertices landing in one are legitimate artwork with
no triangle under them, so the snap tolerance has to be wide enough to absorb
the deepest one — 2.150 mm on the shipped bake — which is why it is 3 mm
rather than the sub-millimetre value a pure misplacement guard would want.
Fix: re-bake so each claim matches its triangulation, then tighten the
constant. Deferred because it invalidates every downloaded template and the
sidecar. Until then `tests/chair-zones.test.ts` pins the measured worst case;
**measure it by hill-climbing, not by rastering** — the depth is a distance
function, so a step-_h_ grid under-reports the peak by up to _h_/√2, and a
1 mm raster put the worst at 1.915 mm against a true 2.150 mm.

## A seam sliver warns as if artwork were lost

Where two parts' claims on
a zone overlap, clipping a color to one part's `subRegions` can leave a
remnant a fraction of a millimetre wide. It survives the turf clip, then
yields no cutter, and
[src/geometry/assembly.ts](../src/geometry/assembly.ts) reports "Couldn't cut
color … into …. It won't print there." — alarming, and indistinguishable from
the real failure it shares a message with. The overlaps are inherent to per-part
clipping and small — measured across the shipped bake, 23 overlapping part
pairs, all seam-sharing, worst 29.85 mm² on a 124,500 mm² zone (a ~0.15 mm
ribbon), and `tests/chair-zones.test.ts` holds them under 0.05% of zone area.
Fix: drop a clip remnant under an area floor _before_ `buildCutter` rather
than attempting it and warning. Pick the floor above the measured ribbon and
well under anything printable.

This bullet used to cite the 2026-07-28 "Seat back (bottom)" warnings as a
confirmed sighting. Instrumenting the running app on 2026-07-31 showed that
those had a different cause — cutter vertices landing outside the snap
tolerance, since fixed — and that they looked permanent only because warnings
were never cleared per rebuild, also since fixed. So the seam remnant is still
real geometry and still reaches `buildCutter`, but **no warning has actually
been traced to it**. Confirm one before spending the fix on it.

A deliberate hunt on 2026-08-08 failed to produce a sighting —
[docs/findings/seam-sliver-sighting.md](findings/seam-sliver-sighting.md), 18
checkerboard configurations across three cell densities, two scales and
sub-millimetre offsets, then a finer rotated pass recording triangle and color
counts so "no warnings" is a statement about a build that demonstrably ran. Zero
cut-solid warnings throughout. That is not proof the remnant can't warn, but it
is the cheap attempts already spent — read it before repeating them.

## Artwork can't wrap unbroken from one flank around the back to the other, and three ways of fixing it are measured dead ends

The chair carries `left`, `right` and `back` as three zones, so a design
placed on one stops at the zone boundary. Two approaches were prototyped and
measured against the shipped bake; both lose, for different reasons, and the
numbers are recorded here so nobody re-derives them.

**A cylindrical band** (unwrap left→back→right about the chair's vertical
axis, like a label on a bottle). The geometry cooperates in one respect: a θ
histogram over the three zones' 35,320 triangles shows a **64°-wide empty
sector centred on +Z**, the chair's front opening, so the wrap seam lands
where there is no surface. The best-fit axis is x −0.26 (on the centreline,
as symmetry demands), z −297.27, with an area-weighted mean radius R₀ of
231.29 mm. But the chair is not a cylinder: only **39.8%** of the band lies
within ±10% of R₀ and per-part radii run 0.73–1.62 × R₀. Real per-edge
stretch, measured with the same metric `orientChart` reports, at a 45°
outward limit: **max 2.113, mean 1.0800, 27% of edges past the
`DISTORTION_WARN = 1.1` the bake already flags** — and that buys only
**69.6%** of the surface the three zones carry today. A radius-profile
variant (u = r̄(y)·θ) is far worse (max 11–16): r̄ changes too fast where the
wheel mounts give way to the storage boxes.

**One merged LSCM zone.** The standing objection to this — "the exterior
wraps into a U and `lscm` needs disk topology" — is **wrong**: the same 64°
gap means the band never closes, so it is a strip, and a strip is a disk. It
does unwrap, cleanly by every metric the bake reports: one island, **0
flipped triangles**, max stretch **1.540** / mean **1.0242** over 100% of the
surface (p99 is 1.152; only 2.14% of edges exceed 1.1), sidecar _smaller_ at
1675 KB. It still fails, on something the bake does not measure — **UV
injectivity**. LSCM is only locally conformal, so `flipped == 0` rules out
local inversion but not the chart folding onto itself globally. Chart area
covered by more than one triangle:

| zone                                  | self-overlap           |
| ------------------------------------- | ---------------------- |
| shipped `left` / `right` / `back`     | 0.11% / 0.04% / 0.03%  |
| `front` / `seat` (untouched controls) | 0.01% / 0.01%          |
| merged band                           | **4.85%** (15,976 mm²) |

On that 4.85%, `ConformalZoneMapper.lookup` finds two triangles and takes
whichever its grid search reaches first, so artwork cuts onto the wrong sheet
of surface — worse than the seam it removes. 91% of the overlap is _self_
overlap within four parts (the two handles and two storage boxes), not
part-against-part.

**There is no angle window between the two failures.** At the shipped
45/35/45 the band is connected and overlaps 4.85%; at 40/32/40 it is still
connected and still overlaps 4.58%, for 12% less surface; at 32/28/32
`assertSingleIsland` fails with 10,891 of 25,515 triangles reachable. Loose
enough to stay one island means it folds; tight enough not to fold means it
severs. The link between each flank and the back runs through the handle's
curved corner, which is both what forces the fold and what only survives at
loose angles.

**Cross-chart registration** — keep the three charts, but let one placement
span them by giving each chart a rigid offset into a shared band coordinate,
so continuity is carried across the boundary instead of by a single injective
unwrap. This is the option the two failures above leave open, and the one
that does not need the band to be a single chart at all.
The transform is real: the best-fit rigid UV motion from `left` to
`back` comes out at **−0.1° rotation, scale 1.0074, 1.26 mm rms** (`right`
0.0°, 1.0062, 1.26 mm), all comfortably inside `CHART_SNAP_MM` and plausibly
inside what the printed assembly delivers anyway.

It fails on the boundary, not the maths. `left` and `back` share **10
vertices** — two ~11 mm fillet arcs at y≈346 and y≈454 on one handle, about
22 mm of contact on zones spanning 500 mm of height. They share **zero**
vertices on the storage boxes, the largest flank surface, because that corner
turns **89.6°** (86.3° on the handle) while the two zones' limits sum to 80°:
there is a wedge of surface orientation neither zone accepts, ~28 cm² on the
storage box and ~92 cm² on the handle, and that unclaimed wedge is what keeps
them apart. Widening `back` 35°→45° so the limits sum past the corner
densifies the contact to 55–64 shared vertices and tightens the fit to
**0.97–1.03 mm rms**, but does not lengthen it by a millimetre: it stays
inside y 337–462 with **17 gaps over 8 mm** in it. A design registered across
that would flow through the handle posts and stop everywhere else — which
reads as broken, where today's clean stop reads as deliberate.

**Correction to the paragraph above: for a single zone, stretch binds long
before injectivity does.** Injectivity is the constraint on _merging_ zones,
not on widening one. Widening the flanks 45°→50°, measured against the
shipped bake:

| zone        | max stretch | mean stretch | UV self-overlap |
| ----------- | ----------- | ------------ | --------------- |
| `left` 45°  | 1.224       | 1.0142       | 0.11%           |
| `left` 50°  | **2.543**   | **1.2342**   | 0.06%           |
| `right` 45° | 1.226       | 1.0159       | 0.04%           |
| `right` 50° | **3.470**   | 1.1170       | 0.05%           |

Overlap stays clean at every setting; stretch doubles for 5°. So the config's
own coverage-against-stretch framing is right for the per-zone angles after
all — it is only the _three-way split_ that injectivity explains. Widening
`back` alone is likewise not the free win it looks like: 35°→45° adds 30% more
triangles but only **+5.4% area** (960 → 1012 cm², the extra triangles being
fillet detail) while max stretch goes 1.134 → 1.581.

What is left is a different parameterization family — cone-singularity methods
(BFF, OptCuts) rather than plain LSCM, aimed at low stretch under wide normal
spread. That is a substantially bigger change than any of the three
prototypes, and nothing today needs it: `left`/`right`/`back` at the shipped
angles are close to the best plain LSCM does on this geometry.

One latent bug found and deliberately **not** fixed: `classifyRegions` in
[scripts/lib/zonebake.mjs](../scripts/lib/zonebake.mjs) decides outer-vs-hole
by containment depth parity, which is right for nested SVG subpaths but wrong
for triangulation boundary loops — a concave part slice has solid lobes
sitting inside another loop's ring, and parity calls them holes. It cost the
merged zone 26% and 60% of the two handles' claims. Every shipped claim
matches its triangulation within 0.3%, so it does not affect the current
bake; classifying by winding sign instead is the fix if a future zone ever
trips it.

## A part seam is a hairline the zone pick can't be aimed into

Introduced by the occlusion test in [src/scene/zonePick.ts](../src/scene/zonePick.ts), and the
price of it. Each part's zone chart stops at that part's own edge, and the chair's parts meet
across a printed clearance whose widest measured value is 0.530mm — the chair's real seat-centre to
seat-back gap, recorded in the `_note` of
[scripts/zone-configs/chair-body.json](../scripts/zone-configs/chair-body.json). Not
`seamWeldTolMm`, which is **0.6**: that is the tolerance picked to clear the gap, and anyone sizing
a bound against the wrong one of the two gets it wrong by 70 microns. A ray aimed
exactly down a seam therefore passes _between_ the two charts, lands on the far part's chart, and
finds the near part's edge wall in front of it — so the pick is correctly rejected, on a surface
that renders as continuous. The result is a thin dead line along every seam.

Measured 2026-08-08 by `npm run check:zone-occlusion` on the chair, `MOSAIC_GPU=1`, ANGLE D3D12
(RTX 2060), 1748-sample grid at four viewpoints: **one** sample, at the centreline seam of the
back panel, **3 px** of unpickable width. Nothing at the other three viewpoints. That check
excuses a run up to `CLICK_MOVE_TOLERANCE_PX` (5px, the pointer slop the click model already
treats as the same place) and fails anything wider, reporting the measured width either way — so
this getting worse is a failing check, not a silent drift.

Not worth fixing at 3px, and the two ways to would both cost more than they buy: widening
`OCCLUSION_TOL_MM` past the seam clearance would also stop a genuinely adjacent part from
occluding anything, and closing the gap in the pick surface means welding the charts across seams
at runtime, which is the bake's job and would re-open the injectivity questions the zone split
exists to avoid. Revisit if a future part's clearance is large enough to make the line visible.

## A Fill under a sticker overlaps just like two stickers do, and isn't checked

The overlap check in
[src/geometry/designOverlap.ts](../src/geometry/designOverlap.ts) compares
two stickers by their placed footprints and then by how much of each one's
ink reaches the footprint they share, and treats two Fills on one zone as
always overlapping. It deliberately says nothing about a Fill paired with a
sticker, because a pattern background with a design on top is a real
workflow and flagging it would fire on the intended use.

But the geometry doesn't care about intent: the sticker's pockets and the
fill's pockets are separate cutters, so wherever the sticker's colors differ
from the pattern's underneath it, the export carries two inlay solids in the
same volume — exactly what the sticker-vs-sticker warning exists for. It is
unmeasured: no export of that combination has been opened in a slicer to see
what actually prints, and the app ships no example using it.

Two ways to close it, neither cheap enough to bundle with the check that
prompted this note. (1) Make it correct rather than warned: subtract the
sticker's pockets from the fill's before the inlay intersection, so the
background yields to what sits on it. That is the behavior a user expects,
and it makes the pairing supported instead of merely tolerated — but it is a
per-color boolean on the fill's full tiled region, on the path already
measured at 405s for one chair zone (see the rebuild-performance section).
(2) Warn only where the fill's ink actually lies under the sticker. The
plumbing for that now exists: `placedInk` in
[src/geometry/assembly.ts](../src/geometry/assembly.ts) hands the sticker
comparison each design's placed cut regions. A fill's are the tiled ones, so
this still needs the grid, and the check would have to stop skipping the
mixed pair. Start by measuring (1) on the wheel, where the fill region is
small enough to time honestly.

## The instance cascade still seeds a silent overlap in two measured cases

`cascadedOffset` ([src/state/artwork.ts](../src/state/artwork.ts)) steps a new
design diagonally off one already at that spot. The step used to be a flat 8mm;
it now scales to the largest design on the surface, capped at
`CASCADE_CLEAR_MAX_MM` (11.7mm, derived from `INSTANCE_CASCADE_MM` and
`OVERLAP_WARN_FRACTION`). Where that applies, every pair on the surface lands
clear. Two cases it does not reach, both measured:

| Case                                    | What happens                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything over 11.7mm shares the surface | The step falls back to 8mm for everything on it. Two 10mm designs beside the wheel's 276mm default land 8mm apart, 4% covered, under the warn threshold                                                                                                                                  |
| Two designs of opposite proportions     | Both measure the same across their narrow axis, so no clearance derived from that parts them. It does not take extreme shapes: an 8x11.5mm design and an 11.5x8mm one both read 8mm, step 8mm, and cross in 3.06mm², 3.3% of either. A 5x200mm bar against a 200x5mm bar crosses in 2.5% |

Neither is a regression: both behave exactly as the flat 8mm step did.

**Why a bigger or smarter constant does not close it.** Any single step `s`
leaves a silent band from `s` to `1.4625s`, since two `w`-wide designs only
reach `OVERLAP_WARN_FRACTION` at `w >= s/(1-sqrt(fraction))`. One step per
surface is forced: a step chosen per design puts a later small one between an
earlier big one's lattice spots and wholly inside it (measured, and pinned by
"does not park a small design inside one already cascaded past it" in
`tests/artwork.test.ts`). So the band can be moved but not removed.

Reading the clearance off the wider axis instead of the narrower one parts the
opposite-proportions pair, at the cost of moving every shaped-alike pair further
than it needs to go. It is a defensible swap, not a fix: the band above stays
either way.

**What closing it takes.** Drop the lattice. Search for the nearest free
placement given the two designs' actual placed footprints, rather than stepping
a fixed distance and testing for an exact-spot collision. That is a real
placement search and wants its own change, not a wider constant.

## A traced image can lose a color with nothing said

`parseRasterImage` narrows the palette to the colors that actually paint something, and since
2026-08-20 the despeckle floor removes far more than it used to
([2026-08-20 despeckle floor](findings/2026-08-20-despeckle-floor.md)). Five of nineteen corpus
sources come back with fewer colors than the Colors slider asked for: gravel 8 to 5, foliage 8 to
7, dalmatian and zebra 4 to 2 and 3, the cartoon 6 to 5.

- **Correct, and silent.** Those colors were only ever painted in pieces under the printable floor,
  so the narrower list is the honest one. Nothing says so: the readout shows the number it found,
  and the user has to notice it differs from the number they asked for.
- The `capped` notice ("Some detail was too fine to print and was merged") covers the
  `MAX_COMPONENTS` case only, which now fires much less often, and its remedy (lower Colors, lower
  Detail) is backwards for this one.
- Closing it means deciding whether a dropped color is worth a notice at all, and if it is, saying
  it in a way that does not fire on every photograph. Raising Detail is the remedy that fits.

## `MAX_COMPONENTS` is a target, not the bound its name implies

`traceLabelMap` ([src/raster/trace.ts](../src/raster/trace.ts)) raises the despeckle floor when the
component count exceeds `MAX_COMPONENTS` (800), then never rechecks. The raise now reliably cuts
the count, which it did not before 2026-08-20
([2026-08-20 despeckle floor](findings/2026-08-20-despeckle-floor.md)), but it still does not bound
it. Two ways past the cap, both after the count was taken:

- **Absorbing specks merges them into each other**, minting components above the new floor. So
  putting the floor above all but the largest 799 does not leave 799. Reproduces on a speck field
  handed straight to `traceLabelMap` with a high floor. **Not reproduced through the real decode
  path since the despeckle fix**: the pixel art that looked like it did reads as photographic at
  the measurement size (0.3045), so the app traces it at 512px, where the raise fires and 78
  components come back. Whether a decodable image can still get past the cap is open.
- **`deChecker` breaks 2x2 checkerboards by rewriting one cell**, which can shave a pinch point and
  split a surviving component in two. Off-corpus it is common: about 8% of random label grids come
  back with a component under the floor the trace reports, against 0% straight out of `despeckle`.
  No corpus source does it, so what it costs a real image is unmeasured. Swapping the order is not
  the fix, since `despeckle` relabels whole components and can create the checkerboard `deChecker`
  exists to remove, and a self-touching ring is the worse failure.

- The cap is a performance guard on `shapeToFeature`, so being over by a few hundred on a
  pathological source costs time rather than correctness.
- Closing it: loop the raise until `realCount()` is actually under (and decide what a second raise
  does when a `deChecker` split is what pushed it over), or rename the constant and the flag to say
  what they do. `capped` today means "a raise happened", not "the count is under".
- The bench's `despeckle` mode checks the floor and the cap on every row, but only over CORPUS, so
  its cap line has never had a source that could trip it. Both columns also read the components the
  trace _returns_, which is fewer than the count it capped on: background components and any whose
  ring collapsed are already gone. A transparent speck left under the floor would be a real defect,
  and this guard would miss it.

## The extrude repair never runs on a conformal zone

`ConformalZoneMapper.buildCutter` absorbs an invalid prism inside `tryWarp` and returns `null`, so
`soup` is falsy and the whole repair block in
[assembly.ts](../src/geometry/assembly.ts) is skipped. The escalating erode ladder that fixed a
lost color on the wheel therefore buys the chair body nothing: a flat zone gets two attempts at
repairing a self-touching region, a conformal one gets none and goes straight to the warning.

- Surfaced by the fix for "Couldn't cut color … into …" on the wheel, which is a
  `FlatZoneMapper`. Measurements and wrong turns:
  [2026-08-20 extrude repair erode](findings/2026-08-20-extrude-repair-erode.md).
- The asymmetry is pre-existing and is acknowledged by the comment beside the warning, which
  describes the conformal case as "the warp found no surface under part of the region".
- Whether the chair body actually hits self-touching regions is **unmeasured**. The pattern library
  and chair body are both hidden from the UI, so nobody has driven dense artwork through a
  conformal zone to find out.
- Closing it means either giving the conformal mapper the same retry, or establishing that its
  null return means something different enough that a retry would be wrong.

## Keep `@turf/turf` pinned to 6.5.0 — v7 is a measured perf regression here

A 7.3.5 upgrade was fully implemented and benchmarked (2026-07):
correct output, but its new polygon-clipping engine ran **5–10x slower**
on this app's union-accumulation hot path (40ms → 215ms at 20 shapes,
76ms → 726ms at 120), turning slow rebuilds into multi-minute ones. Don't
re-attempt without benchmarking that path first. The 6.5 quirks remain:
the boolean-failure workarounds in
[src/geometry/regions.ts](../src/geometry/regions.ts) (degenerate-ring
scrubbing, precision-truncation retries) target 6.5's exact
polygon-clipping bugs, and 6.5's package typings don't resolve under
modern TypeScript, hence the shim in [src/turf.d.ts](../src/turf.d.ts).

**Nothing re-measures this on demand.** The 5–10x figure came from a one-off harness built for
that attempt and not kept, so the pin is enforced by prose and an exact `package.json` version. A
standing `bench-geometry` script is deliberately not built: it would only ever be exercised by an
active turf upgrade, and writing it now costs about what re-deriving it later costs. When an
upgrade becomes live work it is step one rather than an afterthought, over the
union-accumulation path at a few shape counts, with the numbers above as the baseline to beat.

## The export-placement seal proves a mesh hasn't changed, not that anyone re-verified it

`PART_FINGERPRINTS` is generated
([scripts/bake-part-fingerprints.mjs](../scripts/bake-part-fingerprints.mjs)),
and re-packing a part without resealing is caught loudly — the seal test
in [tests/placement.test.ts](../tests/placement.test.ts) fails. The gap is the
step after: resealing is a single command that will happily re-bless a mesh
whose print pose nobody re-checked in the slicer, which is exactly the
motion someone takes to make the failing test go away. It is deliberately
_not_ wired into `pack-part.mjs` for that reason (auto-resealing would
delete the tripwire), so the guarantee rests on the reminder that script
prints and on the add-part skill. Closing this properly means recording
_what_ was verified — the reference file and its hash — alongside the mesh
fingerprint, so a reseal against an unchanged reference is distinguishable
from one that silently redefines the verified pose.

## Per-part export placement is a lookup table in [src/export/placement.ts](../src/export/placement.ts), not part of the part definition

It used to be an `if (roleId === …) else if …` chain; the
chair's fifteen pieces turned that into a `PLACEMENT` record keyed by
library part id, so adding a part is now a data change rather than a code
one. It still lives apart from the role it describes, though — these are
per-part constants and belong as data on the `AssemblyKind` / role
definition, matching the "one array entry" goal in
[src/assembly/kinds.ts](../src/assembly/kinds.ts).

## Real malformed input never reaches the CSG failure branches

Every branch is now driven against the real Manifold engine:
[src/geometry/csgFault.ts](../src/geometry/csgFault.ts) arms a forced failure from the URL
(`?csgfault=difference`, `?csgfault=color-union:1`) at the five points where a real one
originates, and [scripts/check-csg-failure.mjs](../scripts/check-csg-failure.mjs) drives the app
through each, exports a real 3MF, and asserts the degradation that reaches the file against an
undamaged baseline. Run it with `npm run build && node scripts/check-csg-failure.mjs`; the
`debug-csg-failure` skill is the walkthrough, and that script carries the first run's measured
numbers.

What that does not prove: the fault points force the _handler_ to run, so they establish the
degradation and the cleanup, not that Manifold fails on any particular real mesh. Genuinely
malformed input is still untested, and there is no fixture for it.

## Zebra + Fill still loses one color on "Handle (left)"

**Not currently reachable:** the chair body carries `withholdFill`, so Fill and
the pattern strip are both withheld there — this needs fixing before that flag
comes off, not before the next release. The defect below is unchanged.

Left over after the vertex-count fix below, measured on `MOSAIC_GPU=1`
production build, 2026-08-03: zebra in Fill mode on the chair's Left side
settles clean apart from a single
`Couldn't cut color #0a0a0a into "Handle (left)"` (the wording at the time named
the cut solid) — so that part prints without the black, per the handling described in
[troubleshooting.md](troubleshooting.md).

This is not a regression from the thinning, but the thinning is what exposed
it. On the old asset the same part failed _earlier_, at the 2D union
(now `Couldn't merge the shapes for color #0a0a0a on Handle (left)`), and fell back to
the unmerged shape — a coarser input that the 3D boolean then swallowed
without complaint. With the union succeeding, the full-detail pattern reaches
Manifold and that is where it now fails. Net it is 8 union failures across 4
parts down to 1 CSG failure on 1 part, but "one part quietly loses a color"
is still the outcome.

Different layer from the union problem — this one is Manifold, not turf 6.5 —
so the fix is likely different too. Worth trying first: whether the handle's
own mesh density or a near-tangent cut at its curvature is what trips it, by
re-running with the pattern scaled up (fewer, larger stripes on that part).
Closing it means reproducing against `?csgfault` (see "The CSG failure
branches" above) and narrowing to the specific solid Manifold rejects.

## Turf's tile union has a vertex ceiling, and nothing enforces it at runtime

Measured 2026-08-03 while fixing the bundled zebra pattern. Fill mode unions
one copy of the pattern per tile, and `@turf/turf` 6.5's polygon clipping
starts failing somewhere around **800k vertices in a single operation**. It
does not throw at that point — it drops tiles, and the only surface signal is
`Couldn't merge the shapes …`. That message used to assert a cause it could not
know ("likely a self-intersecting path in the source SVG"), which was wrong here:
the paths were fine, there were simply too many of them. It is now cause-neutral
and [troubleshooting.md](troubleshooting.md) carries both causes, so what is left
open is that nothing tells the user _which_ one they hit.

The numbers that made it concrete, zebra in Fill mode on one chair zone
(`MOSAIC_GPU=1` production build):

|                                      | 13.6k verts/tile  | 1.3k verts/tile |
| ------------------------------------ | ----------------- | --------------- |
| vertices across the zone's 143 tiles | 1.95M             | 187k            |
| union failures                       | 8, across 4 parts | 0               |
| triangles produced                   | 853k              | 2.07M           |
| rebuild                              | 468.7s            | 93.6s           |

The doubled triangle count is the tell that this was silent data loss rather
than slowness: the failing run produced _less_ geometry because four parts
fell back to unmerged shapes.

What is fixed: the asset. `scripts/gen-patterns.mjs` thins zebra's contours
(`simplifyEps`), and `tests/patterns-assets.test.ts` fails any bundled pattern
whose vertex count times a chair zone's tile count would approach the ceiling.
That test's `TILES_PER_CHAIR_ZONE = 143` is this measurement frozen into a
constant, not derived from live zone geometry (`tileCoverage()` in
`src/geometry/patterns.ts` needs a real placer + extent, which only exists
mid-build) — deliberately: pulling the full chair build into what is
otherwise a fast, dependency-light asset test isn't worth it while the
budget (300k) already sits well under the failure point (~800k), a 2.6x
margin a moderately larger future zone would not eat through. If a real
zone's tile count ever grows enough to close that gap, this constant needs
re-measuring by hand — nothing will flag it automatically.

What is not fixed: **user-supplied** SVGs get no such check. A volunteer's
detailed drawing in Fill mode on a chair can cross the same line, and will get
the same misleading self-intersection warning and the same partly-blank
surface. Closing that means either counting vertices before the tile union and
warning honestly ("this design is too detailed to repeat across this surface —
N tiles × M vertices"), or chunking the union into batches small enough to
stay under the ceiling and merging the results. The batching option also
removes the ceiling for the bundled patterns, which would make the asset
budget above a performance concern rather than a correctness one. Upgrading
turf past 6.5 may move the ceiling but is separately blocked — see the
`@turf/turf` pin section.

## The hubcap's plate is verified on two beds and up to one diameter

`HUBCAP_PLATE` ([src/export/threemf.ts](../src/export/threemf.ts)) carries
hand-verified arrangements for the 256×256 and 270×270 beds, both checked at
220mm. `hubcapPlacement` ([src/geometry/hubcap.ts](../src/geometry/hubcap.ts))
applies them only within that, and everything outside falls back to centring the
part with `suggestTowerPos` picking a corner — correct, and it says so, but it
is the outcome that needs a slicer pass every time.

What that leaves open, in the order it is likely to bite:

- **The H2D (350×320) has no verified plate at any size.** It is also the bed
  with the most room — a 220mm disc leaves a ~90mm corner, so the computed
  fallback is very likely fine. Nobody has confirmed it.
- **Nothing above 220mm is verified on any bed.** The control goes to the plate
  size, so a 250mm hubcap on a 270mm bed is reachable and unverified. On the
  256mm bed the verified clearance is only 7mm, so this is not a case where the
  existing numbers could be stretched a little.
- **A hubcap cut to its artwork's shape never gets the verified plate, at any
  size.** `hubcapPlacement` is withheld outright once "Cut to artwork shape"
  is on ([src/assembly/kinds.ts](../src/assembly/kinds.ts)), because
  `HUBCAP_PLATE` was checked against a round disc and a silhouette can reach
  further off-axis than a circle of the same longest-side reading. There is no
  obvious way to close this the way the two items above close — a verified
  arrangement would need to be re-checked per silhouette shape, which isn't a
  fixed set the way bed sizes are, so it likely stays computed-and-flagged
  rather than becoming baked.

Closing either is the same job and needs no code: export at the size and
printer in question (`scripts/export-hubcap-examples.mjs` produces the files),
position the part and the prime tower in the slicer, save, and add the numbers
as another `HUBCAP_PLATE` entry — plus raising `HUBCAP_VERIFIED_DIAMETER_MM` if
the new check is at a larger diameter. Read the provenance comment on
`HUBCAP_PLATE` first: the part position and the tower position are one claim,
because on both verified beds the disc had to move off centre to free a corner
at all, and transferring one without the other puts the tower through the part.

Worth knowing why this can't be solved once and for all the way the fixed parts
were: a generated part has no stable mesh to seal a pose against, so every
arrangement is only ever verified for the parameters it was checked at. More
entries narrow the gap; they don't close the category.

## A patch boundary that meets itself at a point traces as an open chain

`extractPatchBoundary` ([src/geometry/meshparts.ts](../src/geometry/meshparts.ts)) keys its edge
map by **vertex**. Where two boundary loops of one patch touch at a single point, one loses its
outgoing edge, the walk runs off the end, and the truncated chain is returned as if it were a ring.

**What it costs.** `applyAsmPatchChoice` now keeps every loop and
[zones.ts](../src/geometry/zones.ts) nests them by containment depth, so a truncated chain that
encloses area can be read as a hole where the face is solid, or as solid face inside a real hole.
The artwork is then clipped to the wrong shape, and on a hubcap cut to a silhouette the edge rule
reads the wrong rims as the part's outer wall.

**Measured.** Over every packed part's first six patches, 18 of 114 contain a chain that does not
close. All 18 are chair pieces, which take artwork through baked zones instead, plus `wheel-half`
patch 2 (its -Y back: 7 closed chains and 99 open ones). **None of the four kinds' actual design
faces is affected**: wheel-half patch 0, wheel-hub-cap patch 0 and footrest patch 1 are 1, 1 and 3
loops with no open chain at all, and the exported wheel and chair are byte-identical across the
loop-set change. So this is reachable by choosing a non-default design face, or by dropping a
pinched mesh on a role, and not by the shipped workflow.

**Why it isn't fixed here.** Two attempts were made while closing the loop-set item and both
introduced worse bugs than the one they closed, which is what argued for splitting it out:

- Discarding chains that do not close, marking vertices consumed as the walk goes: a chain running
  off the end ate a genuine loop it had entered, and both were lost. Six patches returned no loops
  at all, and `chair-seat-center` patch 0 dropped its 2101.5 mm² outline and kept a 1097.1 mm²
  sub-loop as the face.
- Consuming vertices only on close: a chain entering a cycle it did not start on then runs to the
  100000-iteration guard. `chair-seat-center` patch 0 is the **default** patch, hit on every chair
  load, and went from under 2 ms to 317 ms, emitting 1.6 M points of garbage; `wheel-half` patch 2
  went to 2162 ms.

**What closing it takes.** Key the walk by directed edge rather than by vertex, so a pinch vertex
keeps one outgoing edge per loop, and pair incoming with outgoing by angle around that vertex so
the loops are separated the way the geometry actually runs. A per-walk visited set merged into the
global one only on close, so a failed walk consumes nothing and cannot spin. Then decide what a
patch with no closed ring should do: today it yields a boundary that is wrong rather than absent,
and callers only ask whether a face was detected at all.
