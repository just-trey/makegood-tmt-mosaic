---
name: add-part
description: Add a new MakeGood TMT part as an assembly kind — flatten the source 3MF, register the AssemblyKind, bake export placement from a verified reference file, and ship a 1:1 template. Use when adding, or debugging the setup of, any part in public/stl/ + src/assembly/kinds.ts.
---

# Add an assembly part

Five steps. Step 3 is the one that produces wrong-but-plausible output, so it has
a hard rule attached — read it before touching [src/export/threemf.ts](../../../src/export/threemf.ts).

Ask for two inputs up front if they weren't given: the **source 3MF** and the
**verified reference 3MF** (step 3). They are usually different files, and you
cannot do step 3 without the second one.

## 1. Flatten the source 3MF, then prove it has triangles

`load3MF` ([src/geometry/meshparts.ts](../../../src/geometry/meshparts.ts)) only
reads meshes inlined in `3D/3dmodel.model`. Bambu's production-extension /
multi-part format instead references mesh data from a separate internal file via
`<component p:path="...">`, which `load3MF` can't resolve — the part loads
**empty, with zero triangles, and no error**. Inline the referenced `<mesh>` into
a single `<object>` first.

Verify before it goes in `public/stl/` — a silent empty part is the whole failure
mode:

```bash
unzip -p public/stl/<part>.3mf 3D/3dmodel.model | grep -c "<triangle"
unzip -p public/stl/<part>.3mf 3D/3dmodel.model | grep -c "p:path"
```

Triangle count must be non-zero; `p:path` count must be zero. Then add the
manifest entry in [public/stl/parts.json](../../../public/stl/parts.json) —
`{ "id", "name", "file": "stl/<part>.3mf" }`, where `id` is what the kind's
`libraryPartId` will point at.

## 2. Register one AssemblyKind

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

## 3. Bake export placement from a verified reference 3MF

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

## 4. Two orientations are intentional

The viewport shows the part **design-face-up** (how the artist sees it). The
export/plate pose is whatever the reference file verified as correct for
printing. These legitimately differ — the footrest stands on its long edge to
print support-free. Don't "fix" the mismatch by unifying them.

## 5. Ship a true-to-size template

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
