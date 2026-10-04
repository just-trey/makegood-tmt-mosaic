# Fill's tile-union ceiling is an exact per-call cap, and the next limit is memory

**Result: the "503k-600k band" was polygon-clipping's hard 500,000-segment cap
per call, seen through the wrong count.** Splitting calls that pass it removes
it for every fill made of separate pieces. One polygon over it can't be split,
so that case is refused at build time. The next ceiling is Manifold's WASM heap,
between 658,724 and 719,969 points on a 240mm face.

- Run 2026-09-24 on `fix/tile-union-batch` over `caecf96`, WSL2, node
  v24.18.0, `@turf/turf` 6.5.0, `polygon-clipping` 0.15.7.
- The machine was shared with other agents' runs, so times vary by up to 2x
  between repeats. Pass/fail and the point counts do not.
- "main" rows ran `2ddf803`'s `src/` with the same bench script.

## The cap

- polygon-clipping 0.15.7 queues two sweep events per segment and throws "queue
  size too big" past 1,000,000. That is **500,000 input segments per call**.
- It is exact: 125,000 unit squares (500,000 segments) union in one call, and
  one square more throws. `npx vitest run tests/regions-sweep-cap.test.ts`,
  "SWEEP_SEGMENT_CAP".
- The old sweep counted input _points_, and the call that failed was the last
  merge, whose inputs are already welded. Hence a band instead of a line.
- The cap applies to every call, not only the union. The clip to the face,
  the mirror clip, the net-share clip and the subtraction of stickers all take
  the whole fill.
- **It is not the only limit.** The engine also throws once its sweep line
  holds 1,000,000 pieces, which crossings multiply. 500 unit strips across
  unioned with 500 down (4,000 segments) throw "too many sweep line
  segments". Same test file, "the engine limit on crossings". Found by a
  review finder, after the sweeps below.

## The union, before and after

`node_modules/.bin/vite-node scripts/bench-tile-union.ts <pattern> <spans> [colour]`.
`areaKept` is the tiled area over tiles times one tile's area; every bundled
pattern draws inside its own cell, so a clean union reads 1.

| pattern / colour    | tiles   | points in | main areaKept | branch areaKept | branch ms |
| ------------------- | ------- | --------- | ------------- | --------------- | --------- |
| zebra `#0a0a0a`     | 400     | 544,400   | —             | 1.000000        | 26,993    |
| zebra `#0a0a0a`     | 441     | 600,201   | 0.580499      | 1.000000        | 24,275    |
| zebra `#0a0a0a`     | 625     | 850,625   | —             | 1.000000        | 34,105    |
| zebra `#0a0a0a`     | 1024    | 1,393,664 | 0.250000      | 1.000000        | 56,189    |
| zebra `#0a0a0a`     | 3 x 300 | 1,224,900 | 0.284444      | 1.000000        | 50,697    |
| dalmatian `#0a0a0a` | 900     | 503,100   | —             | 1.000000        | 14,851    |
| dalmatian `#0a0a0a` | 1024    | 572,416   | —             | 1.000000        | 13,922    |
| dalmatian `#f4f4f2` | 900     | 499,500   | —             | 1.000000        | 17,652    |
| dalmatian `#f4f4f2` | 961     | 533,355   | 0.532778      | refused         | 18,172    |

- Commands: `zebra 20,21,25,32,3x300`, `dalmatian 30,31,32`, `dalmatian 30,31
'#f4f4f2'`, and the main rows with `zebra 21,32,3x300` and `dalmatian 31
'#f4f4f2'`.
- **Dalmatian's background welds into one polygon** with every spot as a hole.
  At 961 tiles that polygon alone passes the cap, so no split helps: the
  branch refuses it, where main kept 53% of it.

## Wrong turns

- **The brief's "batch the union, merge the results" can't work as stated.**
  The merge is the call that fails, and its size is the fill's own. What works
  is keeping polygons out of reach of the other side out of the call.
- **Box narrowing alone left long fills failing.** A 3 x 300 zebra grid still
  lost tiles until the merge also halved an over-cap seam and merged the halves
  in turn. That reading came from an unkept copy of the bench; the 3x300 row
  above is the shipped bench on the final code.
- **An unsplittable union was first sent to the engine anyway.** The retry
  ladder makes four doomed attempts: each of the three over-cap tests took
  8.8-9.3s to fail with `src/geometry/regions.ts` at `2ddf803`
  (`npx vitest run tests/regions-sweep-cap.test.ts -t "past the clipping"`). The
  branch counts segments first, and does not retry a size limit.
- **A group of 125,000 polygons was pushed with `push(...array)`**, which blows
  the call stack. Caught by `tests/regions-sweep-cap-failure.test.ts`.

## The whole build past the old budget

`node_modules/.bin/vite-node scripts/bench-fill-build.ts <pattern> 240 <scale> [0.5]`,
with `FILL_POINT_BUDGET` set to `Infinity` in `src/geometry/patterns.ts` so
nothing was refused before running. A 240mm square face on a 10mm box.

| pattern   | scale | shift | tiles | points  | result                    | inlay tris | ms      |
| --------- | ----- | ----- | ----- | ------- | ------------------------- | ---------- | ------- |
| zebra     | 0.5   | 0     | 121   | 164,681 | filled                    | 633,024    | 81,487  |
| zebra     | 0.25  | 0     | 361   | 491,321 | filled                    | 2,469,944  | 358,223 |
| zebra     | 0.23  | 0.5   | 400   | 544,400 | filled                    | 2,916,036  | 311,935 |
| zebra     | 0.235 | 0     | 441   | 600,201 | filled                    | 2,793,876  | 285,419 |
| zebra     | 0.21  | 0.5   | 484   | 658,724 | filled                    | 3,499,582  | 390,192 |
| zebra     | 0.2   | 0     | 529   | 719,969 | cut failed, no artwork    | 0          | 298,308 |
| dalmatian | 0.145 | 0.5   | 900   | 503,100 | filled                    | 3,244,470  | 440,522 |
| dalmatian | 0.14  | 0     | 961   | 537,199 | refused (background weld) | 4,244      | 29,481  |

- The 529-tile failure is `Manifold.difference` throwing "memory access out of
  bounds": the 32-bit WASM heap. Peak RSS 5.4GB, with the budget lifted as
  above:
  `/usr/bin/time -v node_modules/.bin/vite-node scripts/bench-fill-build.ts zebra 240 0.2`.
- The 121-tile row on main took 68,528ms; the rest were refused there.
- The bench's tile count was checked against main's own refusal: 529 tiles of
  1361 points at scale 0.2, both ways.

## What was chosen

- `FILL_POINT_BUDGET` = 600,000 (renamed from `TILE_UNION_VERTEX_BUDGET`). It
  now bounds the cut's memory, not the union. It admits 544,400 and 503,100
  and sits 17% under the 719,969 failure.
- It is not removed: past it the part exports with no artwork, which is worse
  than one tile and a warning.
- It stays a points-in-one-colour count, which is only a proxy for memory.
  Memory follows the part's mesh too, and only one part shape was measured.
