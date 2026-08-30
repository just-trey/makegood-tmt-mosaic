# Where Fill mode's tile union actually starts dropping tiles

**Result: failures start in a 503k-600k point band, not at the 800k this repo
quoted.** The old figure was an estimate taken from one live chair build; a
direct sweep puts the onset about a third lower, and the clean and failing
readings from two patterns overlap.

- Run 2026-08-30 on `daa4ea1`, WSL2, node v24.18.0, `@turf/turf` 6.5.0,
  `polygon-clipping` under it.
- Command: `node_modules/.bin/vite-node scripts/bench-tile-union.ts <pattern> <spans>`.
- The script drives the shipping path (`tileFeature` → `unionAllCooperative` →
  `safeUnion`) over the feature `computeNetRegionsByColor` builds for one colour
  of a bundled pattern. Only the grid is synthetic.
- Signal: points in the result. A failing run returns fewer points than a run an
  eighth its size, which is the tile dropping. The `merge failures` column beside
  it is yes/no, not a count: warnBuild dedupes on the exact message.

## zebra, colour `#0a0a0a`, 1361 points per tile

`vite-node scripts/bench-tile-union.ts zebra 13,17,18,19,20,21,25,31,38`

| tiles | points in | points out | merge failures | ms    |
| ----- | --------- | ---------- | -------------- | ----- |
| 169   | 230,009   | 216,739    | 0              | 8533  |
| 289   | 393,329   | 370,259    | 0              | 17721 |
| 324   | 440,964   | 415,024    | 0              | 18854 |
| 361   | 491,321   | 462,343    | 0              | 21191 |
| 400   | 544,400   | 512,216    | 0              | 24480 |
| 441   | 600,201   | 328,070    | 1              | 25806 |
| 625   | 850,625   | 473,460    | 1              | 37188 |
| 961   | 1,307,921 | 328,219    | 1              | 58802 |
| 1444  | 1,965,284 | 328,397    | 1              | 88941 |

## dalmatian, colour `#0a0a0a`, 559 points per tile

`vite-node scripts/bench-tile-union.ts dalmatian 27,28,29,30,31,32,36,40`

| tiles | points in | points out | merge failures | ms    |
| ----- | --------- | ---------- | -------------- | ----- |
| 729   | 407,511   | 398,359    | 0              | 10572 |
| 784   | 438,256   | 428,401    | 0              | 11592 |
| 841   | 470,119   | 459,535    | 0              | 12148 |
| 900   | 503,100   | 491,761    | 0              | 13119 |
| 961   | 537,199   | 279,841    | 1              | 14899 |
| 1024  | 572,416   | 279,841    | 1              | 15542 |
| 1296  | 724,464   | 428,679    | 1              | 20233 |
| 1600  | 894,400   | 279,943    | 1              | 26521 |

## What the two sweeps say together

- **Highest clean reading: 544,400** (zebra, 400 tiles).
- **Lowest failing reading: 537,199** (dalmatian, 961 tiles).
- They overlap, so **no single point count separates clean from failing**. Tile
  count is not the separator either: zebra fails at 441 tiles and dalmatian
  merges 900.
- Once past the onset the result collapses to roughly a fixed size (328k for
  zebra, 280k for dalmatian) whatever the input, which is what a partial result
  looks like rather than a proportional one.
- The failing runs do warn. Nothing here is silent in the "no signal at all"
  sense; what was missing is a cause, and the tech-debt item's framing of
  "silent data loss" means the geometry, not the pill.

## Wrong turns and null results

- **The first budget was 300k**, copied from `tests/patterns-assets.test.ts` on
  the argument that one number for one product is better than two. Measuring
  killed it: zebra carries 1361 points in its heaviest colour, so 300k refuses
  it above 220 tiles, and 220-400 tiles was measured clean. A shipped pattern
  would have stopped filling after one Scale move.
- **"Around 800k" is not reproducible.** Every reading at or above 600k failed,
  and two failed below it. The figure appears in `scripts/gen-patterns.mjs`,
  `tests/patterns-assets.test.ts` and `docs/troubleshooting.md`, and all three now
  carry the band instead. The asset test's constants and assertions are untouched,
  so its 300k budget is now a 1.8x margin rather than the 2.6x it read as.
- **cow and tiger cannot reach the ceiling.** They carry 24 and 149 points per
  tile, so at `MAX_FILL_TILES` = 1024 they ask for 25k and 153k. Only zebra and
  dalmatian are dense enough to sweep.
- **Total points, not tiles, is the better of the two available predictors**,
  but it is not a good one. A predictor that separated these eight readings
  would need the geometry, not a count.

## What was chosen

`TILE_UNION_VERTEX_BUDGET` = 500,000, in `src/geometry/patterns.ts`. Under every
failure measured, and it gives up two readings that did merge (544,400 and
503,100) at 13-24s each. The asymmetry is deliberate: a design let through that
then fails still reaches the pre-existing warning and the pre-existing partial
part, while a design refused that would have merged loses a fill it could have
had.
