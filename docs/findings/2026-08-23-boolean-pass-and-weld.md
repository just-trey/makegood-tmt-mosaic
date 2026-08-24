# The two performance items: what they actually cost

**Measured 2026-08-23.** Commit `d5aaac8` (the branch base), Node 24.18.0, and Chrome via
Playwright against a Vite dev server.
Renderer: `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060), OpenGL ES 3.1)`.
Machine: Intel i7-10700 (8 cores / 16 threads, 2.9 GHz), 15 GB RAM, WSL2 kernel
6.18.33.2-microsoft-standard-WSL2.

Scripts, all added by this run:

| Script                                                               | What it measures                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| [bench-regions.ts](../../scripts/bench-regions.ts)                   | the paint-order boolean pass, in Node, split by phase      |
| [bench-regions-browser.mjs](../../scripts/bench-regions-browser.mjs) | the same pass, in Chrome, against the real module          |
| [bench-flat-rebuild.mjs](../../scripts/bench-flat-rebuild.mjs)       | a whole flat rebuild in the built app, plus screenshots    |
| [bench-shading.ts](../../scripts/bench-shading.ts)                   | `toCreasedNormals` on the chair's 13 parts, split by phase |

Both items came from the campaign plan with the same instruction: measure before writing any code.
Both measurements contradicted the tech-debt section that asked for them.

## Headline

- The boolean pass was **2066ms** on the dense SVG, not the ~9s tech-debt.md quoted. It is now
  **1177ms**, 1.76x, with per-color areas unchanged.
- The chair's creased shading is **697ms**, not the ~1.1s the "3.0s → 4.1s" reading implied.
- The vertex weld is **32%** of that shading, not the cause of it.
- The packed 3MF already carries a triangle index. `load3MF` expands it and throws it away.

## Item 1: the paint-order boolean pass

### Where the time went

Attribution by a replica of the shipping loop, validated against the real function: within 3% on
time and 0.000% on area for every corpus file. Percentages are of the whole pass.

| File                    | shapes |  total | shapeToFeature | cleanFeature |  engine |
| ----------------------- | -----: | -----: | -------------: | -----------: | ------: |
| Sunny MLP 2 (135 paths) |    140 | 2021ms |             0% |           5% | **95%** |
| dino ring               |     24 |  238ms |             0% |           6% | **93%** |
| snoopy                  |     35 |  156ms |             0% |           8% | **92%** |
| dalmatian               |     30 |   58ms |             0% |           8% | **91%** |

Two hypotheses died here:

- **Turf's wrappers are not the cost.** `turf.union` is a one-line pass-through to the same
  `polygon-clipping` the app would call directly. The evidence is the replica validation above:
  `replicaPairwise` calls the engine directly and pairwise, the real pass called Turf and pairwise,
  and they landed within 3% of each other on every file. (Do not cite the `n-ary batch=1` row for
  this — it also merges each colour n-ary, so it is not a clean wrapper-only comparison.)
- **The triple scrub is not the cost.** `safeUnion`/`safeDiff` clean _both_ inputs on every call,
  so the accumulator was scrubbed three times per shape. Cleaning once up front measured
  1.02-1.06x. Real waste, no money in it.

### What worked

n-ary sweeps. Collect per-color pieces and union them in one call, and fold the accumulator in
batches, subtracting the batch's not-yet-folded shapes in the same n-ary difference.

Browser, real module, median of 5, before → after:

| File                    | before |  after |   speedup |
| ----------------------- | -----: | -----: | --------: |
| Sunny MLP 2 (135 paths) | 2066ms | 1177ms | **1.76x** |
| dino ring               |  254ms |  123ms |     2.07x |
| snoopy                  |  173ms |   98ms |     1.77x |
| smurfette               |   69ms |   45ms |     1.53x |
| pappa                   |   56ms |   37ms |     1.51x |
| dalmatian               |   53ms |   18ms |     2.94x |

Both columns are one paired session on the same machine, the second taken with `main`'s
`regions.ts` swapped in, so the two sides share a JIT, a browser and a thermal state. Earlier
drafts of this table mixed readings from different sessions and drifted by up to 8%.

Areas were unchanged on all six files: 0.000% worst per-color relative drift in the Node bench,
and a summed area matching to all three decimal places the browser bench prints. Neither check is
a bit comparison, and the engine is free to emit the same region with different vertices, so
"unchanged area" is the claim and "identical output" is not.

### The batch size is measured, and the obvious value is a trap

Never folding the accumulator (`batch=all`) is the fastest setting on the 140-shape file, 4.53x.
It is also the worst possible choice, because every difference then carries every shape above it:

| shapes | batch=8 | batch=32 | batch=128 | batch=all |
| -----: | ------: | -------: | --------: | --------: |
|     50 |   1.88x |    2.49x |     3.02x |     2.95x |
|    100 |   1.75x |    1.51x |     0.97x |     0.95x |
|    200 |   1.90x |    1.48x |     0.76x | **0.38x** |
|    400 |   1.78x |    1.33x |     0.48x | **0.09x** |

Big batches win at 50 shapes and lose catastrophically by 400. 8 is the setting that never loses,
which is what a constant compiled into the app has to be. Swept 2/4/6/8/12/16 as well: flat between
4 and 12, so 8 sits on a plateau rather than on a peak someone has to defend. It also bounds one
engine call, which is what keeps the pass's 30ms yield budget honest — `batch=all` is a single
multi-second sweep with no frame to give back.

**These numbers replace an earlier set that read 2.45x at n=50.** `scaling` and `variants` ran the
baseline cold while `attribute` warmed it, so the baseline absorbed the JIT warm-up and every
candidate read faster than it was: 324ms cold against 230ms warm at n=50. All three modes now warm
every timed path first. The plateau conclusion survived the correction; the headline number for
n=50 did not.

### The retry ladder is load-bearing, and that is a measurement too

The first pass at the candidates skipped `boolOpWithRetry`'s truncate ladder. They looked faster
and drifted up to **8% in area**, because an op that threw fell back to a degraded answer. Every
such failure is a user-visible warning. With the ladder restored, every candidate returned 0.000%
drift and zero unrescued failures. A variant that is fast because it threw more is not faster.

### Null result: the whole-rebuild clock cannot see this

`bench-flat-rebuild.mjs` times what the user waits. On an unchanged build, five runs of the same
file gave 4.80, 5.00, 8.14, 8.20, 8.00 seconds. A single before/after pair on that instrument can
show a speedup or a regression on identical code. It is kept for what it does resolve: across the
change, on all four files, triangle count, colour count and the warning list were unchanged and the
canvas screenshots were **byte-identical**.

That noise also means the section's original ~9s figure could not have been a careful reading.

## Item 2: the display-mesh weld

Measured, not built. The prototype is in `bench-shading.ts`, not in `src/`.

### The chair's 13 parts, 368,330 triangles

| Pass                                       |           cost |
| ------------------------------------------ | -------------: |
| `computeVertexNormals` (flat, pre-#140)    |           27ms |
| `toCreasedNormals` (shipping)              |      **697ms** |
| of which pass 1 (face normals + bucketing) | 273ms, **39%** |
| of which the bucketing alone (the weld)    | 225ms, **32%** |

**So the weld is not the cost; it is a third of it, and the averaging pass is the larger half.**
Stable across three warmed runs (39/39/38% and 33/32/32%).

But pass 2 re-hashes all three corners of every triangle to look the bucket up again, so string
hashing is the majority of the whole function across both passes. The lever is "stop hashing
strings", not "reuse the weld" — and an index removes the hashing from both passes at once, which
is why the prototype below beats it by more than pass 1's share would allow.

The 368k triangle figure in tech-debt.md is confirmed exactly. The 3.0s → 4.1s reading is not:
697ms is what the shading costs, so roughly 400ms of that 1.1s delta belongs to something else
that was never identified.

**An earlier draft of this section said 36% for "the weld", from a helper that was neither the
verbatim pass nor warmed.** It skipped pass 1's per-triangle cross product and `Vector3`
allocation, and it was the one timed path the bench never warmed, which pushed its share up. Both
are fixed and the bench now reports the two figures separately.

### The index was there all along

`load3MF` ([src/geometry/meshparts.ts](../../src/geometry/meshparts.ts)) reads the 3MF's
`<triangle>` elements, which _are_ a vertex index, expands them into a soup, and returns the soup
plus a bare vertex list. The index is discarded.

This matters because the section proposed reusing `bodyIndexed` from `AssemblyPartOutput`, which
only exists after a boolean. A bare chair load has no boolean anywhere in it —
`renderRawAssemblyParts` shades `part.positions` directly — so on the path the 4.1s was measured
on, `bodyIndexed` is not available and never was. The file's own index is.

### The prototype

Crease-aware normals from the index: face normals, then vertex-to-face adjacency as a counting
sort into two typed arrays, then a per-corner average over incident faces inside the crease angle.
No strings, nothing allocated per triangle.

| Pass                                          | chair total | vs shipping |
| --------------------------------------------- | ----------: | ----------: |
| `toCreasedNormals`                            |       686ms |          1x |
| from the file's index                         |    **96ms** |    **7.2x** |
| exact-position weld first, then the same pass |       269ms |        2.6x |

Agreement with `toCreasedNormals`: **892 of 1,104,990 corners** differ by more than 1° (0.08%),
worst 24.9°, mean 0.011°.

### Two wrong turns worth keeping

- **The first agreement run reported a worst case of 90°.** Those were zero-area triangles. Every
  normal pass invents something different for a degenerate face, and a triangle covering no pixels
  cannot be a shading defect. Excluding them dropped the worst case to 24.9°. The count of
  degenerate faces is now part of the bench.
- **The remaining disagreement is not unwelded duplicate vertices.** That was the obvious guess,
  since `chair-storage-left` shows 23,244 vertices against 22,639 hash buckets. But those buckets
  are the 0.01mm truncation, not distinct positions: counted exactly, the part has **23,244
  distinct positions**, and so does every part checked. There are no duplicates to fuse. Fusing
  first duly changed the agreement by nothing at all, on all 13 parts, and cost 170ms. Everything
  `toCreasedNormals` merges beyond exact sharing is the bucket approximation, which the tech-debt
  section already flags as a hazard for user STLs.

### What is still owed before this can ship

A user-uploaded STL arrives as soup with no index (`STLLoader`), so it needs a weld of its own.
**The 269ms "fused" column above is not that cost** and must not be quoted as it: fusing keys 23k
unique vertices per part, while a soup has no vertex list and must key all 1.1M corners. That is
the same work the bench's hash column prices at 225ms for the whole chair, so the STL path is roughly
225 + 96 = 321ms against 686ms, about **2x** rather than 7.2x. Estimated by adding two measured
halves, not measured end to end, because the path does not exist yet.

It is also a different weld from the one `toCreasedNormals` does: exact rather than bucketed to
0.01mm. Whether that changes how a user's own STL shades is unmeasured, and it is the same cosmetic
risk the tech-debt section already records in the other direction.
