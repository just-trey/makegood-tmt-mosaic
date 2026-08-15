# Trying to trace a real warning to the seam sliver

**Result: could not. No sighting.** Reported so the next person doesn't repeat the same attempts,
and so the tech-debt entry's own instruction — "Confirm one before spending the fix on it" —
stays unspent rather than quietly satisfied.

**Driven 2026-08-08.** Commit `c2d7767`, production build, `vite preview`, `MOSAIC_GPU=1`.
Renderer: `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060), OpenGL ES 3.1)`.
Chair body, Standard variant, all five zones bound.

## What was being hunted

[tech-debt.md](../tech-debt.md), "A seam sliver warns as if artwork were lost". Where two parts'
baked claims on a zone overlap, clipping one colour to one part's `subRegions` can leave a remnant
a fraction of a millimetre wide. It survives the turf clip, reaches `buildCutter`, yields nothing,
and [assembly.ts:745](../../src/geometry/assembly.ts#L745) reports

> Couldn't build the cut solid for color #xxxxxx on "Part".

which is the same sentence a real, artwork-losing failure produces. The overlaps are measured and
small: 23 overlapping part pairs, all seam-sharing, worst 29.85 mm² on a 124,500 mm² zone — about a
0.15 mm ribbon. The entry says plainly that the 2026-07-28 sighting it used to cite turned out to
have a different cause, and that no warning has actually been traced to the remnant.

## What was driven

**Pass 1 — 18 configurations.** A three-colour checkerboard at 4×4, 8×8 and 14×14 cells (so a
great many colour boundaries land somewhere near a seam), each at 150% and 300% scale, each at
0 mm, 0.5 mm and 1 mm offset. Sub-millimetre offsets on purpose: a remnant that is 0.15 mm wide
should appear and disappear under a nudge far smaller than any feature of the design, which is a
signature no other failure has.

Result: **0 cut-solid warnings in all 18.**

**Pass 2 — the finer, rotated version, with the thing pass 1 forgot.** Pass 1 recorded only the
warning count, which is a check that cannot fail if nothing is being built — the exact shape the
other report on this page is about. Pass 2 records the triangle count and the detected colour count
per configuration, so "no warnings" is a statement about a build that demonstrably happened:

| rotation | triangles | warnings |
| -------- | --------: | -------- |
| 0°       | 2,369,022 | 0        |
| 7°       | 2,383,528 | 0        |
| 23°      | 2,395,530 | 0        |
| 45°      | 2,393,818 | 0        |

A 900 mm 24×24 checkerboard, 3 colours, bound to all zones — 2.4 million triangles of cut chair per
configuration, and shallow rotations specifically so colour boundaries cross seams at an angle
rather than square-on.

**Pass 3 — proving the detector is live.** Zero warnings is only evidence if the collection path
works. Forced with `?csgfault=difference` on the wheel, the same
`window.__mosaic.warnings()` read and the same filter caught 3 of the 4 warnings raised:

```
Boolean cut failed on part "Top" — exporting it uncut and without inlays …
Boolean cut failed on part "Bottom" — …
Boolean cut failed on part "Cap" — …
```

So the hunt could see a warning if one had been raised.

## What this does and does not establish

**It does not show the remnant isn't real.** The remnant is geometry, it is measured, and
`tests/chair-zones.test.ts` pins the overlap areas. Nothing above touches that.

**It does show the remnant does not reliably reach `buildCutter` as a lone region.** Reading the
branch that emits the warning
([assembly.ts:706–745](../../src/geometry/assembly.ts#L706)) suggests why, and this is the useful
part of the negative result: the warning fires per **region**, after the region has already
survived (a) the boundary clip, (b) `buildCutter`, (c) `soupToManifold` + validity, and (d) a
`repairSelfIntersections` retry. A 0.15 mm ribbon on a seam is almost never a region by itself —
it is a hair on the edge of a much larger region of the same colour on the same part, and that
region extrudes fine. For the remnant to warn it would have to be **the whole of** one colour's
claim on one part, which needs the design's ink to touch that part _only_ inside the overlap
ribbon.

That is a much narrower target than "put a busy design on the chair", and it is not something 22
placements of a checkerboard will stumble into. **The next attempt should construct it rather than
sweep for it**: place a small solid shape deliberately straddling one known seam so that its
footprint on the far part is a sliver and nothing else. The 23 overlapping pairs are enumerable
from the shipped bake (`chair-body-zones.json`), so the seam to aim at can be chosen rather than
guessed, and the worst pair (29.85 mm²) is the one to aim at.

## Recommendation

**Do not spend the fix yet, and do not delete the tech-debt entry either.** The entry's own
condition is unmet, and this run narrows why: the sweep approach cannot reach it. What it should
gain is the paragraph above — that the remnant must be a colour's _entire_ claim on a part to
warn, which is what makes it rare, and that the construction is the way in. Two sweeps of a busy
design across a whole chair is now a recorded dead end.

One thing worth noting on the way past: **2.4 million triangles of cut chair at four rotations
produced no warnings of any kind at all.** That is the CSG path behaving well under considerably
more load than any volunteer design will put on it, and it is the more reassuring result of the
two.
