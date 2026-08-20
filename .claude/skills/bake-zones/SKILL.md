---
name: bake-zones
description: Bake the design zones of a multi-design-surface part: write the zone config, weld the printed parts across their seams, segment and LSCM-unwrap each zone, and ship the sidecar plus per-zone true-size templates. Use when adding, retuning, or debugging zones for any kind with a zonesFile (the chair body), or when a zone's coverage, stretch or seams look wrong.
model: opus
---

# Bake a kind's design zones

[add-part](../add-part/SKILL.md) covers a part with **one** design face: the app
detects the largest flat patch and the SVG maps onto it. A body like the chair
has five design surfaces across eleven printed pieces, and no flat patch is any
of them. Those come from a **zone bake**, an offline unwrap whose committed
outputs (a sidecar plus per-zone templates) are the real artifacts.
[bake-zones.mjs](../../../scripts/bake-zones.mjs) is the reproducible recipe.

**This is inserted into add-part, not a replacement for it.** A new multi-zone
kind still goes through all six of its steps. Run this bake after **step 3**
(the kind must exist and its `libraryPartId`s be settled before a config can
name them) and before **step 6**: the per-zone templates emitted here are what
artists load, so they supersede the single-face `templateFile`. **Don't run
`gen-templates.mjs` for a zoned kind.**

Everything below was read out of
[zonebake.mjs](../../../scripts/lib/zonebake.mjs). Re-read it before trusting
any number here: the tolerances are the whole game and that file is the only
place they are true.

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
pose**: the bake applies no transform, so parts must already sit where they sit
on the finished chair. Order matters, and `bakeZones` refuses to run unless the
loaded parts match `config.parts` by id _and_ index.

Per zone, `validateConfig` enforces a unique `id`, a `name`, `maxAngleDeg` in
`(0, 180]`, and `up` as a 3-element array. Everything else fails later and
louder.

**`seedNormal` or `seedPoint`, one of them, and they are not interchangeable:**

- **`seedNormal`** seeds from the first area-ranked `detectFlatPatches` patch
  whose normal dots the direction **> 0.9**, the same test the app's own face
  selection uses, then grows against the **config** direction rather than the
  matched patch's, so the result doesn't hinge on which same-area patch won the
  tie. Right when the zone has a real flat face.
- **`seedPoint`** takes the triangle whose centroid is nearest that point and
  grows against **that triangle's** normal. Right when the surface is curved
  everywhere, which is why all five chair zones use it. It also means the seed
  triangle's tessellation sets the grow direction, so nudging the point can
  shift the zone more than expected.

`up` is a direction in the assembled frame, pulled back through the chart and
rotated to +v so "up" on the template is up on the part. It must lie _along_ the
surface: one nearly perpendicular to the zone everywhere aborts with `zone "up"
direction ... is nearly perpendicular to the surface everywhere`.

Optional overrides default to the constants in `zonebake.mjs`: `weldTolMm`
(`WELD_TOL_MM`, `1e-3`), `simplifyTolMm` (`SIMPLIFY_TOL_MM`, `0.2`),
`minHoleAreaMm2` (`MIN_HOLE_AREA_MM2`, `15`), `minIslandAreaMm2`
(`MIN_ISLAND_AREA_MM2`, `0.4`). **Leave them alone unless you have a
measurement.**

### seamWeldTolMm is the one that changes everything

Separately-printed parts are never coincident; they meet with real clearance. At
`WELD_TOL_MM` a zone can only grow to the edge of the part it seeded on.
`seamWeldTolMm` stitches vertices belonging to **different** parts within a much
looser distance, so zones span printed seams and artwork flows over the join.

It is deliberately separate from `weldTolMm`: raising that far enough to bridge
a 0.53mm seam collapses 63% of the vertices _inside_ each part and destroys the
surface the unwrap runs on. `validateConfig` rejects a `seamWeldTolMm` that
isn't strictly larger.

**`SEAM_WELD_TOL_MM = 0.6` is the chair's measured value, not a default.** It
clears the widest real contact gap (0.530mm, seat-center to seat-back-bottom)
while leaving the CAD assembly's rear brace unstitched (1.008mm from anything,
and not a part the app has), so no zone grows onto surface that can never be
cut. **Measure your own part's contact gaps; don't inherit 0.6 because it is
written down.**

Two guards keep stitching from wrecking the surface, and you should know what
they do _not_ cover:

- A pair only merges when the two parts' surface normals agree
  (`SEAM_NORMAL_DOT`, dot **> 0.3**), which rejects a tab facing into a slot. It
  does **not** reject two parts stacked parallel, same-facing, a clearance
  apart: those look exactly like one surface from here. Your protection is
  keeping the tolerance at the measured contact gap and reading the stitch
  counts.
- No merge may pull two vertices of the same part together through a shared
  neighbour.

**Turning `seamWeldTolMm` on re-tunes every zone**, since each now grows until
`maxAngleDeg` stops it rather than until the part runs out. Retune the angles in
the same change.

## 2. Run it

```bash
npx vite-node scripts/bake-zones.mjs scripts/zone-configs/<kind>.json
```

Exactly one argument; the script dies on zero or two. Paths inside the config
resolve from the repo root. Both outputs are committed:

- **`public/stl/<kindId>-zones.json`**, the sidecar. `schema: 2` (the _sidecar_
  schema, independent of the config's `schema: 1`) and it must match
  `SIDECAR_SCHEMA` in
  [zoneCharts.ts](../../../src/geometry/zoneCharts.ts).
- **`public/templates/<zoneId>-template.svg`**, one per zone, true-size at 1:1 mm.

The sidecar is written minified, but `public/` isn't in `.prettierignore`, so
the committed copy is prettier's: ~65k lines against the one line the script
emits. A fresh bake therefore leaves `npm run format:check` failing on a huge
generated artifact. Committing fixes it via lint-staged, but if you run
`ship-it` first, format only that file, never `npm run format`:

```bash
npx prettier --write public/stl/<kindId>-zones.json
```

The templates need no such step. Re-baking `chair-body.json` against the
committed 3MFs reproduces all six artifacts byte-for-byte after that format
(verified 2026-08-02), so a non-empty diff there is a real change, not noise.

## 3. Read the log, then tune

The loop: adjust `seedPoint`/`seedNormal`/`maxAngleDeg`, re-run, read the log
and warnings, repeat. **Open the templates too**; they show the actual coverage.

Each run logs the weld (`welded N part(s): V vertices, T triangles`), then **one
line per stitched seam pair** with its stitch count, ascending. **Read the small
ones:** a pair with a handful of stitches is a hinge, not a bridge, so the
unwrap pivots around it and any zone crossing there distorts. Then per zone:
triangle count, part count, lobe count, holes, seams, `stretch max`/`mean`, and
the fitted mm `scale`.

Two warnings print last with a `!` prefix. Neither stops the bake:

- **`max stretch <x> exceeds 1.1`** fires when max per-edge stretch (the larger
  of the length ratio and its inverse) passes `DISTORTION_WARN = 1.1`. Fix by
  lowering `maxAngleDeg` or splitting the zone, not by ignoring it. The chair's
  config records the measured knee: `back` at 55° wraps around the U onto both
  handles' inner faces and unwraps at 20×; at 35° it is 962cm² across 6 parts at
  1.13×. Those angles are measurements, which is why they aren't round numbers.
- **`dropped N sliver island(s) under 0.4mm²`**: a part's slice of a zone can be
  several disjoint islands, and anything past the largest and under
  `MIN_ISLAND_AREA_MM2 = 0.4` is discarded as tessellation dust. Note how far
  that sits below `MIN_HOLE_AREA_MM2 = 15`: a 15mm² interior loop is a fillet
  artifact worth closing, but a 15mm² _island_ is design surface. **A dropped
  island is the one failure with no runtime signal**, since artwork over it is
  silently intersected away, which is why it warns at all. A drop much larger
  than dust, or several, means the zone is fraying at its angle limit.

Errors that stop the bake:

| Error                                                                                                          | What it means                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no flat patch points along seedNormal [...]`                                                                  | Nothing passes the 0.9 dot. Use a `seedPoint`.                                                                                                                   |
| `seed patch has no triangles within maxAngleDeg`                                                               | The angle is too tight for the seed itself.                                                                                                                      |
| `is not a single connected island (N of M triangles reachable from the seed)`                                  | The zone leaked to a disconnected patch. Tighten `maxAngleDeg` or move the seed.                                                                                 |
| `N triangle(s) fold over in UV — the zone is too curved to unwrap as one chart; lower maxAngleDeg or split it` | A fold makes the chart unusable, so this is a hard stop rather than a stretch warning.                                                                           |
| `part "<id>" contributes triangles but no usable boundary loop`                                                | An empty `subRegions` would read at runtime as "no per-part clipping" and fall back to the whole zone outline: the exact failure `subRegions` exists to prevent. |
| `LSCM solve did not converge` / `LSCM solution collapsed to a point`                                           | A degenerate zone mesh, not a tuning problem.                                                                                                                    |

**Two sidecar fields are display-only and will mislead you if read as the clip
region.** `boundary` and `holes` are singular, so they carry only the zone's
**largest lobe**: the chair's `left` lobe is 22,944mm² of a zone whose per-part
regions sum to 124,797mm². Every chart's `subRegions` is what actually clips a
cutter.

## 4. Wire it into the kind

Set `zonesFile: '<kindId>-zones.json'` on the kind in
[kinds.ts](../../../src/assembly/kinds.ts), alongside `designFit: 'rect'` for
per-zone rect semantics: each zone's template maps 1:1 in mm centred on its
chart. The chair's entry is the example.

The sidecar records a `Math.fround`-narrowed bbox and triangle-count fingerprint
per part, and `fingerprintMatches` drops a part's zones at load when its mesh no
longer matches. So **re-pack a part, re-run this bake.** Same discipline as
add-part step 4's `bake-part-fingerprints.mjs`, different file: a re-pack that
skips this loses that part's zones, with the baked UV indices no longer
addressing the same vertices.

## Then

Verify in the app, not just the tests: load the kind, drop artwork on a zone
that spans a seam, and check it flows across the join and cuts on both parts.
Then run `ship-it`, whose step 3 runs `/code-review`. That is required on any
diff that changes code, and a zone that unwraps wrong still looks plausible in
the viewport, so expect to earn more than one round.
