# Closing the flank/back gap on the chair

**The flanks and the back can be made to abut, and a design can cross the join — but not by
raising an angle limit.** All nine `maxAngleDeg` pairs failed a bar. A new segmentation rule,
`claimWedge`, closes the gap at the shipped angles and registers across it at **1.81mm / 1.58mm
rigid p95**, inside `CHART_SNAP_MM` (3). It is applied; the sidecar and templates are rebaked.

- Branch `seam-closing` off `69afabf`, WSL2, node via `npx vite-node`.
- Phase B gets a real seam on `left ↔ back` and `right ↔ back`, and only there. Every other zone
  pair is unchanged: fenders are still 26° out, `front` still meets nothing within 10mm.
- The seam is **122mm long**, not the whole flank/back edge: on the shipped bake the 54 (left) and
  62 (right) shared vertices span y 337..459 at x ±158..170, z −505..−488 — 20 × 122mm of `left`'s
  642 × 509mm sheet. Phase B must not draw the rest of that edge as continuous.

## What was measured

| Command                                                                     | Produces                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `npx vite-node scripts/measure-zone-seams.mjs`                              | the seam table for a sidecar (all 56 pairs)                  |
| `npx vite-node scripts/measure-zone-mirror.mjs`                             | the mirror residuals the sidecar records                     |
| `npx vite-node scripts/bake-zones.mjs scripts/zone-configs/chair-body.json` | the shipped rebake, and the `claimWedge:` census lines below |

The sweep itself ran from an uncommitted scratch script, and is 15 lines of committed library:
read each `config.parts` file with `read3MFIndexed`, `delete config.covers`, set the three
`maxAngleDeg`, call `bakeZones(config, parts, log, {})`, then read `zone.distortion` off the
returned sidecar and `measureZoneSeam(zoneSeamPoints(a), zoneSeamPoints(b))` across it. Dropping
the covers changes no figure in this report: the no-cover bake at 45/35 reproduces the shipped
`distortion` on all eight zones exactly (`left` 1.2242 / 1.0142, `right` 1.2259 / 1.0159).

## Bars

Per-zone stretch max ≤ 1.2259 and mean ≤ 1.0159 (the shipped worst zone, `right`); `flipped` = 0;
no triangle claimed by two zones; the zones **abut**; and the rigid registration across the shared
seam ≤ `CHART_SNAP_MM` = 3.

## Candidates

`left`/`right` `maxAngleDeg` × `back` `maxAngleDeg`. Stretch is max / mean. Gap and shared-vertex
figures are `left → back` / `right → back`. `flipped` is 0 everywhere: `bakeZones` throws on a
fold, and no candidate threw.

| candidate                  | left                | right               | back                | double claims                   | median gap    | shared      | shared rigid p95 | verdict                    |
| -------------------------- | ------------------- | ------------------- | ------------------- | ------------------------------- | ------------- | ----------- | ---------------- | -------------------------- |
| 45 / 35 (shipped)          | 1.2242 / 1.0142     | 1.2259 / 1.0159     | 1.1341 / 1.0057     | none                            | 8.1 / 6.6     | 10 / 10     | 2.48 / 2.42      | does not abut              |
| 45 / 40                    | 1.2242 / 1.0142     | 1.2259 / 1.0159     | 1.2261 / 1.0090     | none                            | 8.0 / 6.4     | 12 / 12     | 3.86 / 3.81      | back stretch, p95, no abut |
| 45 / 45                    | 1.2242 / 1.0142     | 1.2259 / 1.0159     | 1.5810 / 1.0149     | none                            | 0.0 / 0.0     | 55 / 64     | 2.27 / 1.99      | abuts; back stretch 1.5810 |
| 50 / 35                    | 2.5429 / 1.2342     | 3.4705 / 1.1170     | 1.1341 / 1.0057     | none                            | 3.4 / 3.1     | 22 / 22     | 1.70 / 1.68      | flank stretch              |
| 50 / 40                    | 2.5429 / 1.2342     | 3.4705 / 1.1170     | 1.2261 / 1.0090     | none                            | 1.7 / 1.2     | 34 / 34     | 69.32 / 56.59    | flank stretch, p95         |
| 50 / 45                    | 2.5429 / 1.2342     | 3.4705 / 1.1170     | 1.5810 / 1.0149     | left/back 196, right/back 183   | 0.5 / 4.1     | 155/153     | 73.35 / 60.79    | everything                 |
| 55 / 35                    | 1.4400 / 1.0488     | 1.3728 / 1.0413     | 1.1341 / 1.0057     | flank/fender 18 each            | 2.5 / 2.8     | 37 / 36     | 35.47 / 34.33    | flank stretch, claims, p95 |
| 55 / 40                    | 1.4400 / 1.0488     | 1.3728 / 1.0413     | 1.2261 / 1.0090     | + left/back 42, right/back 32   | 2.2 / 2.3     | 68 / 59     | 38.97 / 37.88    | everything                 |
| 55 / 45                    | 1.4400 / 1.0488     | 1.3728 / 1.0413     | 1.5810 / 1.0149     | + left/back 254, right/back 228 | 1.9 / 6.5     | 194/185     | 32.92 / 31.33    | everything                 |
| **45 / 35 + `claimWedge`** | **1.2244 / 1.0142** | **1.2259 / 1.0159** | **1.1341 / 1.0056** | **none**                        | **0.0 / 0.0** | **54 / 62** | **1.81 / 1.58**  | **passes every bar**       |

Wall time per bake, no covers: 89.0 to 156.9s (45/35 ran 84.4s and 95.2s on two occasions, so read
these to ±10%). The nine cost 19.4 minutes; the `claimWedge` bake was 78.4s. The shipped rebake,
covers on, took 72.6s.

## Why no angle pair works

The two seed normals are **exactly perpendicular** — `left` grows against `[1,0,0]` and `back`
against `[0,0,-1]`, both read off the seed triangle. So the fillet between them spans 90° of
normal, and 45 + 35 leaves a 90 − 45 − 35 = 10° band of it in no zone. Covering that band needs
the two limits to sum past 90, and every way of getting there costs more than the band is worth:

- **`back` past 35°** is the config note's own measurement, confirmed: 1.1341 at 35, 1.2261 at 40,
  1.5810 at 45. The bar is 1.2259, so even 40 misses by 0.0002.
- **the flanks past 45° are not monotonic.** 45 → 1.2242, 50 → **2.5429**, 55 → 1.4400. The
  "stretch doubles per 5°" prior is wrong here: at 50 the flank reaches a piece of the wheel mount
  that the LSCM cannot flatten with the rest, and at 55 it reaches enough further that the chart
  recovers. A sweep that stopped at the first bad number would have called 55 worse than 50.
- **55° also starts double-claiming.** Each flank takes 18 triangles the fender already owns, which
  is the same failure the config note recorded at 50° for the wing seeds.

## `claimWedge`

An unclaimed connected component with **exactly two zones** on its boundary is the strip between
them; every triangle in it goes to whichever of the two grow normals its own is nearer, grown from
each zone's own edge of the strip so the result stays connected. Opt-in per config
(`"claimWedge": true`); a kind without it segments exactly as before.

On the chair it moves two strips and nothing else:

```
claimWedge: the strip between "left" and "back" went 2 tris (2mm²) to the first,
  155 (551mm²) to the second, 2 (5mm²) reached by neither
claimWedge: the strip between "right" and "back" went 0 tris (0mm²) to the first,
  156 (541mm²) to the second, 0 (0mm²) reached by neither
```

Almost all of it goes to `back`, because at 45° the flank already reaches most of the way round the
fillet and `back` at 35° does not. `left` gains 2 triangles where `right` gains 0 — the two storage
boxes are tessellated differently — which is a 2mm² asymmetry, and it is what moves the flanks'
mirror residual below.

## Null results and wrong turns

- **The bake did not refuse a double claim.** The plan's bar said it did; nothing in `bakeZones`
  checked it. Three of the nine candidates claim triangles twice and would have baked a sidecar
  that cuts the same artwork onto both zones with no warning, and `claimWedges`' first-wins
  ownership would then have hidden it. `assertNoDoubleClaim` now refuses one before the wedge rule
  runs, naming the two zones and the count. The shipped bake has none.
- **The nearest-point fit is the wrong measure for this bar, by a factor of 3.** Pairing A's
  boundary vertices with whatever B has within 10mm reads 8.81mm p95 on the shipped `left → back`,
  where the 10 vertices the two zones genuinely SHARE read 2.48. Most of a boundary vertex's
  neighbours within 10mm are not on the seam at all. `measureZoneSeam` now reports both, and the
  script's `shared rigid` column is the one the bar is about.
- **The plan's `front → back` row conflated the two directions.** `front → back` is 0/0/0/**191**
  of 1,677 at a 19.5mm median; the 231 and the 19.6mm it listed belong to `back → front`. The
  other pinned rows reproduce exactly, so the boundary-vertex definition is right.
- **Chart-local boundary edges overcount on a part that ships coincident duplicate vertices**
  (review round 4). An interior edge split across such a pair reads as two once-used edges, so a
  few interior vertices were marked boundary. Counting edge use on position-welded ids moves the
  boundary totals — `left` 2,323 → 2,322, `right` 3,098 → 3,096, `back` 3,683 → 3,674 — and
  `back → front` within 20mm from 231 to 223. No gap median, fit, or shared figure moved.
- **`back → left`'s median reads 8.2mm here against the plan's 8.3.** 58 gaps is an even count and
  `measureZoneSeam` averages the two middle values where the earlier run took the upper one. Every
  odd-count row (69, 73, 43 pairs) agrees to the digit.
- **The per-triangle reading of the wedge rule does nothing.** Only 5 of the chair's 288,037
  unclaimed triangles touch two zones across an edge, and iterating that rule to fixpoint claims 8
  in three passes and stops — the strip is two triangles wide almost everywhere, so its middle row
  never sees a second zone. Whole components need no iteration either: two unclaimed components
  adjacent to each other would be one component.
- **The two-zone gate is the whole safety of the rule, not caution.** The bake logs the census
  these figures come from, so they re-derive with the rebake command above:

  ```
  claimWedge: before the rule, of 332784 welded triangles 44613 are in a zone, 134 are degenerate,
    288037 are in none
  claimWedge: those 288037 form 383 component(s), by zones touched — 0: 0 comp / 0 tris,
    1: 380 comp / 74034 tris, 2: 2 comp / 315 tris, 3+: 1 comp / 213688 tris
  claimWedge: left a 213688-triangle component (927946mm²) alone — it touches 8 zones
    (left, right, back, front, seat-left, seat-right, wing-left, wing-right), not two
  claimWedge: after the rule, 313 triangle(s) went to a zone and 287724 are still in none
  ```

  The three classes account for every welded triangle (44,613 + 134 + 288,037 = 332,784, and
  74,034 + 315 + 213,688 = 288,037), which is the point of printing the degenerate count. The
  two strips are the whole of the two-zone class. A rule keyed on "touches a zone" would have taken
  the 3+ component — the hidden interior — and the 380 one-zone pockets besides. Every component
  touching three or more zones is reported, since which zone should own it is the config's
  question, and both it and any triangle a strip's fronts could not reach reach the caller as a
  `warnings` entry rather than only the log.

- **Assigning the strip by normal alone breaks the bake.** The first version marooned one triangle
  in `back`'s half whose normal preferred `left`, and `assertSingleIsland` refused the bake: zone
  "left" is not a single connected island, 10,095 of 10,096 triangles reachable from the seed.
  Growing from each zone's own front instead makes connectivity structural. It costs 2
  triangles (5mm²) on the left strip that neither front reaches; they stay unclaimed and the bake
  says so.

## What the rebake moved

`"claimWedge": true` is on `scripts/zone-configs/chair-body.json` and the bake was re-run with
covers (`npx vite-node scripts/bake-zones.mjs scripts/zone-configs/chair-body.json`, then prettier
on the sidecar only). Two of the eight templates changed: `back` and `left`. `right` is
byte-identical, because its strip went entirely to `back`.

| zone   | chart tris          | stretch max / mean                    | UV bounds                                 | clip region              |
| ------ | ------------------- | ------------------------------------- | ----------------------------------------- | ------------------------ |
| `back` | 12,952 → **13,263** | 1.1341 / 1.0057 → 1.1341 / **1.0056** | 315.40 × 437.07 → **349.90** × 437.07     | 96,256 → **97,319**mm²   |
| `left` | 10,093 → **10,095** | 1.2242 / 1.0142 → **1.2244** / 1.0142 | 642.033 × 509.218 → **642.035** × 509.217 | 124,730 → **124,728**mm² |

`back` gains 1,063mm² of clip region against the 1,092mm² of strip it was handed, the difference
being 0.2mm of loop simplification along the new edge.

**A saved design on `back` barely moves, despite the sheet being 34.5mm wider.** Placement anchors
on the zone's UV bbox centre, which went 157.70 → 174.95mm; but the strip was added at BOTH
corners, so the chair's own x = 0 centre line went 157.65 → 175.11 in the same chart (mean u over
the 59 chart vertices within 0.5mm of x = 0). The anchor was 0.05mm off that line and is now
0.16mm off it the other way, so it moved 0.21mm across the chair. `maxV` moved 0.0003mm, so
nothing moves vertically at all. Everything else is unchanged: `right`,
`front`, both seat sides and both fenders keep their triangle counts, stretch, bounds and dead
regions to the digit, all 12 charts still carry dead regions, and the dead areas are the same
(`left` 27,174mm², `right` 27,009mm², 0.61% apart).

### Mirror residuals after the rebake

`npx vite-node scripts/measure-zone-mirror.mjs`, all reproducing the sidecar with no MISMATCH:

| zone          | pairs                      | rms               | p95               | max               |
| ------------- | -------------------------- | ----------------- | ----------------- | ----------------- |
| left → right  | 5,146 of 6,166             | 0.178             | 0.268 → **0.266** | 0.632 → **0.633** |
| right → left  | 5,521 of 7,551             | 0.190 → **0.189** | 0.292 → **0.289** | 0.728 → **0.726** |
| back (self)   | 7,248 → **7,428** of 8,404 | 0.150 → **0.504** | 0.353 → **0.761** | 1.162 → **1.349** |
| front (self)  | 3,708 of 3,747             | 0.815             | 0.647             | 7.510             |
| seat, fenders | unchanged                  | unchanged         | unchanged         | unchanged         |

`back`'s self-reflection is the one that moved, and it moved because the two strips are not each
other's mirror: 155 triangles on the left against 156 on the right, since the two storage boxes are
tessellated differently. 0.761mm p95 is a quarter of `CHART_SNAP_MM`, so the bake raises no mirror
warning, but the pin in `tests/chair-zones.test.ts` went from 0.2 to 0.7.

### Guards added with it

Both were found by this sweep rather than by the shipped bake, and both fail without their fix
(`tests/zone-bake.test.ts`, on the analytic quarter cylinder):

- `assertNoDoubleClaim`, above. Two zones seeded at the cylinder's two ends at 60° overlap over 30°
  of arc and are now refused; at 40° they bake and no triangle is claimed twice.
- `validateConfig` refuses a top-level key nothing reads. `claimWedges` for `claimWedge` costs
  nothing to type and would have baked the chair with the strip still in no zone, silently.

### Other pins moved

- `tests/chair-zones.test.ts`: `back`'s mirror rms bound 0.2 → 0.7, with the new figures in the
  comment. Nothing else needed changing — 62 of its 63 tests passed on the new bake untouched.
- The worst uncovered claim depth is 2.150mm (`right/chair-wing-right`), 2.104
  (`back/chair-seat-back-top`), 2.101 (`left/chair-storage-left`), against 2.150 / 2.104 / 2.102
  before. `CHART_SNAP_MM` keeps its headroom.
- Three counts quoted in comments were **already stale before this change** and are now the
  measured ones: the overlapping part pairs are 20, not 23 (20 on the pre-rebake sidecar too);
  `left`'s per-part regions sum to 124,728mm², not 124,797; and `conformal.ts` said 25 chair charts
  where there are 26, before and after. `docs/findings/seam-sliver-sighting.md` still says 23 and
  stays that way: a finding is pinned to its run.
