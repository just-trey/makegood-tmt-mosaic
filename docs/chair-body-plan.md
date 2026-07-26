# Chair body: multi-zone conformal artwork + pattern library

This is the design plan for onboarding the MakeGood TMT chair main body with
per-zone conformal artwork, and for the general multi-zone capability it is
built on. It is tracked in-repo (not just in a local planning file) so the work
survives across machines and sessions.

## Status (living checklist)

Phases 1–4 are the general capability; phase 5 is the chair itself, shipping as
four isolated PRs; phase 6 is the pattern library.

- [x] **P1 — Zone abstraction refactor** (`ZoneMapper`/`FlatZoneMapper`, `implicitZoneFor`)
- [x] **P2 — Artwork instances: state + UI** (`sources`/`artworks`/`activeArtworkId`, artwork list panel)
- [x] **P3 — Conformal warp engine** (`src/geometry/conformal.ts`, `ConformalZoneMapper`) — PR #60
- [x] **P4 — Automated zone bake tooling** (`scripts/bake-zones.mjs`, `scripts/lib/zonebake.mjs`) — PR #61
- [ ] **P5 — Chair onboarding + zone picking** — in progress, four sub-PRs:
  - [x] P5.1 pack the 15 pieces + `parts.json` + verification test — PR #62
  - [x] P5.2 hidden `chair-body` kind + Standard/Kit variant model — PR #63
  - [ ] P5.3 zone config + bake sidecar + `zonesFile` load + `ConformalZoneMapper` dispatch + per-zone build
  - [ ] P5.4 viewport zone picking + variant radio UI + docs + **unhide** the chair
- [ ] **P6 — Pattern library + fill mode**

Open decisions carried into the remaining PRs:

- **Retire the standalone hidden `wheel-mount-left` kind?** It ships that part in
  a centered/design-face-up pose; the chair ships the same physical part in the
  assembled pose as `chair-wheel-mount-left`. They can't be one file. Decide in P5.4.
- **Slicer/export placement for the chair is deferred** (needs a verified
  reference 3MF per the add-part checklist). Chair exports go through the generic
  centered path meanwhile; note it in README Known limitations.
- Key geometry fact: the chair's design faces point sideways (±X/±Z), not up
  along Y, so the flat-zone path can't cut them — the conformal zones (P5.3) are
  what make the chair cuttable, which is why the kind stays hidden until P5.4.

---

## Context

The MakeGood TMT **chair main body** is the next part to onboard. The reference `stubs/Main Chair Body.stl` (18.7 MB, 374,260 triangles, Fusion-exported) is the _welded assembly_; the user instead provides **one CAD STL per printed piece** (side panels, back, seat, etc.), which the app loads in their assembled pose — like the wheel's halves, but more pieces. The monolith STL stays as the pose/alignment reference. This part breaks the app's core assumption: today there is exactly **one design + one placement in global state**, orthographically projected along Y onto **one** detected flat patch per part. The chair has multiple large design surfaces on different axes (left side, right side, back, seat, top), and the user wants:

1. Different artwork on different sides.
2. **True conformal wrap** — a sticker near a rounded edge follows the surface like real vinyl (chosen over cheaper projection).
3. A **built-in pattern library** (tileable cow / dalmatian / zebra / tiger SVGs) with a "fill zone" mode.
4. Built as a **general capability** (any part can declare multiple design zones), not chair-specific.

Slicer/export placement baking for the chair is **explicitly deferred** to a later task (needs a verified reference 3MF).

## Architecture (chosen direction)

**Baked UV design zones + runtime Manifold warp.** No runtime unwrapping — matches the repo's bake-don't-derive philosophy.

- Each multi-face kind ships with script-baked UV-unwrapped charts ("design zones"), stored in an **assembly-level sidecar** (`public/stl/<kind>-zones.json`) because a zone's chart may **span triangles from multiple printed parts**. UVs are true-to-size mm (1 UV unit = 1 mm). Charts are unwrapped over the parts in their assembled pose; each chart triangle records which part it belongs to.
- At runtime, artwork regions are computed in the zone's flat 2D mm space exactly like today (turf clip to chart boundary), extruded into a flat prism in (u, v, depth), refined with `Manifold.refineToLength(1.5mm)`, then bent onto the surface with `Manifold.warpBatch`: each vertex (u,v,h) → S(u,v) + h·N̂(u,v) via barycentric lookup into the chart. The warped cutter feeds the existing difference/intersection pipeline unchanged.
- **Per-part splitting for cross-seam artwork**: when a zone spans several printed parts, the placed regions are additionally clipped against each part's UV sub-region, producing one warped cutter per part; each is booleaned against its own part's manifold and its inlays export under that part's object. The seam line in UV space is baked into the sidecar. Physical color alignment at the seam depends on print/assembly tolerance — documented limitation, not solvable in software.
- **Verified**: manifold-3d 3.5.1 exposes `warp`, `warpBatch`, `refine`, `refineToLength` — no new dependencies.
- Export side needs no redesign: `build3MFCombined` already emits N inlay shells per object.

### Zone sidecar schema (assembly-level: `public/stl/<kind>-zones.json`)

```jsonc
{
  "schema": 1,
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
          "subBoundary": [[/* this part's UV sub-region outline, for per-part clip */]],
        },
      ],
      "boundary": [[/* zone outer loop, UV mm, ~0.2mm simplified */]],
      "holes": [],
      "seams": [[/* UV polylines where printed parts meet, for UI display */]],
      "up": [0, 1],
      "normalSign": 1,
      "distortion": { "max": 1.07, "mean": 1.02 },
    },
  ],
}
```

The `AssemblyKind` gains `zonesFile?: string`; parts referenced by charts must be loaded before the zone activates. `load3MF` must additionally return its indexed mesh so `verts` can resolve.

### Runtime zone model (`src/geometry/zones.ts`)

`ZoneMapper` interface unifies both paths: `boundary()`, `frameAt(u, v)`, `buildCutter(feat, depth, overshoot)`, plus `placer`, `resolveCutDepth`, `faceNormal`, `nsign`.

- **`FlatZoneMapper`** — today's single-flat-patch path. Parts with no sidecar get one implicit flat zone from the chosen `patchIdx`; wheel/footrest run through it unchanged, rotated wheel copies keep working, `cutThrough` stays flat-only.
- **`ConformalZoneMapper`** — the warp engine (P3).

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

Uploading an SVG creates a source and auto-creates one instance on the default zone — wheel/footrest UX stays byte-identical for a user who never opens the new list. Colors from all in-use sources merge into one palette (same hex = one AMS slot).

## Phases

### P1 — Zone abstraction refactor (done)

`buildAssemblyGeometry` iterates via `ZoneMapper` instead of inline `patchIdx/boundaryLoop/topZ`. New `src/geometry/zones.ts`. Zero behavior change.

### P2 — Artwork instances: state + UI (done)

`sources`/`instances`/`activeArtworkId`; artwork list panel; fit sliders + gizmo bind to the active instance. (The build still uses one global placement per part; per-zone iteration lands in P5.3.)

### P3 — Conformal warp engine (done, PR #60)

`src/geometry/conformal.ts`: barycentric chart lookup over a uniform UV grid, smooth area-weighted per-vertex normals, `extrudeRegionToSoup` (mirrored prism) → `refineToLength(1.5)` → `warpBatch` → validity check with an L/2 retry. Orientation-reversal handled (the warp is orientation-reversing for the chosen UV convention). `tests/conformal.test.ts` on an analytic quarter-cylinder.

### P4 — Automated zone bake tooling (done, PR #61)

`scripts/bake-zones.mjs` + `scripts/lib/zonebake.mjs`: weld the kind's packed parts, region-grow each zone from a seeded flat patch, in-house LSCM unwrap, orient/scale to true mm, emit boundary/hole/seam loops + per-part charts + sidecar + templates. Config lives in `scripts/zone-configs/<kind>.json`: `zones: [{ id, name, seedNormal|seedPoint, maxAngleDeg, up }]`. `tests/zone-bake.test.ts`.

### P5 — Chair onboarding + viewport zone picking (in progress)

- **Input**: 15 Fusion per-piece STLs (Handle L/R, Seat Back Bottom/Top, Seat Center, Storage L/R, Wheel Mount L/R, Wing L/R, Caster Mount Std L/R + Kit L/R). Verified in the assembled pose, packed via `pack-part.mjs`, one `parts.json` entry each. **(P5.1, PR #62)**
- **Hardware variant selector (Standard vs Kit)**: `AssemblyKind.variants`, per-variant `libraryPartIdByVariant` on caster roles, `state.assembly.variantId`, `roleLibraryPartId`/`currentVariantId` resolvers. UI radio + `chair_variant_selected` analytics + help land in P5.4. **(model in P5.2, PR #63; UI in P5.4)**
- Register `AssemblyKind { id:'chair-body', designFit:'rect', zonesFile:'chair-body-zones.json', hidden:true }`, one role per piece, auto-loaded together; unhide when verified. Not every piece needs zones (casters/possibly wheel mounts are structural-only).
- Write `scripts/zone-configs/chair-body.json` (≈5 zones: left, right, back, seat, top — charts spanning parts where sides meet the back); run `bake-zones.mjs`; commit sidecar + templates. **(P5.3)**
- Load the sidecar into parts and dispatch `ConformalZoneMapper` in `implicitZoneFor`; make `buildAssemblyGeometry` iterate artwork **instances → per-zone cutters**. **(P5.3)**
- **Viewport zone picking**: raycast → triangle → owning zone → select; "add artwork here" on empty zones. New `src/scene/zonePick.ts`. **(P5.4)**
- Export via the generic centered path; note "chair export placement not yet slicer-verified" in README. Docs: CHANGELOG, README, help, analytics (`zone_selected`). **(P5.4)**

### P6 — Pattern library + fill mode

`public/patterns/patterns.json` + curated tileable SVGs; `src/geometry/patterns.ts` `tileRegions(...)`; `src/ui/patternPanel.ts`; works on flat parts too. Analytics `pattern_fill_applied`.

## Model per phase

Strongest model for geometry/placement math, Sonnet for UI/data/docs.

| Phase                              | Model                                       |
| ---------------------------------- | ------------------------------------------- |
| P1 zone refactor                   | Opus                                        |
| P2 artwork instances               | Sonnet (Opus review of the state migration) |
| P3 conformal warp engine           | Fable                                       |
| P4 bake tooling                    | Fable or Opus                               |
| P5 chair onboarding + zone picking | Opus                                        |
| P6 pattern library + fill          | Sonnet                                      |

## Gizmo generalization

`computeFaceFrame()` takes the active instance and returns `mapper.frameAt(offsetU, offsetV)`: origin = S(u₀,v₀) (+ modelGroup offset), uAxis = normalized ∂S/∂u, vAxis = normal × uAxis, normal = N̂(u₀,v₀). The gizmo drag math is already frame-relative, so each pointermove re-fetches the frame and the gizmo walks the curved surface as a local linearization.

## Risks / accepted trade-offs

- **Chair mesh weight**: per-piece CAD STLs replace the 374k monolith. Request lean exports; never decimate.
- **Seam alignment**: artwork crossing a part seam is split and cut per part; physical continuity depends on print/assembly tolerance. Documented; the UI shows baked seam lines.
- **Warped-prism triangle counts** (~50–70k per color for a 200×200 artwork at L=1.5 mm): multi-color rebuilds may take tens of seconds; lever = raise L for large fills.
- **Cross-zone wrap is not solved** (cross-_part_ within one zone IS, via chart welding): zones are segmented to extend past their visual edges. Overlapping zones can double-cut; accept + document.
- **Concave curvature < pocket depth** self-intersects: bake-time warning + runtime validity retry.
- **Distortion on doubly-curved regions**: baked stats warn the author; effect ≈ real vinyl stretch.
- Turf stays pinned at 6.5.0; baked 0.2 mm boundary simplification keeps clips cheap.

## Verification per phase

- **P1**: tests unchanged + equivalence test; smoke; byte-compare wheel/footrest exports vs `main`.
- **P2**: instance CRUD/migration unit tests; sliders + gizmo drive the active instance.
- **P3**: cylinder-chart accuracy (< 0.05 mm, constant depth).
- **P4**: fixture round-trip; refuse a moved/re-triangulated mesh; eyeball templates vs physical dims.
- **P5**: place a sticker across the left-side wrap edge → conformal follow; export 3MF → correct per-color shells (placement deferred).
- **P6**: tile continuity across borders, clip at zone boundary, fill footrest, export.
- Every geometry phase: `/code-review`. Every user-visible phase: CHANGELOG + README + help + analytics.

## Critical files

- `src/geometry/assembly.ts`, `src/geometry/manifold.ts`, `src/geometry/zones.ts`, `src/geometry/conformal.ts` — cut pipeline
- `src/state/store.ts`, `src/types.ts` — state
- `src/scene/faceFrame.ts`, `src/scene/designGizmo.ts`, `src/scene/zonePick.ts` (new) — gizmo + picking
- `src/assembly/kinds.ts`, `src/assembly/parts.ts` — kind/variant/zone registration
- `scripts/bake-zones.mjs`, `scripts/lib/zonebake.mjs`, `scripts/zone-configs/chair-body.json` — zone bake
