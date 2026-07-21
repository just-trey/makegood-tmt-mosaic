---
name: add-part
description: Add a new MakeGood TMT part as an assembly kind — pick the best source mesh, pack it into public/stl/ aligned to the frame the app expects, register the AssemblyKind, bake export placement from a verified reference file, and ship a 1:1 template. Use when adding, replacing, or debugging the setup of, any part in public/stl/ + src/assembly/kinds.ts.
---

# Add an assembly part

Six steps. Step 4 is the one that produces wrong-but-plausible output, so it has
a hard rule attached — read it before touching [src/export/threemf.ts](../../../src/export/threemf.ts).

Ask for two inputs up front if they weren't given: the **source mesh** and the
**verified reference 3MF** (step 4). They are usually different files, and you
cannot do step 4 without the second one.

## 1. Choose the source mesh

You will often be handed the same part twice — a MakerWorld / Bambu Studio
download and a CAD export (Fusion, STEP-derived). They are not equivalent, and
the choice is not a toss-up.

```bash
node .claude/skills/add-part/compare-meshes.mjs <candidate-a> <candidate-b>
```

It prints triangle count, bbox, surface area and the patches
`detectFlatPatches` will actually rank, then searches all 48 signed axis maps for
the rigid transform between the two.

**Prefer the CAD export.** Slicer/MakerWorld meshes are STEP tessellations blown
up to a triangle count that buys no accuracy. The two swaps this repo has
actually shipped, both packed with `--align-to` so the pose is identical:

|                            | footrest (slicer → CAD) | wheel half (slicer → CAD) |
| -------------------------- | ----------------------- | ------------------------- |
| triangles                  | 235,490 → 10,772        | 20,502 → 17,968           |
| shipped size               | 2.8 MB → 86 KB          | 400 KB → 176 KB           |
| surface area               | agrees to 0.06%         | agrees to 0.01%           |
| design face, largest patch | 54,693.7 → 54,688.3 mm² | 29,407.8 → 29,403.4 mm²   |

Read those last two rows together: the geometry the app actually uses is
unchanged to within a few mm², and the download is 30× smaller. The extra
triangles buy **nothing** — that is the whole argument, and it does not depend
on the denser mesh being worse in any other way.

`compare-meshes.mjs` also reports "face coherence": how much of the area facing
the design face lands in one `detectFlatPatches` bucket rather than fragmenting
across its `offset.toFixed(2)` offsets. Compare it between candidates — a mesh
that scores markedly worse will detect less art surface — but don't expect a
clean export to improve it on its own (the footrest's went 98.1% → 97.1% and the
part detects the same face).

Corollaries:

- **Don't decimate to fix a dense mesh if a CAD export exists.** Decimation is
  the risky path (it can move bores and bosses, and it tilts face triangles out
  of their patch bucket). The clean export beats decimation's best case for free.
- **Read the transform, don't trust the pose.** The two files will not share an
  origin or an axis convention. `compare-meshes.mjs` prints the exact rotation +
  translation; feed it to step 2's `--align-to` rather than eyeballing anything.
- **`MIRRORED` means the opposite hand** (TMT ships left/right variants), which
  is never a substitute. But note it is only reported when a mirror beats every
  rotation by a real margin: on a part symmetric about an axis, mirroring is a
  no-op, so the mirror and the rotation describe the same result and the tool
  correctly reports the rotation. The shipped footrest is exactly this case.
- **A mismatch is a stop sign, but read which mismatch.** "Bounding boxes do not
  line up" can just be a coarse tessellation clipping a curved part's extremes
  (the shipped wheel half moved 0.03mm on Z from re-tessellation alone); the tool
  prints the `--bbox-tol` that would accept it. "Bounding boxes line up but the
  geometry disagrees" is the real stop sign — a revision or a different variant.
  Don't mix those.
- **Keep both files anyway.** The CAD mesh is the geometry; the slicer file is
  usually the only thing carrying a verified print pose, which is step 4's input.

## 2. Pack it into public/stl/

Never copy a source mesh in directly. Run it through
[scripts/pack-part.mjs](../../../scripts/pack-part.mjs), which re-indexes the
vertices and DEFLATEs the result into the single-inlined-`<object>` 3MF that
`load3MF` reads. Packing typically halves the file even with no mesh change.

```bash
npx vite-node scripts/pack-part.mjs <src.stl|src.3mf> \
  [--align-to public/stl/<current>.3mf] [--bbox-tol <mm>] --out public/stl/<part>.3mf
```

**`--align-to` is mandatory when replacing an existing part**, and the reason is
the whole point of this step: parts are **never recentered at load time**
(`asmLoadPartBuffer` in [src/assembly/parts.ts](../../../src/assembly/parts.ts)
uses raw mesh coordinates). A part's pose is therefore load-bearing — step 4's
baked constants, the wheel's rotate-about-the-origin second half, `topZ`, and
the generated templates are all pinned to it. Aligning moves the new mesh into
the old one's exact frame and bakes that into the asset, so nothing in
`src/export/` has to change and no transform happens at runtime. The script
refuses to write on a non-match or a mirror.

Sanity-check its report before moving on: **bbox drift must be ~0**, and face
coherence should be in the same neighbourhood as the file you're replacing (a
point or two either way is tessellation noise; a large drop means the new mesh
fragments the design face and the app will detect less art surface). Then add
the manifest entry in
[public/stl/parts.json](../../../public/stl/parts.json) —
`{ "id", "name", "file": "stl/<part>.3mf" }`, where `id` is what the kind's
`libraryPartId` will point at.

The failure this replaces: `load3MF`
([src/geometry/meshparts.ts](../../../src/geometry/meshparts.ts)) only reads
meshes inlined in `3D/3dmodel.model`, while Bambu's production-extension format
references them from a separate internal file via `<component p:path="...">`. A
part built from one of those loads **empty, with zero triangles, and no error**.
Packing from a CAD `.stl` avoids it by construction.

## 3. Register one AssemblyKind

One entry in `ASSEMBLY_KINDS` in
[src/assembly/kinds.ts](../../../src/assembly/kinds.ts). This is deliberately
inline data, not a fetched manifest — it decides what UI renders at all, so don't
convert it to a fetch.

- `designFit: 'rect'` for a non-circular part: the SVG maps 1:1 in mm and
  auto-centers on the detected face. Without it you get the wheel's
  circle/Design-radius model, which has no meaning on a rectangular face.
- `preferFaceNormal: [x, y, z]` when the largest flat patch isn't the intended
  design face. The footrest needs it because the flat back of the shell outsizes
  the seat face by area.
- `roles[]` is the fixed set of part _roles_. `allowRotatedCopies` + `copies` +
  `copyDefaults` are for one physical STL reused at another position (the wheel's
  Top/Bottom), not for a second uploaded part.

Follow the existing `footrest` entry for a single-role rect part; follow `wheel`
for a multi-role one.

## 4. Bake export placement from a verified reference 3MF

**Never invent these numbers, never derive them, never read them at runtime.**

Get a reference project file where the part's real print pose has actually been
checked in the slicer — rotation, plate position, prime/wipe tower placement, any
per-part print overrides. Turn _its_ numbers into constants on the part's
`ExportPart` in [src/export/threemf.ts](../../../src/export/threemf.ts):
`plateR`, `fixedPos` or centering, `primeTowerDelta`, `objectSettings`.

`FOOTREST_PLATE_R` / `FOOTREST_PRIME_TOWER_DELTA` (around line 236) are the
worked example, including the comment explaining what each number came from and
what was deliberately _not_ baked. Write that comment for the new part too — the
provenance is the point.

**Prefer centering + a relative `primeTowerDelta` over an absolute `fixedPos`.**
An absolute coordinate baked from one printer's plate center is wrong on any
other bed size. The wheel's `fixedPos` constants exist for historical reasons and
carry a re-centering fallback (`isRefPlate`) for exactly this; don't add new ones
unless the reference genuinely requires a specific plate position.

If you don't have a verified reference file, stop and say so. Do not ship a
guess — a guessed pose yields a 3MF that opens fine and prints wrong.

## 5. Two orientations are intentional

The viewport shows the part **design-face-up** (how the artist sees it). The
export/plate pose is whatever the reference file verified as correct for
printing. These legitimately differ — the footrest stands on its long edge to
print support-free. Don't "fix" the mismatch by unifying them.

This is also why step 1's rotation matters rather than being trivia: when the CAD
mesh and the reference file disagree about axes, that transform is exactly what
carries the verified pose onto the mesh you actually shipped. Bake it as a
constant like any other placement number — don't re-derive it at runtime.

## 6. Ship a true-to-size template

A 1:1 mm SVG matching the part's real design-face dimensions, in
`public/templates/`, wired as the kind's `templateFile`.

Generate it rather than drawing it: [scripts/gen-templates.mjs](../../../scripts/gen-templates.mjs)
extracts the real printable outline and hole loops from the mesh, using the same
`detectFlatPatches` / `extractPatchBoundary` the app uses at runtime, so template
and app agree by construction.

```bash
npx vite-node scripts/gen-templates.mjs
```

Match the shared visual language: `#bcbcbc` printable-surface grey, the single
blue guide ink (`#1a4f8f`) for every non-printing mark, `LABEL_SIZE` for guide
labels. Holes are real gaps in the grey — absence of material must read at a
glance.

## Then

Verify in the real app, not just tests — load the part, apply artwork, export,
and unzip the resulting 3MF to check the pose. Then run the `ship-it` skill; this
change touches `src/geometry/` and `src/export/`, so `/code-review` is required,
not optional.
