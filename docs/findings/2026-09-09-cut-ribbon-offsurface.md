# Cut-region ribbons: not hidden surface, no surface

**Commit** `424535b` (after #299). **Machine** remote Linux container, headless
Chromium on SwiftShader — software rendering, no `MOSAIC_GPU`. Two commands
produce every figure below:

```
npx vite-node scripts/measure-cut-offsurface.mjs
npm run build && npx vite-node scripts/check-cut-ribbon-ink.mjs
```

both committed with this report. Nothing was re-baked.

**Result: the question the tech-debt section asked has no answer, because its
premise is wrong.** The thin `cutRegions` strips are not surface a cover hides.
They are not surface. 14 of the chair's 87 cut pieces lie at least half outside
their own chart's triangles, and the driven run shows one of them cutting a
**1.000 x 32.543mm** mark into `Wheel mount (left)`.

Two bases, kept apart deliberately. In UV the piece is 0.1950 x 32.5mm against
the #296 hairline's 0.020 x 8.08mm — 9.75x wider and 4.02x longer, the same
comparison the sibling report rounds to "ten times wider and four times longer".
The 1.000 x 32.543mm above is the EXPORTED mark, measured off the 3MF, and the
two are not the same measurement: the width grows because the snap smears
off-chart UV onto the patch edge. Neither figure is a rescaling of the other.

The three strips the section tabulated come out 99.91%, 99.70% and 98.41%
off-surface.

## Why there is anything to measure

`subRegions` and `deadRegions` are two descriptions of one patch edge, and they
are not built the same way:

| set           | built from                                           | then                            |
| ------------- | ---------------------------------------------------- | ------------------------------- |
| `subRegions`  | `boundaryVertexLoops` of the chart's triangles       | `simplifyLoop(SIMPLIFY_TOL_MM)` |
| `deadRegions` | `deadCS.intersect(chartCS)`, `chartCS` the RAW rings | `simplifyLoop(SIMPLIFY_TOL_MM)` |

So along a shared edge the dead set follows the real triangles and the claim
follows a Douglas-Peucker approximation of them. Subtracting the first from the
second cuts the outward half of that slack free as its own polygon.

The slack is not new and not a defect on its own — `SIMPLIFY_TOL_MM`'s own
comment says `CHART_SNAP_MM` covers it. What is new is it becoming a _standalone
piece_, which only happens where a dead region is there to cut it loose.

## What was measured

The oracle is the chart's own triangulation out of the shipped sidecar,
`chartTris` over `uv` — the same arrays `src/geometry/zoneCharts.ts` builds the
runtime mapper's `lookup` from. Nothing in the bake ever compared `subRegions`
against it, so this is not the boolean that made the pieces asked twice.

Per PIECE, never per chart, for the reason `measure-seam-overlap.mjs` records.

Two checks that the oracle is the oracle:

| check                                              | catches                          | result                     |
| -------------------------------------------------- | -------------------------------- | -------------------------- |
| chart footprint against summed triangle area       | self-overlap, cancelling winding | worst 0.0752%              |
| sampled point-in-triangle against the CrossSection | wrong fill rule, bad subtract    | worst 1.10pp at 2000/piece |

The second shares nothing with the first but the rings. The first is also what
would catch a chart whose triangle winding made `NonZero` cancel part of itself:
the union would then read under the summed area, and it does not.

## The population

| off-surface | pieces | their mm² |
| ----------- | ------ | --------- |
| ≥ 50%       | 14     | 16.080    |
| ≥ 90%       | 10     | 11.191    |
| ≥ 99%       | 7      | 7.240     |
| 100%        | 3      | 0.560     |

The table above prints four pieces at "100.00%" and this one counts three: the
fourth is `left/chair-wing-left#7` at 99.995%, rounded up for display.

All 14 sit on a chart that carries a dead region. That is the whole mechanism in
one line, and the control says the same from the other side:

| charts             | pieces | off-surface mm² | of      | shape                          |
| ------------------ | ------ | --------------- | ------- | ------------------------------ |
| with a dead region | 73     | 211.13          | 129,818 | cut loose into its own polygon |
| without one        | 14     | 649.41          | 218,825 | one piece each, slack attached |

**More off-surface area on the charts with no dead region, and no ribbons.** The
simplification slack is the same on both. Only the subtraction turns it into a
piece.

## The three the section tabulated

| piece                                | net mm² | width  | off % | depth mm |
| ------------------------------------ | ------- | ------ | ----- | -------- |
| `right/chair-wheel-mount-right#5`    | 3.159   | 0.1943 | 99.91 | 0.1942   |
| `left/chair-wheel-mount-left#4`      | 3.172   | 0.1950 | 99.70 | 0.1945   |
| `seat-left/chair-wheel-mount-left#2` | 2.860   | 0.1881 | 98.41 | 0.1872   |

Depth is how far past the patch edge the piece reaches. All three sit just under
`SIMPLIFY_TOL_MM` (0.2), which is what says they are the tolerance rather than
geometry.

## The driven run

A and B are the same build, the same port, the same browser and the same
full-bleed design bound to `Left side` at 400%. Only what `dist/` serves as the
sidecar differs: A is shipped, B has the 14 off-surface pieces deleted from
`cutRegions`.

`left/chair-wheel-mount-left#4` was the piece driven, because it is the one that
can be read: no other cut region of its zone comes within 6mm of it
(**0.0000mm²**), so ink near it can only have arrived through it.

|                                | A (shipped) | B (cleaned) |
| ------------------------------ | ----------- | ----------- |
| inlay vertices, whole export   | 88,053      | 87,856      |
| within 6mm of the snap point   | 40          | 0           |
| A-only on `Wheel mount (left)` | 131         | —           |

- The piece's UV centre snaps **0.105mm** to (170.0, 160.4, -298.7).
- The A-only cluster measures **1.000 x 0.211 x 32.543mm**.
- The nearest inlay vertex B still has on that part is **30.80mm** away. The
  mark vanished; it did not move.

`Wing (left)` also loses 58 A-only vertices, from
`left/chair-wing-left#7` (0.215mm², 100% off). Not attributed: that piece has
27.3mm² of other cut region within 6mm, so its ink cannot be told from real ink.

**The mechanism is `lookup` answering the nearest triangle at any distance.** UV
with no surface under it does not fall out of the cut. It snaps to the patch
edge and extrudes there. `netExcludedOverlayMesh`'s docstring already names this
behaviour as the reason it clips to `boundary()` first; the point missed until
now is that `boundary()` itself carries UV off the chart.

## Null results and wrong turns

- **Boundary attribution says nothing, and cost an afternoon.** Every piece's
  boundary lies on `subRegions` ∪ `deadRegions` with a neither-fraction of
  exactly 0 — true by construction, since the piece IS their difference. The
  50/50 split on the small pieces is a ribbon's signature but not evidence.
- **The independent check was first run on a broken sampler.** `seed * 1103515245`
  exceeds 2^53, so the LCG lost its low bits and repeated after 5,233 pairs. On
  `left/chair-wing-left#7`, whose bbox the rejection sampler accepts rarely, 2000
  nominal draws were 332 distinct points. Worst disagreement read 1.98pp; on
  mulberry32 it reads **1.10pp**. Nothing else moved — the population figures come
  from the boolean, not the sampler — but the one check that is not the boolean
  was the thing being blunted.
- **The isolation gate pooled every other piece into one EvenOdd section.**
  Charts of a zone do overlap (four pairs on `left`), and pooled that way each
  overlap reads as a hole, cancelling neighbourhood area — the one direction the
  gate must not err in. Unioned per piece now. The driven piece measures
  0.0000mm² either way, so no number here changed.
- **The first depth figure was wrong by 147x.** Nearest-triangle distance
  searched only triangles whose bbox met the piece's, so a point's real nearest
  triangle could be outside the search. It read 6.9452mm on a piece whose true
  reach is 0.0471mm. Bisecting on `piece.subtract(chart.offset(d)).isEmpty()`
  needs no search and is what the committed script does.
- **The edge/hole split is not clean, and the report does not need it to be.**
  Off-surface area inside the chart's filled silhouette is a hole the
  triangulation has and `subRegions` does not — dropped under
  `MIN_HOLE_AREA_MM2` or `MIN_HOLE_WIDTH_MM`, and logged by the bake. Deepest
  such reach 2.1511mm, about a 15mm² hole's inradius, as expected. But four
  components on the two wing charts read as EDGE at 0.7870-0.8510mm, past what
  Douglas-Peucker can move a boundary: 4.1949 and 4.4375mm² on `left`, 4.1876
  and 4.4969mm² on `right`, at v 5-10, mirrored, 17.317mm² in all. Each is
  under `MIN_HOLE_AREA_MM2` and pinches to the outer boundary, so it is
  dropped-hole in cause and edge in position. Bounded, located, and on the big
  `#0` piece rather than a ribbon, so no conclusion here rests on it.
- **A bridge between two components of a chart was the wrong guess for those
  four.** The left wing has a second component of 0.17mm², far too small and in
  the wrong place; the right wing has exactly one component and shows the same
  two excursions.
- **The covers file was never available.** `stubs/dead-zones.3mf` lives outside
  the repo, so the bake's own 3D cover classifier could not be re-run, and
  neither could `measure-wheel-shadow.mjs`. That is what made the sidecar's
  triangulation the oracle — and the answer turned out not to need a cover at
  all.
- **B is not the proposed fix.** It deletes the 14 pieces whole. The real fix
  would clip `cutRegions` to the chart, which keeps the on-surface part of a
  piece that is 56% off. For the 99.7% piece driven here the two are the same;
  for `seat-left/chair-wheel-mount-left#1` they are not.
- **Not measured: the other 13.** One piece was driven end to end. The rest are
  the same shape by the same mechanism, which is an argument, not a run.

## What this means for the tech-debt section

"Nothing says whether a thin cut-region strip is surface a cover hides" should
be **retitled and rewritten around a defect, not a question**. It is no longer
an open measurement — it is a known-wrong behaviour with a reproduction.

- Its premise is retired. A cover has nothing to do with it.
- The second candidate it carried, unmeasured — fix `subtractRegions` so it
  stops emitting a ribbon along a shared boundary — is now the fix, and it has
  a measurement.
- **Clipping `cutRegions` to `chartCS` at the bake** is the smaller change and
  is where the data is already right: `chartCS` is built three lines above the
  `subtractRegions` call.
- A re-bake is required to ship it, and a re-bake needs `stubs/dead-zones.3mf`.
  Fixing the code without re-baking would repeat #296's eighth-round finding
  exactly.
