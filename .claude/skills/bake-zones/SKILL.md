---
name: bake-zones
description: "Bake the design zones of a multi-design-surface part: write the zone config, weld the printed parts across their seams, segment and LSCM-unwrap each zone, and ship the sidecar plus per-zone true-size templates. Use when adding, retuning, or debugging zones for any kind with a zonesFile (the chair body), or when a zone's coverage, stretch or seams look wrong."
model: opus
---

# Bake a kind's design zones

[add-part](../add-part/SKILL.md) covers a part with **one** design face: the app
detects the largest flat patch and the SVG maps onto it. The chair has eight
design surfaces welded across ten of its eleven printed body pieces, and no flat
patch is any of them. (The seat pan is in no zone: the cushion covers it.) Those
come from a **zone bake**, an offline unwrap whose committed outputs (a sidecar
plus per-zone templates) are the real artifacts.
[bake-zones.mjs](../../../scripts/bake-zones.mjs) is the reproducible recipe.

**This is inserted into add-part, not a replacement.** A new multi-zone kind
still goes through all six steps. Run this bake after **step 3** (a config names
`libraryPartId`s, so the kind must exist) and before **step 6**: the per-zone
templates emitted here supersede the single-face `templateFile`. **Don't run
`gen-templates.mjs` for a zoned kind.**

The numbers below were read out of
[zonebake.mjs](../../../scripts/lib/zonebake.mjs). Re-read it before trusting
any: it is the only place the tolerances are true.

## 1. Write the config

One JSON file at `scripts/zone-configs/<kindId>.json`. Copy the shape from
[chair-body.json](../../../scripts/zone-configs/chair-body.json), the only
shipped example.

```json
{
  "schema": 1,
  "kindId": "chair-body",
  "seamWeldTolMm": 0.6,
  "parts": [{ "libraryPartId": "chair-seat-center", "file": "public/stl/chair-seat-center.3mf" }],
  "zones": [
    {
      "id": "seat",
      "name": "Seat",
      "seedPoint": [0, 230, -361],
      "maxAngleDeg": 50,
      "up": [0, 0, -1]
    }
  ]
}
```

`parts` are the packed 3MFs from add-part step 2, read in their **assembled
pose**: the bake applies no transform. Order matters: `bakeZones` refuses to run
unless the loaded parts match `config.parts` by id _and_ index.

Per zone, `validateConfig` enforces a unique `id`, a `name`, `maxAngleDeg` in
`(0, 180]`, and `up` as a 3-element array. Everything else fails later and
louder.

**`seedNormal` or `seedPoint`, one of them, and they are not interchangeable:**

- **`seedNormal`** seeds from the first area-ranked `detectFlatPatches` patch
  whose normal dots the direction **> 0.9** (the app's own face-selection test),
  then grows against the **config** direction, so the result doesn't hinge on
  which same-area patch won the tie. Right when the zone has a real flat face.
- **`seedPoint`** takes the triangle whose centroid is nearest that point and
  grows against **that triangle's** normal. Right when the surface is curved
  everywhere, which is why all five chair zones use it. The seed triangle's
  tessellation sets the grow direction, so nudging the point can shift the zone
  more than expected.

`up` is a direction in the assembled frame, rotated to +v so "up" on the
template is up on the part. It must lie _along_ the surface: one nearly
perpendicular to the zone everywhere aborts with `zone "up"
direction ... is nearly perpendicular to the surface everywhere`.

Optional overrides default to the constants in `zonebake.mjs`: `weldTolMm`
(`WELD_TOL_MM`, `1e-3`), `simplifyTolMm` (`SIMPLIFY_TOL_MM`, `0.2`),
`minHoleAreaMm2` (`MIN_HOLE_AREA_MM2`, `15`), `minIslandAreaMm2`
(`MIN_ISLAND_AREA_MM2`, `0.4`), `minHoleWidthMm` (`MIN_HOLE_WIDTH_MM`, `2`).
**Leave them alone unless you have a measurement.**

`minHoleWidthMm` is the one most likely to need lowering on a new part. It
throws out an interior loop whose `4 x area / perimeter` is under it, which is
how a fold in the unwrap is told from a hole in the part. The default has only
1.31x of margin over the chair's narrowest real hole. A genuinely narrower slot
needs it lowered — and the separation re-measured first, or the bake will report
a real slot as enclosing no width.

### claimWedge: the strip between two zones

Optional, `"claimWedge": true`, off by default. After every zone has grown to
its `maxAngleDeg`, an unclaimed connected component with **exactly two zones** on
its boundary is the strip left between them. Each of its triangles goes to
whichever zone's grow normal its own is nearer, grown from each zone's own edge
of the strip, so nothing joins a zone it is not connected to. Use it when two
zones have to **abut** rather than merely face each other, so one design can be
cut across the join.

**Read the census it logs first, then one line per strip, then one per
component it left alone.** A wedge rule that has started eating surface shows up
in the census. On the chair:

```
claimWedge: before the rule, of 332784 welded triangles 44613 are in a zone, 134 are
  degenerate, 288037 are in none
claimWedge: those 288037 form 383 component(s), by zones touched — 0: 0 comp / 0 tris,
  1: 380 comp / 74034 tris, 2: 2 comp / 315 tris, 3+: 1 comp / 213688 tris
claimWedge: the strip between "left" and "back" went 2 tris (2mm²) to the first,
  155 (551mm²) to the second, 2 (5mm²) reached by neither
claimWedge: the strip between "right" and "back" went 0 tris (0mm²) to the first,
  156 (541mm²) to the second, 0 (0mm²) reached by neither
claimWedge: left a 213688-triangle component (927946mm²) alone — it touches 8 zones
  (left, right, back, front, seat-left, seat-right, wing-left, wing-right), not two
claimWedge: after the rule, 313 triangle(s) went to a zone and 287724 are still in none
```

Every welded triangle is in exactly one class, so a missing count is visible.
Only the two-zone class can ever be handed out; a rule keyed on "touches a zone"
would have taken the 3+ component (the hidden interior) and the 380 one-zone
pockets besides.

A component touching three or more zones is always reported, and so is any
triangle of a strip that neither zone's front reached. **Both also go into the
returned `warnings`, not just the log**: no design can be placed on that
surface, and a caller reading the return value has to see it.

Raising `maxAngleDeg` instead does not work on the chair — every pair in
{45,50,55} x {35,40,45} breaks a stretch bar, claims a triangle twice, or both
([2026-09-04-seam-closing.md](../../../docs/findings/2026-09-04-seam-closing.md)).

### seamWeldTolMm is the one that changes everything

Separately-printed parts meet with real clearance. At `WELD_TOL_MM` a zone can
only grow to the edge of the part it seeded on. `seamWeldTolMm` stitches
vertices of **different** parts within a looser distance, so zones span printed
seams. It is separate from `weldTolMm` on purpose: raising that far enough to
bridge a 0.53mm seam collapses 63% of the vertices _inside_ each part and
destroys the surface the unwrap runs on. `validateConfig` rejects a
`seamWeldTolMm` that isn't strictly larger.

**`SEAM_WELD_TOL_MM = 0.6` is the chair's measured value, not a default.** It
clears the widest real contact gap (0.530mm, seat-center to seat-back-bottom)
and leaves the CAD assembly's rear brace unstitched (1.008mm from anything, not
a part the app has), so no zone grows onto surface that can never be cut.
**Measure your own part's contact gaps; don't inherit 0.6.**

Two guards keep stitching from wrecking the surface. Know what they miss:

- A pair only merges when the two parts' surface normals agree
  (`SEAM_NORMAL_DOT`, dot **> 0.3**), which rejects a tab facing into a slot. It
  does **not** reject two parts stacked parallel, same-facing, a clearance
  apart: those look like one surface from here. Your protection is keeping the
  tolerance at the measured contact gap and reading the stitch counts.
- No merge may pull two vertices of the same part together through a shared
  neighbour.

**Turning `seamWeldTolMm` on re-tunes every zone**: each now grows until
`maxAngleDeg` stops it, not until the part runs out. Retune the angles in the
same change.

### covers: what other parts hide

Optional. Marks the surface that covering parts (wheels, cushions) hide once
assembled, so it takes no artwork and no filament changes:

```json
"covers": {
  "file": "stubs/dead-zones.3mf",
  "referenceColor": "#F768E6FF",
  "bleedMm": 20,
  "mirrorAxis": "x"
}
```

- `file` is a whole-assembly CAD export holding the kind's own parts in one
  color (`referenceColor`) and every covering body in any other. Bodies carry no
  usable names, so color is the only distinction. The file may sit in `stubs/`
  (untracked); the bake **hard-fails without it** rather than silently baking a
  sidecar with nothing hidden.
- The export's frame need not match the bake frame: reference bodies are matched
  to the config parts by bounding box and the transform is solved from their
  consensus, refused above 1mm residual.
- `solids` (optional) replaces cover bodies with a declared primitive, posed
  from the file. One entry names an `axis`, a `radiusMm`, and the `replacesDims`
  bbox of the bodies it stands in for; matched bodies whose boxes overlap become
  one solid, and the radius is checked against their own diameter so a wrong
  number fails the bake. Use it when the CAD body is the printed part rather than
  the thing that blocks the view: the chair's wheel arrives as two hollow halves
  with spoke openings, and rays reached its far wall through its own holes until
  one solid 280mm disc replaced them.
- `mirrorAxis` (optional, `x`/`y`/`z`) snaps mirror-paired cover bodies onto
  exactly mirrored POSES about that axis before classification. A CAD export
  lands each instance a fraction of a millimetre off its mirror image, enough to
  flip a knife-edge sample from hidden to visible. A cover with no mirror partner
  (a cushion straddling the plane) is left alone.
- **The pose only.** Each body keeps its own mesh: rebuilding one side from the
  other's mirror is wrong for a pair mounted by rotation. The chair's casters are
  the same part turned 180 degrees, and mirroring one onto the other moved
  geometry 21.976mm (`npx vite-node scripts/measure-caster-axis-map.mjs`, which
  takes `solids` off first, since the chair's discs replace those bodies and a
  disc pair mirrors exactly). The worst shape residual of a pair is reported in
  the bake log, never enforced.
- Each zone is sampled at ~`COVER_SAMPLE_MM2` (25mm²) per sub-cell, not per
  triangle — CAD faces arrive as coarse fans, and a per-triangle verdict can't
  draw a shadow edge inside one. A sample is hidden when either:
  - a cover sits within `COVER_CONTACT_MM` (2.5mm) straight out along the
    sample's normal — touching plastic, checked first as the cheap answer for
    what a cushion rests on; or
  - its outward hemisphere is mostly blocked: `COVER_HEMI_DIRS` (32)
    cosine-weighted rays are cast out to `COVER_RAY_MM` (120mm), and the sample
    is hidden once `COVER_HIDDEN_FRACTION` (0.85) of them hit a cover. A single
    along-normal ray only caught triangles whose own normal aimed at the cover,
    leaving a curved surface (a wheel's fender arch) speckled instead of one
    clean shadow.
- A cover that RESTS on parts (contact within `COVER_CONTACT_MM`) hides only on
  the parts it rests on. One resting on nothing hides wherever it occludes.
  Handing it to the single part holding the largest share of its nearest surface
  gave each chair wheel its mount and nothing else, cutting its shadow off along
  a straight line down the mount/fender seam. The hemisphere test already
  answers the question; a second guess only subtracted right answers.
- Both the covered and the visible set are closed-then-opened at a
  `DEAD_SMOOTH_MM` (5mm) radius FIRST, to clear the sampling grid's staircase,
  and only then is the visible set grown by `bleedMm` and subtracted. That order
  is load-bearing: bleeding first dilates the staircase and takes 2 x `bleedMm`
  out of the dead region, enough to lose a whole narrow strip (on the chair, one
  fender's entire wheel shadow). `bleedMm` keeps artwork running that far past
  the visible edge, so a slightly shifted cover never reveals blank plastic. A dead island under
  `MIN_DEAD_AREA_MM2` (15mm²) is then dropped.
- Output: per-chart `deadRegions` in the sidecar (schema 3), subtracted from
  the artwork clip at runtime, drawn hatched on templates and in the viewport.
- The bake log prints `dead <area>mm²` per zone. A zone whose surface faces
  away from every cover correctly reports 0.
- The constants above and the measurements that chose them live in
  [zonebake.mjs](../../../scripts/lib/zonebake.mjs). Re-read before retuning.

## 2. Run it

```bash
npx vite-node scripts/bake-zones.mjs scripts/zone-configs/<kind>.json
```

Exactly one argument. Paths inside the config resolve from the repo root. Both
outputs are committed:

- **`public/stl/<kindId>-zones.json`**, the sidecar. `schema: 4` (the _sidecar_
  schema, independent of the config's `schema: 1`) and it must match
  `SIDECAR_SCHEMA` in
  [zoneCharts.ts](../../../src/geometry/zoneCharts.ts).
- **`public/templates/<zoneId>-template.svg`**, one per zone, true-size at 1:1 mm.
  A self-mirrored zone's template also gets a dashed centre line.

A config's top-level `mirrorAxis` (distinct from `covers.mirrorAxis`, which only
snaps cover bodies) pairs zones whose `seedPoint`s reflect across that axis as
mirror twins, or marks a zone seeded on the plane as self-mirrored; the bake
writes the relation and a measured registration residual into each zone's
`mirror` field.

The sidecar is written minified, but `public/` isn't in `.prettierignore`, so the
committed copy is prettier's: ~65k lines against the script's one. A fresh bake
leaves `npm run format:check` failing on that file. Committing fixes it via
lint-staged; if you run `ship-it` first, format only that file, never
`npm run format`:

```bash
npx prettier --write public/stl/<kindId>-zones.json
```

The templates need no such step. Re-baking `chair-body.json` against the
committed 3MFs reproduces all six artifacts byte-for-byte after that format
(verified 2026-08-02), so a non-empty diff is a real change.

## 3. Read the log, then tune

Adjust `seedPoint`/`seedNormal`/`maxAngleDeg`, re-run, read the log and
warnings, repeat. **Open the templates too**; they show the actual coverage.

Each run logs the weld (`welded N part(s): V vertices, T triangles`), then **one
line per stitched seam pair** with its stitch count, ascending. **Read the small
ones:** a pair with a handful of stitches is a hinge, not a bridge, so the unwrap
pivots around it and any zone crossing there distorts. Then per zone: triangle
count, part count, lobe count, holes, seams, `stretch max`/`mean`, and the
fitted mm `scale`.

Four kinds of warning print last with a `!` prefix. None stops the bake. The
chair emits four lines across the last two, reporting six dropped folds: five on
`back`'s display outline and one on `front`'s, plus two per handle chart in
`back`'s clip regions.

- **`max stretch <x> exceeds 1.1`** fires when max per-edge stretch (the larger
  of the length ratio and its inverse) passes `DISTORTION_WARN = 1.1`. Fix by
  lowering `maxAngleDeg` or splitting the zone. The chair's config records the
  measured knee: `back` at 55° wraps around the U onto both handles' inner faces
  and unwraps at 20×; at 35° it is 962cm² across 6 parts at 1.13×. Those angles
  are measurements, hence not round.
- **`dropped N sliver island(s) under 0.4mm²`**: a part's slice of a zone can be
  several disjoint islands; anything past the largest and under
  `MIN_ISLAND_AREA_MM2 = 0.4` is discarded as tessellation dust. That sits far
  below `MIN_HOLE_AREA_MM2 = 15`: a 15mm² interior loop is a fillet artifact
  worth closing, but a 15mm² _island_ is design surface. **A dropped island is
  the one failure with no runtime signal** (artwork over it is silently
  intersected away), which is why it warns. A drop much larger than dust, or
  several, means the zone is fraying at its angle limit.
- **`dropped N fold(s) under 2mm mean width ... from the clip region's holes`**:
  an interior loop that doubles back on itself, enclosing perimeter but no width,
  which the area test alone passes. The chair's two handle charts on `back`
  carried two each. This runs **opposite** to the island warning: a hole that
  stops being punched _adds_ clip region. That is intended, but the clip region
  is still moving, so it says so.
- **`dropped N fold(s) ... from the display outline's holes`**: the same test on
  the zone-level `boundary`/`holes`, the display outline, which nothing cuts
  against. Counts differ from the line above on purpose — the outline chains
  across stitched seams and fans into folds the per-part regions never see, six
  against four on the chair. Cosmetic.

Errors that stop the bake:

| Error                                                                                                          | What it means                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `no flat patch points along seedNormal [...]`                                                                  | Nothing passes the 0.9 dot. Use a `seedPoint`.                                                                                                  |
| `seed patch has no triangles within maxAngleDeg`                                                               | The angle is too tight for the seed itself.                                                                                                     |
| `is not a single connected island (N of M triangles reachable from the seed)`                                  | The zone leaked to a disconnected patch. Tighten `maxAngleDeg` or move the seed.                                                                |
| `two zones grew onto the same triangles ... share N`                                                           | Two zones' limits overlap, so artwork would be cut into both charts. Lower one, or move a seed.                                                 |
| `zone config has key(s) nothing reads: ...`                                                                    | A typo in a top-level key. The message lists every key the bake reads; `_note` is the only free-form one.                                       |
| `N triangle(s) fold over in UV — the zone is too curved to unwrap as one chart; lower maxAngleDeg or split it` | A fold makes the chart unusable, so this is a hard stop rather than a stretch warning.                                                          |
| `part "<id>" contributes triangles but no usable boundary loop`                                                | An empty `subRegions` would read as "no per-part clipping" and fall back to the whole zone outline, the failure `subRegions` exists to prevent. |
| `LSCM solve did not converge` / `LSCM solution collapsed to a point`                                           | A degenerate zone mesh, not a tuning problem.                                                                                                   |

**Two sidecar fields are display-only; don't read them as the clip region.**
`boundary` and `holes` carry only the zone's **largest lobe**: the chair's `left`
lobe is 22,941mm² of a zone whose per-part regions sum to 124,728mm² (the sum the
`splits each zone into per-part clip regions that together cover it` test in
`tests/chair-zones.test.ts` computes). Every chart's `subRegions` is what
actually clips a cutter.

## 4. Wire it into the kind

Set `zonesFile: '<kindId>-zones.json'` on the kind in
[kinds.ts](../../../src/assembly/kinds.ts), alongside `designFit: 'rect'` for
per-zone rect semantics: each zone's template maps 1:1 in mm centred on its
chart. The chair's entry is the example.

The sidecar records a `Math.fround`-narrowed bbox and triangle-count fingerprint
per part, and `fingerprintMatches` drops a part's zones at load when its mesh no
longer matches. So **re-pack a part, re-run this bake.** Same discipline as
add-part step 4's `bake-part-fingerprints.mjs`, different file: skipping it loses
that part's zones, since the baked UV indices no longer address the same
vertices.

## Then

Verify in the app, not just the tests: load the kind, drop artwork on a zone that
spans a seam, and check it flows across the join and cuts on both parts. Then run
`ship-it`, whose step 3 runs `/code-review` (required on any code diff). A zone
that unwraps wrong still looks plausible in the viewport, so expect more than one
round.
