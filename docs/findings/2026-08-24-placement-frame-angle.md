# The placement frame's angle: measured, and it is a bug

**Run**: 2026-08-24, commit `a128feb`, WSL2 / i7-10700 / RTX 2060, `MOSAIC_GPU=1`.
**Question**: tech-debt §8 asks whether the frame's arbitrary-looking angle is a genuine bug in
the placement math or a rendering choice. It says the two close very differently.

**Answer: a bug.** On a design face that is not horizontal the frame is drawn in a horizontal
plane, 90.0° off the face, in the confident colour, and on every part that clips its cut the
artwork lands nowhere at all.

## What was measured

`scripts/measure-frame-angle.ts`, over the three file-based design meshes a user can reach today
(chair-body is withheld from the UI, PR #133). For every patch the part panel offers, the angle
between the real face normal and the plane `FlatZoneMapper.frameAt()` draws the frame in, plus
the X/Z area the cut is clipped to.

| Part          | Patches offered | Frame off the face | Cut clip on those |
| ------------- | --------------- | ------------------ | ----------------- |
| wheel-half    | 6               | 3 (ranks 3-5)      | 0 mm²             |
| wheel-hub-cap | 6               | 1 (rank 5)         | unbounded         |
| footrest      | 6               | 4 (ranks 2-5)      | 0 mm²             |

- **8 of 18 selectable patches put the frame 90.0° off the face.** Not a spread: every misaligned
  case is exactly 90.0°, because `frameAt` returns literal constants (uAxis (1,0,0), vAxis
  (0,0,1), normal (0, ±1, 0)) whatever the part is shaped like.
- **7 of those 8 clip the cut to exactly 0 mm²**, and every aligned patch clips to its own area
  (29403, 14588, 54688, …). On those seven nothing is cut at all, so the build's "the cut may be
  wrong" understates it.
- **The eighth is not clipped, and this measurement does not say what it cuts.** `wheel-hub-cap`
  sets `cutThrough`, and `boundary()` skips the clip entirely on a cut-through part: the design is
  meant to span the whole curved surface and the boolean against the real mesh is what bounds it.
  So the one cut-through part in the set takes a different path on a sideways face, and what it
  produces there is untested. Driving it is the follow-up this section owes.
- **Every kind's default face is correct**: normal (0, 1, 0), 0.0°, on all four parts across the
  three kinds. Read from the app, not from the ranking: `defaultPatchIdx` prefers the role's
  `preferFaceNormal` over rank 0, and the footrest and hubcap both default to rank 1. That is why
  this never shows in ordinary use, and it is consistent with the 2026-08-16 sighting on the wheel
  having been the `<circle>` anchor hijack (fixed in PR E) rather than this.

**The hubcap's design disc is not in the table**, and that is not an omission. The `hubcap` role's
library asset is the four mounting clips alone; `buildMesh` generates the disc the design lands on
at `state.hubcapDiameterMm`, so the part's mesh is never `hubcap-clips.3mf`. Its default face
reads (0, 1, 0) in the driven run, via the `preferFaceNormal` that role carries precisely because
auto-detect would otherwise land on the disc's back.

## What the user sees

Driven run on the footrest, switching the design face from #2 (normal 0,1,0) to #3
(normal 0,0,-1). Screenshot: the frame is a small quad **floating in empty space below and right
of the part**, with its rotate handle, and the footrest carries no artwork.

Two warnings fire, both accurate about the outcome:

```
Part "Footrest": detected face normal (0.00, 0.00, -1.00) isn't vertical. Assembly cutting
assumes a horizontal face — pick a different face or the cut may be wrong.
2 colors land entirely off the part and won't print: "#c1272d", "#f5d020". Lower Scale or move
the design to bring them back.
```

So this is **not silent**, which is the one thing that keeps it off the critical list. It is
still a frame drawn confidently in a place the artwork can never go.

## Three separable defects, in the order they bite

1. **The frame is drawn on the wrong plane.** `FlatZoneMapper.frameAt` hardcodes a horizontal
   basis. `faceY` even has a fallback for this case (`Math.abs(nrm[1]) > 0.1 ? topZ / nrm[1] :
topZ`), so the code knows the case exists and draws through it anyway.
2. **The gizmo cannot warn about it.** The amber off-surface state keys on `offSurfaceMM`, and
   the flat path returns `offChartMM: 0` unconditionally. The one state that exists to say "this
   frame is not where the cut is" is unreachable on every flat part.
3. **The face status line goes stale. Fixed in this PR.** `buildAsmPartRow`'s change handler
   called `applyAsmPatchChoice` and `scheduleRebuild` but never `renderAssemblyPartList`, so after
   switching to face #3 the panel still read `face detected: normal (0.00, 1.00, 0.00)`,
   disagreeing with the dropdown directly above it. It now recomputes the line in place through
   `faceStatusText`. Re-rendering the row instead would destroy the `<select>` mid-event and
   collapse the disclosure around it, which is why it is a text update rather than a re-render.

## Null results and wrong turns

- **The conformal path is not affected, and was the first suspect.** A chart's `frameAt` derives
  uAxis from ∂S/∂u of the triangle's UV map and projects it off the smooth normal, and the
  conformal placer maps SVG straight into that same chart UV. Frame and cut agree by
  construction. An odd-looking angle there would be the bake's choice of chart orientation, which
  is a different section. The chair is also withheld from the UI, so it is not the live instance.
- **The duplicate-part rotation looked like a second bug and is not.** `placer` applies
  `rotatePointY` for `part.isDuplicateOf` and `frameAt` applies nothing, but `gizmoMappers`
  filters duplicates out before either runs, so the branch is inert.
- **A partial `.d.ts` for `scripts/lib/mesh.mjs` is the wrong way to import it from a `.ts`
  bench.** Adding one shadowed the module for `tests/meshmatch.test.ts`, which imports six other
  members behind a `@ts-expect-error`. The established pattern is that `@ts-expect-error`, not a
  shim that has to list every export.
- The area threshold was not the issue: `buildAsmPartRow` slices the ranked patch list at 6 with
  no orientation filter, so a sideways face is offered on every part. It does sit behind the
  "Advanced: per-part face & alignment" disclosure.
- **The bench hardcoded `cutThrough: false` and published a clip area the app never computes.**
  `wheel-hub-cap`'s role sets it true, and `boundary()` skips the clip entirely on a cut-through
  part, so its six rows read 840/693/62/25/11/0 mm² where the real answer is "no clip". Found in
  review, not by the bench. It now reads the flag off the shipped role. Same lesson as the
  `hubcap-clips` row below: a stub part is a second copy of the real one, and it drifts.
- **The bench also restated the rest of `applyAsmPatchChoice`, and that was the root of both.**
  It set `topZ`, `patchNormal` and `boundaryLoops` by hand, dropping the area sort that makes
  `boundaryLoops[0]` the outline rather than a hole. It now calls the exported function instead,
  which is shorter and cannot drift. The table is byte-identical either way, so no published
  number moved.
- **A review claim that the sort was inert "because every patch returns one loop" was wrong.**
  Asserting that precondition made the bench throw immediately: a patch returns 3. The sort is
  inert for a different reason (`shapeToFeature` nests by containment, not by order). Worth
  recording because the assertion is what caught it, and the tidier-looking fix would have
  shipped a false comment.
- **The bench measured `hubcap-clips.3mf` for a run, and that is a face nothing designs on.** The
  disc is generated. Caught by the driven run reporting a 37312mm² default face where the bench's
  largest patch was 322mm². Corrected by dropping the part, which also moved the headline from
  "12 of 24" to 8 of 18. This is the PR-K failure verbatim: a report reading numbers off rows the
  shipping code never uses.
- **"Rank 0 is the default face" was wrong, and the report asserted it before checking.**
  `defaultPatchIdx` prefers the role's `preferFaceNormal`, and two of the four parts default to
  rank 1. The conclusion survived, but only by luck: both rank-1 defaults are horizontal too. The
  bench no longer names a default at all, and the driven run supplies it.

## How far it reaches

All 8 measured cases need a deliberate pick from the design-face dropdown, behind the
"Advanced: per-part face & alignment" disclosure. That bounds the fix.

A **user-uploaded** STL exported Z-up would hit all three defects at its _default_ face with no
interaction at all, since only `pack-part.mjs` guarantees the shipped parts' alignment. But the
STL/3MF drop target is offered only where the parts library is unreachable (`buildAsmPartRow`'s
docstring says exactly that), so it is a degraded-mode path rather than a normal one. Not driven,
in either mode.

**A rotated duplicate never gets the face change at all**, and that is a wrong cut rather than a
wrong label. `asmAddDuplicate` copies `patchIdx`, `patchNormal`, `topZ`, `boundaryLoops` and
`restPositions` at duplication time, and a duplicate row carries pivot and angle controls but no
design-face control. So changing the wheel's Top face leaves its Bottom half cutting on the face
it was duplicated with. Pre-existing, found in review of this change, and left open as its own
tech-debt item: closing it is about the duplicate's lifecycle, not about the frame.
