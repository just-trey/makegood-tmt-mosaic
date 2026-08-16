---
name: add-part
description: Add a new MakeGood TMT part as an assembly kind: pick the best source mesh, pack it into public/stl/ aligned to the frame the app expects, register the AssemblyKind, bake export placement from a verified reference file, and ship a 1:1 template. Use when adding, replacing, or debugging the setup of, any part in public/stl/ + src/assembly/kinds.ts.
model: opus
---

# Add an assembly part

Six steps. **Step 4 is the one that produces wrong-but-plausible output**, so it
carries a hard rule. Read it before touching
[threemf.ts](../../../src/export/threemf.ts).

Ask for two inputs up front if they weren't given: the **source mesh** and the
**verified reference 3MF** (step 4). They are usually different files, and step
4 is impossible without the second.

## 1. Choose the source mesh

You will often be handed the same part twice: a MakerWorld or Bambu Studio
download, and a CAD export. They are not equivalent, and the choice is not a
toss-up.

```bash
node .claude/skills/add-part/compare-meshes.mjs <candidate-a> <candidate-b>
```

It prints triangle count, bbox, surface area and the patches
`detectFlatPatches` will rank, then searches all 48 signed axis maps for the
rigid transform between the two.

**Prefer the CAD export.** Slicer meshes are STEP tessellations blown up to a
triangle count that buys no accuracy. Both swaps this repo has shipped, packed
with `--align-to` so the pose is identical:

|                            | footrest (slicer → CAD) | wheel half (slicer → CAD) |
| -------------------------- | ----------------------- | ------------------------- |
| triangles                  | 235,490 → 10,772        | 20,502 → 17,968           |
| shipped size               | 2.8 MB → 86 KB          | 400 KB → 176 KB           |
| surface area               | agrees to 0.06%         | agrees to 0.01%           |
| design face, largest patch | 54,693.7 → 54,688.3 mm² | 29,407.8 → 29,403.4 mm²   |

Read the last two rows together: the geometry the app uses is unchanged to
within a few mm², and the download is 30× smaller. **The extra triangles buy
nothing.**

`compare-meshes.mjs` also reports **face coherence**: how much of the area
facing the design face lands in one `detectFlatPatches` bucket rather than
fragmenting across its offsets. Compare it between candidates, since a mesh
scoring markedly worse detects less art surface. Don't expect a clean export to
improve it on its own; the footrest's went 98.1% → 97.1% and detects the same
face.

- **Don't decimate a dense mesh if a CAD export exists.** Decimation can move
  bores and bosses and tilts face triangles out of their patch bucket. The clean
  export beats its best case for free.
- **Read the transform, don't trust the pose.** The two files won't share an
  origin or axis convention. Feed the printed rotation and translation to step
  2's `--align-to` rather than eyeballing.
- **`MIRRORED` means the opposite hand** (TMT ships left/right variants), never
  a substitute. It is only reported when a mirror beats every rotation by a real
  margin: on a part symmetric about an axis, mirroring is a no-op, so the tool
  correctly reports the rotation instead. The shipped footrest is that case.
- **A mismatch is a stop sign, but read which mismatch.** "Bounding boxes do not
  line up" can be a coarse tessellation clipping a curved part's extremes (the
  wheel half moved 0.03mm on Z from re-tessellation alone), and the tool prints
  the `--bbox-tol` that would accept it. **"Bounding boxes line up but the
  geometry disagrees" is the real stop sign**: a revision or a different variant.
- **Keep both files.** The CAD mesh is the geometry; the slicer file is usually
  the only thing carrying a verified print pose, which is step 4's input.

## 2. Pack it into public/stl/

**Never copy a source mesh in directly.** Run it through
[pack-part.mjs](../../../scripts/pack-part.mjs), which re-indexes vertices and
DEFLATEs the result into the single-inlined-`<object>` 3MF `load3MF` reads.
Packing typically halves the file even with no mesh change.

```bash
npx vite-node scripts/pack-part.mjs <src.stl|src.3mf> \
  [--align-to public/stl/<current>.3mf] [--bbox-tol <mm>] --out public/stl/<part>.3mf
```

**`--align-to` is mandatory when replacing an existing part.** Parts are never
recentered at load time (`asmLoadPartBuffer` in
[parts.ts](../../../src/assembly/parts.ts) uses raw mesh coordinates), so a
part's pose is load-bearing: step 4's baked constants, the wheel's
rotate-about-the-origin second half, `topZ` and the generated templates are all
pinned to it. Aligning moves the new mesh into the old one's exact frame and
bakes that into the asset, so nothing in `src/export/` changes and no transform
happens at runtime. The script refuses to write on a non-match or a mirror.

Check its report before moving on: **bbox drift must be ~0**, and face coherence
should be near the file you're replacing. A point or two either way is
tessellation noise; a large drop means the new mesh fragments the design face
and the app detects less art surface.

Then add the manifest entry in
[parts.json](../../../public/stl/parts.json): `{ "id", "name", "file":
"stl/<part>.3mf" }`, where `id` is what the kind's `libraryPartId` points at.

**The failure this replaces:** `load3MF`
([meshparts.ts](../../../src/geometry/meshparts.ts)) only reads meshes inlined
in `3D/3dmodel.model`, while Bambu's production-extension format references them
from a separate file via `<component p:path="...">`. A part built from one of
those loads **empty, zero triangles, no error**. Packing from a CAD `.stl`
avoids it by construction.

## 3. Register one AssemblyKind

One entry in `ASSEMBLY_KINDS` in
[kinds.ts](../../../src/assembly/kinds.ts). Deliberately inline data, not a
fetched manifest: it decides what UI renders at all, so don't convert it.

- **`designFit: 'rect'`** for a non-circular part: the SVG maps 1:1 in mm and
  auto-centres on the detected face. Without it you get the wheel's
  Design-radius circle model, meaningless on a rectangular face.
- **`preferFaceNormal: [x, y, z]`** when the largest flat patch isn't the
  intended design face. The footrest needs it: the flat back of the shell
  outsizes the seat face.
- **`roles[]`** is the fixed set of part roles. `allowRotatedCopies`, `copies`
  and `copyDefaults` are for one physical STL reused at another position (the
  wheel's Top and Bottom), not a second uploaded part.

Follow `footrest` for a single-role rect part, `wheel` for a multi-role one.

## 4. Bake export placement from a verified reference 3MF

**Never invent these numbers, never derive them, never read them at runtime.**

Get a reference project file where the part's real print pose has been checked
in the slicer: rotation, plate position, prime tower placement, per-part
overrides. Turn _its_ numbers into constants on the part's `ExportPart` in
[threemf.ts](../../../src/export/threemf.ts): `plateR`, `fixedPos` or centering,
`primeTowerDelta`, `objectSettings`.

`FOOTREST_PLATE_R` and `FOOTREST_PRIME_TOWER_DELTA` are the worked example,
including the comment recording what each number came from and what was
deliberately _not_ baked. **Write that comment for the new part too; the
provenance is the point.**

**Prefer centering plus a relative `primeTowerDelta` over an absolute
`fixedPos`.** An absolute coordinate baked from one printer's plate centre is
wrong on any other bed. The wheel's `fixedPos` constants exist for historical
reasons and carry a re-centering fallback (`isRefPlate`) for exactly that; don't
add new ones unless the reference genuinely requires a specific position.

**If you don't have a verified reference file, stop and say so.** A guessed pose
yields a 3MF that opens fine and prints wrong.

Add the part's id to `PLACEMENT` in
[placement.ts](../../../src/export/placement.ts), or for the chair re-run
`bake-chair-placement.mjs`, then reseal it. `PLACEMENT`'s constants are only
trusted for a mesh matching its recorded fingerprint:

```bash
npx vite-node scripts/bake-part-fingerprints.mjs
```

**Run this after every re-pack of a shipped part, not just new ones.**
Re-packing changes the mesh; without re-verifying the pose in the slicer and
resealing, the part loses its baked placement at export (a loud warning, not a
silent wrong pose, but still lost). `git diff src/export/partFingerprints.ts`
should show only the parts you touched. Anything else means an unrelated asset
moved and needs its own placement re-check.

## 5. The separate orientations are intentional

Three frames are in play and they legitimately differ. **Don't unify them.**

1. **Native**: the coordinates the mesh ships in, baked by `pack-part.mjs`.
   Everything downstream reads these: the cut pipeline, the baked zone charts,
   the export placement tables.
2. **Export/plate pose**: whatever the reference file verified as correct for
   printing. The footrest stands on its long edge to print support-free.
3. **Viewport pose**: how the artist sees it.

For a plate-like part, 1 and 3 coincide for free: pack it **design-face-up** and
the app's "the design face is a Y-plane" convention renders it standing up
facing the camera. The wheel and footrest need nothing here.

A part with no single design face can't be packed that way; the chair is packed
in its CAD frame. Give such a kind a `displayFrame` in
[kinds.ts](../../../src/assembly/kinds.ts) (`up` and `front` as native-space
directions) and the viewport poses it without touching native coordinates. Omit
it for anything already design-face-up.

**Careful when adding one.** Anything living OUTSIDE `modelGroup` that must stay
stuck to the model, the design gizmo and the zone-pick targets, has to go
through `modelToWorldPoint`, `modelToWorldDir` or `syncToModelGroup` in
[viewport.ts](../../../src/scene/viewport.ts). Reading `.position` alone works
until a kind poses itself, then silently detaches with nothing to catch it.

This is why step 1's rotation matters rather than being trivia: when the CAD
mesh and the reference file disagree about axes, that transform is what carries
the verified pose onto the mesh you shipped. Bake it as a constant like any
other placement number.

## 6. Ship a true-to-size template

A 1:1 mm SVG matching the part's real design-face dimensions, in
`public/templates/`, wired as the kind's `templateFile`.

**Generate it rather than drawing it.**
[gen-templates.mjs](../../../scripts/gen-templates.mjs) extracts the real
printable outline and hole loops from the mesh using the same
`detectFlatPatches` and `extractPatchBoundary` the app uses at runtime, so
template and app agree by construction.

```bash
npx vite-node scripts/gen-templates.mjs
```

Match the shared visual language: `#bcbcbc` printable-surface grey, the single
blue guide ink (`#1a4f8f`) for every non-printing mark, `LABEL_SIZE` for guide
labels. Holes are real gaps in the grey; absence of material must read at a
glance.

## Then

Verify in the real app, not just tests: load the part, apply artwork, export,
and unzip the 3MF to check the pose. Then run `ship-it`. This touches
`src/geometry/` and `src/export/`, so `/code-review` is required, not optional.
