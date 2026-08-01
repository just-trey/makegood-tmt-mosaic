# Chair body: multi-zone conformal artwork + pattern library

This is the design plan for onboarding the MakeGood TMT chair main body with
per-zone conformal artwork, and for the general multi-zone capability it is
built on. It is tracked in-repo (not just in a local planning file) so the work
survives across machines and sessions.

## Status (living checklist)

Phases 1–4 are the general capability; phase 5 is the chair itself; phase 6
(pattern library + fill mode) is the last phase in this plan — there is
nothing else queued behind it here.

- [x] **P1 — Zone abstraction refactor** (`ZoneMapper`/`FlatZoneMapper`, `implicitZoneFor`) — #57
- [x] **P2 — Artwork instances: state + UI** — #58 (state model), #59 (artwork list panel)
- [x] **P3 — Conformal warp engine** (`src/geometry/conformal.ts`, `ConformalZoneMapper`) — #60
- [x] **P4 — Automated zone bake tooling** (`scripts/bake-zones.mjs`, `scripts/lib/zonebake.mjs`) — #61
- [x] **P5 — Chair onboarding + zone picking** — shipped as more PRs than
      originally scoped (real per-part geometry issues surfaced along the way):
  - [x] Pack the 15 pieces + `parts.json` + verification test — #62
  - [x] Hidden `chair-body` kind + Standard/Kit variant model — #63
  - [x] Bake chair design zones + runtime chart loader — #64
  - [x] Fix packed-mesh vertex precision that made two chair parts uncuttable — #65
  - [x] Cut artwork onto baked conformal zones — #66
  - [x] Fix pinch-vertex loop chaining in the zone bake — #67
  - [x] Bind artwork to design zones in the assembly build — #68
  - [x] Multi-source artwork list: per-instance zone targeting — #69
  - [x] Viewport zone picking — #70
  - [x] Chair hardware variant selector (Standard/Kit UI) — #71
  - [x] Unhide the chair body; retire the standalone `wheel-mount-left` kind — #72
- [x] **P6a — Fill engine + Sticker/Fill toggle** — #73
- [x] **P6b — Pattern library (Cow/Dalmatian/Zebra/Tiger)** — #74
- [x] **P7 — Real-chair defect pass + full-coverage zones** — using the shipped
      feature on the actual chair surfaced four code defects and, more
      importantly, that every zone was trapped on the single part it seeded on:
  - [x] Four defects: gizmo ignoring the active artwork's zone, sidecar-fetch
        failure degrading to flat stamping, stale palette settings surviving a
        new design, and the Zebra pattern not tiling — #75
  - [x] Per-part clip regions in the sidecar (`subRegions`, schema 2) — #76
  - [x] Cross-part seam weld (`seamWeldTolMm`), opt-in — #77
  - [x] Enable the seam weld, re-author the zone set, label templates — #78

Once #78 merges, this plan is **complete**. Decisions that were open earlier
and have since been made:

- **`wheel-mount-left` was retired** (#72) rather than reconciled with the
  chair's own wheel-mount parts — they're separate files in separately-verified
  poses, as anticipated below.
- **Slicer/export placement for the chair is still deferred** — the chair's 13
  parts export through the generic centered path with no baked pose (see
  README's Known limitations). This was scoped out of this plan from the start
  and remains open as a separate future task, not blocking anything here.

---

## Context

The MakeGood TMT **chair main body** is the next part to onboard. The reference `stubs/Main Chair Body.stl` (18.7 MB, 374,260 triangles, Fusion-exported) is the _welded assembly_; the user instead provides **one CAD STL per printed piece** (side panels, back, seat, etc.), which the app loads in their assembled pose — like the wheel's halves, but more pieces. The monolith STL stays as the pose/alignment reference. This part breaks the app's core assumption: today there is exactly **one design + one placement in global state**, orthographically projected along Y onto **one** detected flat patch per part. The chair has multiple large design surfaces on different axes (left side, right side, back, seat, top), and the user wants:

1. Different artwork on different sides.
2. **True conformal wrap** — a sticker near a rounded edge follows the surface like real vinyl (chosen over cheaper projection).
3. A **built-in pattern library** (tileable cow / dalmatian / zebra / tiger SVGs) with a "fill zone" mode.
4. Built as a **general capability** (any part can declare multiple design zones), not chair-specific.

Slicer/export placement baking for the chair is **explicitly deferred** to a later task (needs a verified reference 3MF).

## Architecture (as shipped)

**Baked UV design zones + runtime Manifold warp.** No runtime unwrapping — matches the repo's bake-don't-derive philosophy.

- Each multi-face kind ships with script-baked UV-unwrapped charts ("design zones"), stored in an **assembly-level sidecar** (`public/stl/<kind>-zones.json`) because a zone's chart may **span triangles from multiple printed parts**. UVs are true-to-size mm (1 UV unit = 1 mm). Charts are unwrapped over the parts in their assembled pose; each chart triangle records which part it belongs to.
- At runtime, artwork regions are computed in the zone's flat 2D mm space exactly like today (turf clip to chart boundary), extruded into a flat prism in (u, v, depth), refined with `Manifold.refineToLength`, then bent onto the surface with `Manifold.warpBatch`: each vertex (u,v,h) → S(u,v) + h·N̂(u,v) via barycentric lookup into the chart. The warped cutter feeds the existing difference/intersection pipeline unchanged.
- **Per-part splitting for cross-seam artwork**: when a zone spans several printed parts, the placed regions are additionally clipped against each part's UV sub-region, producing one warped cutter per part; each is booleaned against its own part's manifold and its inlays export under that part's object. The seam line in UV space is baked into the sidecar. Physical color alignment at the seam depends on print/assembly tolerance — documented limitation, not solvable in software.
- **Verified**: manifold-3d 3.5.1 exposes `warp`, `warpBatch`, `refine`, `refineToLength` — no new dependencies.
- Export side needs no redesign: `build3MFCombined` already emits N inlay shells per object.

### Zone sidecar schema (assembly-level: `public/stl/<kind>-zones.json`)

```jsonc
{
  "schema": 2,
  "kindId": "chair-body",
  // guard: per referenced part, refuse to load zones against a mesh they weren't baked for
  "meshes": { "chair-side-left": { "triangleCount": 31240, "bboxHash": "…" } /* … */ },
  "zones": [
    {
      "id": "chair-left",
      "name": "Left side",
      "templateFile": "chair-left-template.svg",
      // chart triangles may come from multiple printed parts (assembled pose)
      "charts": [
        {
          "libraryPartId": "chair-side-left",
          "tris": [/* triangle indices into that part's packed mesh order */],
          "verts": [/* that part's packed vertex indices used by this chart */],
          "uv": [/* interleaved u,v in TRUE mm, shared zone UV space */],
          "chartTris": [/* chart-local index triples, parallel to tris */],
          "subRegions": [{ "outer": [/* loop */], "holes": [] }], // this part's own share of
          // the zone, in UV mm — what its cutter is clipped to (schema 2; was a flat `subBoundary`
          // loop list in schema 1, which had no outer/hole classification)
        },
      ],
      "boundary": [[/* zone outer loop, UV mm, ~0.2mm simplified */]],
      "holes": [],
      "seams": [[/* UV polylines where printed parts meet, for UI display */]],
      // whole-zone UV bbox across all charts (min is 0,0): template space, and
      // what the runtime anchors placement + fill tiling on, so a seam-spanning
      // zone places one design rather than one per part
      "uvBounds": { "minU": 0, "minV": 0, "maxU": 214.3, "maxV": 168.9 },
      "up": [0, 1],
      "normalSign": 1,
      "distortion": { "max": 1.07, "mean": 1.02 },
    },
  ],
}
```

The `AssemblyKind` gains `zonesFile?: string`; parts referenced by charts must be loaded before the zone activates. `load3MF` additionally returns its indexed mesh so `verts` can resolve.

### Runtime zone model (`src/geometry/zones.ts`)

`ZoneMapper` interface unifies both paths: `boundary()`, `fillExtent()`, `frameAt(u, v)`, `buildCutter(feat, depth, overshoot, opts?)`, plus `placer`, `resolveCutDepth`, `faceNormal`, `nsign`.

- **`FlatZoneMapper`** — the single-flat-patch path. Parts with no sidecar get one implicit flat zone from the chosen `patchIdx`; wheel/footrest run through it unchanged, rotated wheel copies keep working, `cutThrough` stays flat-only.
- **`ConformalZoneMapper`** (`src/geometry/conformal.ts`) — the warp engine (P3).

### State model (assembly mode)

```ts
interface DesignSource {
  id;
  kind: 'upload' | 'pattern';
  name;
  parsed: ParsedSVG;
}
interface ArtworkInstance {
  id;
  sourceId;
  zone: ZoneRef | null; // { partId, zoneId }
  offsetU;
  offsetV;
  scalePct;
  rotationDeg;
  flipX;
  flipY;
  mode: 'sticker' | 'fill';
}
state.sources;
state.artworks;
state.activeArtworkId;
```

Uploading an SVG (or picking a built-in pattern) creates a source and
auto-creates one instance on the default zone — wheel/footrest UX stays
byte-identical for a user who never opens the new list. Colors from all
in-use sources merge into one palette (same hex = one AMS slot).

## Phases

### P1 — Zone abstraction refactor (done, #57)

`buildAssemblyGeometry` iterates via `ZoneMapper` instead of inline `patchIdx/boundaryLoop/topZ`. New `src/geometry/zones.ts`. Zero behavior change.

### P2 — Artwork instances: state + UI (done, #58/#59)

`sources`/`artworks`/`activeArtworkId`; artwork list panel (`src/ui/artworkListPanel.ts`); fit sliders + gizmo bind to the active instance.

### P3 — Conformal warp engine (done, #60)

`src/geometry/conformal.ts`: barycentric chart lookup over a uniform UV grid, smooth area-weighted per-vertex normals, `extrudeRegionToSoup` (mirrored prism) → `refineToLength` → `warpBatch` → validity check with an L/2 retry. Orientation-reversal handled (the warp is orientation-reversing for the chosen UV convention). `tests/conformal.test.ts` on an analytic quarter-cylinder.

### P4 — Automated zone bake tooling (done, #61)

`scripts/bake-zones.mjs` + `scripts/lib/zonebake.mjs`: weld the kind's packed parts, region-grow each zone from a seeded flat patch, in-house LSCM unwrap, orient/scale to true mm, emit boundary/hole/seam loops + per-part charts + sidecar + templates. Config lives in `scripts/zone-configs/<kind>.json`: `zones: [{ id, name, seedNormal|seedPoint, maxAngleDeg, up }]`. `tests/zone-bake.test.ts`.

### P5 — Chair onboarding + viewport zone picking (done, #62–#72)

- **Input**: 15 Fusion per-piece STLs (Handle L/R, Seat Back Bottom/Top, Seat Center, Storage L/R, Wheel Mount L/R, Wing L/R, Caster Mount Std L/R + Kit L/R). Verified in the assembled pose, packed via `pack-part.mjs`, one `parts.json` entry each (#62).
- **Hardware variant selector (Standard vs Kit)**: `AssemblyKind.variants`, per-variant `libraryPartIdByVariant` on caster roles, `state.assembly.variantId` (model in #63, UI radio + `chair_variant_selected` analytics in #71).
- Registered `AssemblyKind { id:'chair-body', designFit:'rect', zonesFile:'chair-body-zones.json', hidden:true }`, one role per piece, auto-loaded together; unhidden once verified (#72). Not every piece needs zones — caster mounts and wheel mounts are structural-only.
- `scripts/zone-configs/chair-body.json` (left/right/back/seat) baked via `bake-zones.mjs`; sidecar + templates committed (#64), with two follow-up correctness fixes found by real chair geometry: packed-mesh vertex precision that made two parts uncuttable (#65) and pinch-vertex loop chaining in the bake (#67).
- Sidecar loaded into parts, `ConformalZoneMapper` dispatched from `implicitZoneFor`, `buildAssemblyGeometry` iterating artwork **instances → per-zone cutters** (#66, #68).
- Multi-source artwork list with per-instance zone targeting (#69).
- **Viewport zone picking**: raycast → triangle → owning zone → select (`src/scene/zonePick.ts`, #70).
- Export via the generic centered path; README notes "chair export placement not yet slicer-verified".

### P6a — Fill engine + Sticker/Fill toggle (done, #73)

`src/geometry/patterns.ts`: `tileCoverage()` inverts a zone's placement affine to find the tile grid needed to cover a zone's extent (works under rotation/scale/mirror, since every `ZoneMapper.placer()` is a pure affine map); `tileFeature()` unions the translated tile copies via the existing `unionAllCooperative`. `ZoneMapper.fillExtent()` added (the area to tile over, independent of the clip boundary). `ArtworkInstance.mode: 'sticker' | 'fill'` made real — a fill instance tiles instead of placing one copy, with a per-row Sticker/Fill toggle in `artworkListPanel.ts`. Conformal cutters got a wider `snapMM` tolerance for fills, on the theory that a fill always runs along the baked zone boundary while a sticker doesn't. **That was wrong and the per-mode knob is gone** — the uncovered patches sit _interior_ to each part's `subRegions` claim, so a sticker meets them exactly as a fill does, and stickers on the seat back were failing on them. Both modes now take `CHART_SNAP_MM`; only the refinement still differs (`FILL_REFINE_MM`). See that constant's comment in `conformal.ts` for the measurement.

### P6b — Pattern library (done, #74)

`scripts/gen-patterns.mjs`: seeded/deterministic procedural pattern generator (Cow, Dalmatian, Zebra, Tiger), committed as `public/patterns/*.svg` + `patterns.json`. Tileability comes from drawing every blob/streak at a 3×3 torus wrap and clipping to the tile rect, so a shape crossing an edge leaves matching partial pieces that weld together when `tileFeature` unions translated copies at runtime; Zebra instead thresholds a periodic wave field and traces contours with marching squares, so stripes branch/merge like real fur. `src/state/patterns.ts` loads the manifest; a thumbnail picker strip in the Artwork panel (`artworkPanel.ts`) loads a pattern like an uploaded SVG, defaulting to Fill mode on assembly parts. `tests/patterns-assets.test.ts` is an asset regression test over every committed pattern.

### P7 — Real-chair defect pass + full-coverage zones (done, #75–#78)

Using the shipped feature on the real chair showed every zone was trapped on the part it seeded on: `back` was an 80 × 216 mm strip on one panel, and nothing reached the front or the fenders. The cause was in the bake, not the runtime — `weldParts` joined parts by _coincident_ vertices at 1e-3 mm, and separately-printed parts never are coincident; they meet with real print clearance (measured worst contact gap 0.530 mm, seat-center to seat-back-bottom). So triangle adjacency never crossed a seam and the region grow stopped at the part edge, which is also why `seams` was empty on every zone and the baked `subBoundary` had never once been exercised.

- **`subRegions` (sidecar schema 2, #76)** — each chart carries its own part's slice of the zone as proper outer/hole regions, and the runtime clips that part's cutter to it. Had to land _before_ any multi-part zone existed: clipping to the whole-zone outline instead pushes artwork past the chart the warp can resolve, which reports off-chart and drops the colour from both parts.
- **`stitchSeams` / `seamWeldTolMm` (#77)** — merges vertices of _different_ parts within a much looser tolerance whose area-weighted normals agree, so a zone can grow across a printed join. Deliberately a separate knob from `weldTolMm`: raising that far enough to bridge 0.53 mm also collapses 63% of the vertices _inside_ each part. Two guards earn their keep — a facing test (`dot > 0.3`) so parts facing each other across a gap don't fuse, and a **one-vertex-per-part-per-group** invariant. The second was a review catch: rejecting a candidate pair that shares a part is not enough, because two vertices of one part that share no triangle can each reach the same vertex opposite and meet transitively. On the real chair at 0.6 mm that folded 392 faces onto each other; with the invariant, folds drop to 25 — exactly the count the plain weld already produces from pre-existing slivers, so the stitch adds none.
- **Zone re-author (#78)** — turning the stitch on makes every zone grow until `maxAngleDeg` stops it rather than until the part runs out, so the whole set had to be re-tuned in the same change. Angles are the measured knee of coverage against stretch: `back` at 55° wraps around the U onto both handles' inner faces and unwraps at 20×, at 35° it is 962 cm² across 6 parts at 1.13×. A `front` zone was added; the planned separate `wing-left`/`wing-right` zones were **dropped as unnecessary** — seeding on the fender reaches the identical triangle set as seeding on the storage side, because the whole flank is one continuous surface once stitched, so `left`/`right` already carry the wing and wheel mount.

| zone           | before          | after             | max stretch |
| -------------- | --------------- | ----------------- | ----------- |
| `left`/`right` | 529 cm², 1 part | 1245 cm², 4 parts | 1.22        |
| `back`         | 173 cm², 1 part | 962 cm², 6 parts  | 1.13        |
| `front`        | —               | 604 cm², 6 parts  | 1.11        |
| `seat`         | 186 cm², 1 part | 566 cm², 5 parts  | 1.28        |

Every zone now exceeds `DISTORTION_WARN` (1.1) and says so in the bake log. That threshold was set against single-part, nearly-flat zones; a zone that wraps a real chair flank cannot meet it. The stretch is not uniform — `left` runs p50 1.00 / p99 1.15 — so the warning is worth keeping as a prompt to check, not to silence. Templates gained part-name labels on each sub-region, since the dashed seam lines said _where_ artwork gets split but nothing said which physical piece each side ends up on.

## Model per phase (as actually used)

Strongest model for geometry/placement math, Sonnet for UI/data/docs.

| Phase                         | Model                                       |
| ----------------------------- | ------------------------------------------- |
| P1 zone refactor              | Opus                                        |
| P2 artwork instances          | Sonnet (Opus review of the state migration) |
| P3 conformal warp engine      | Fable                                       |
| P4 bake tooling               | Fable / Opus                                |
| P5 chair onboarding + picking | Opus                                        |
| P6a fill engine               | Opus                                        |
| P6b pattern library           | Sonnet                                      |

## Gizmo generalization

`computeFaceFrame()` takes the active instance and returns `mapper.frameAt(offsetU, offsetV)`: origin = S(u₀,v₀) (+ modelGroup offset), uAxis = normalized ∂S/∂u, vAxis = normal × uAxis, normal = N̂(u₀,v₀). The gizmo drag math is already frame-relative, so each pointermove re-fetches the frame and the gizmo walks the curved surface as a local linearization.

## Risks / accepted trade-offs

- **Chair mesh weight**: per-piece CAD STLs replace the 374k monolith. Request lean exports; never decimate.
- **Seam alignment**: artwork crossing a part seam is split and cut per part; physical continuity depends on print/assembly tolerance. Documented; the UI shows baked seam lines.
- **Warped-prism triangle counts**: multi-color rebuilds may take tens of seconds on a large fill; lever = raise the fill's refine length (`FILL_REFINE_MM`).
- **Cross-zone wrap is not solved** (cross-_part_ within one zone IS, via chart welding): zones are segmented to extend past their visual edges. Overlapping zones can double-cut; accept + document.
- **Concave curvature < pocket depth** self-intersects: bake-time warning + runtime validity retry.
- **Distortion on doubly-curved regions**: baked stats warn the author; effect ≈ real vinyl stretch.
- Turf stays pinned at 6.5.0; baked 0.2 mm boundary simplification keeps clips cheap.
- **Fill assumes the design tiles**: a non-tileable upload will show seams at the repeat boundary — the built-in library is verified tileable by construction, uploads are the user's responsibility.

## Verification per phase

- **P1**: tests unchanged + equivalence test; smoke; byte-compare wheel/footrest exports vs `main`.
- **P2**: instance CRUD/migration unit tests; sliders + gizmo drive the active instance.
- **P3**: cylinder-chart accuracy (< 0.05 mm, constant depth).
- **P4**: fixture round-trip; refuse a moved/re-triangulated mesh; eyeball templates vs physical dims.
- **P5**: sticker across the left-side wrap edge → conformal follow (live-verified); export 3MF opens and slices (placement baking deferred).
- **P6a**: tile continuity across borders (property tests in `tests/patterns.test.ts`); live-verified a real chair fill build (caught and fixed a baked-boundary-overhang bug no unit test surfaced).
- **P6b**: asset regression test over every committed pattern; live-verified the picker strip + a real Fill-mode build in a browser.
- Every geometry phase: `/code-review`. Every user-visible phase: CHANGELOG + README + help + analytics.

## Critical files

- `src/geometry/assembly.ts`, `src/geometry/manifold.ts`, `src/geometry/zones.ts`, `src/geometry/conformal.ts`, `src/geometry/patterns.ts` — cut pipeline
- `src/state/store.ts`, `src/state/artwork.ts`, `src/state/patterns.ts`, `src/types.ts` — state
- `src/scene/faceFrame.ts`, `src/scene/designGizmo.ts`, `src/scene/zonePick.ts` — gizmo + picking
- `src/ui/artworkListPanel.ts`, `src/ui/artworkPanel.ts` — instance list, upload/pattern picker
- `src/assembly/kinds.ts`, `src/assembly/parts.ts` — kind/variant/zone registration
- `scripts/bake-zones.mjs`, `scripts/lib/zonebake.mjs`, `scripts/zone-configs/chair-body.json` — zone bake
- `scripts/gen-patterns.mjs`, `public/patterns/` — pattern library
