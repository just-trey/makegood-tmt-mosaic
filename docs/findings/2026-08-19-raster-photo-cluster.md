# The photo cluster, on seven photographs instead of one

**Run**: 2026-08-19, on the working tree of `bench/raster-stock-probes`, parent `8b780d8`. The
fetch script, the stock corpus entries and the `sizes` mode are all part of this change, so
`8b780d8` alone cannot reproduce it. WSL2 / Chromium 149.0.7827.55 / Playwright 1.61.1 / Node
24.18.0.

**Reproduce**: `node scripts/fetch-raster-stock.mjs`, then
`node_modules/.bin/vite-node scripts/bench-raster.ts corpus` and `… sizes`.

**Revises** [2026-08-19 raster corpus calibration](2026-08-19-raster-corpus-calibration.md).
That report's result 1 said the flat and photo clusters overlap and the statistic may need
replacing. It measured one photograph. With seven, **six of them separate cleanly from the flat
cluster and the shipping cutoff sits inside that gap.** The seventh is the original balloon, still
inside the flat band, so `gap (all)` stays negative and this report argues its exclusion rather
than hiding it. Results 2 through 5 of that report are unaffected.

What this exercises is `PHOTO_RESOLUTION_CUTOFF` (0.285), the midpoint. `FLAT_EDGE_DENSITY` (0.12)
and `PHOTO_EDGE_DENSITY` (0.45) set where the parameters _interpolate_, and this run does not test
them. If anything it is mild evidence against the flat endpoint: real flat art reaches 0.2532, more
than twice 0.12.

## Result

Six CC-licensed photographs from Wikimedia Commons, fetched by `scripts/fetch-raster-stock.mjs`
and tagged `stock` so they are never pooled with the real files.

| Source                         | Provenance | edgeDensity @512 | Reads |
| ------------------------------ | ---------- | ---------------- | ----- |
| pattern-cow                    | real       | 0.0034           | flat  |
| … five more flat-art sources … |            |                  | flat  |
| red-sox-logo                   | real       | 0.2531           | flat  |
| **mario**                      | real       | **0.2532**       | flat  |
| _cutoff_                       |            | _0.285_          |       |
| **stock-bokeh-food**           | stock      | **0.2905**       | photo |
| stock-foliage                  | stock      | 0.4149           | photo |
| stock-crowd                    | stock      | 0.5022           | photo |
| stock-night                    | stock      | 0.5193           | photo |
| kid-drawing                    | real       | 0.6028           | photo |
| stock-brick                    | stock      | 0.7185           | photo |
| stock-gravel                   | stock      | 0.9189           | photo |

- Flat art tops out at **0.2532**.
- Photographs start at **0.2905**.
- The gap is **0.0373 wide**, and `PHOTO_RESOLUTION_CUTOFF` (0.285) sits inside it.
- **All six photographs read photographic. Every one.**

The statistic works. It was never given a busy photograph to score.

## The one real overlap, and why it is not a counterexample

`photo` (a hot air balloon against a clear sky) reads 0.1762, inside the flat cluster. That is
correct about the file: large flat colour panels over a smooth gradient, with almost no transition
anywhere. It is a photograph whose _content_ is flat art, and flat-art treatment is the right
treatment for it.

The earlier report generalised from that single file to "the statistic does not separate
photographs from flat art". It separates them on content, which is what the trace parameters
actually need to know.

## The confound, checked rather than assumed

The stock photographs are 3024px to 6244px on the long edge, against 1600px for the balloon
(1321x1600) and 1588px for mario. Long edge is what matters: `workingSize` scales by it.
Bigger source means heavier downscale to `MEASURE_EDGE`, so the separation could have been an
artefact of size rather than content. `bench-raster.ts sizes` measures each file at four sizes:

| Source           | @256        | @512        | @1024       | @1600              |
| ---------------- | ----------- | ----------- | ----------- | ------------------ |
| mario (flat art) | 0.433 photo | 0.253 flat  | 0.155 flat  | 0.123 flat (@1588) |
| photo (balloon)  | 0.253 flat  | 0.176 flat  | 0.119 flat  | 0.092 flat         |
| stock-gravel     | 0.968 photo | 0.919 photo | 0.830 photo | 0.754 photo        |
| stock-crowd      | 0.580 photo | 0.502 photo | 0.428 photo | 0.377 photo        |
| stock-bokeh-food | 0.425 photo | 0.290 photo | 0.224 flat  | 0.253 flat         |

**Density falls as measurement size rises**, for four of the five. It is a tendency rather than a
law, and the table shows the exception: `stock-bokeh-food` turns back up between 1024 (0.224) and
1600 (0.253), presumably as its defocus starts to band.

The argument does not need the universal, only the direction on the files in question. The stock
files are the most heavily downscaled and still score highest, so the confound runs against the
result rather than producing it.

Two more things push the same way, and both were reasons to distrust stock imagery before it was
measured:

- Curated photography favours shallow depth of field and heavy noise reduction, which lower edge
  density. The set still cleared the cutoff six times out of six.
- `stock-bokeh-food` was chosen as the control that _should_ read flat, most of its frame
  defocused. It reads 0.2905, barely over the line. The one deliberately unfavourable case is the
  one that lands closest to the boundary, which is what a working statistic looks like.

## What this does not establish

**Where the photo cluster sits for this app's users.** Six of the seven photographs are curated
Commons uploads. They answer "can edge density score a busy photograph high" (yes, decisively).
They cannot answer "what do volunteer uploads score", because they are not a sample of that
population. A phone snapshot corpus would still be worth having, and would most likely land between
the balloon and the stock set.

The narrower question is settled, and it was the one blocking a decision.

## What survives from the earlier report

Result 2 is untouched and is now the **only** open defect in the thresholds: a source under 512px
is pushed toward photo treatment by its size alone. The size table above shows it on flat art
rather than on a rasterized pattern: **mario reads photographic at 256px** (0.433) and flat at
512px (0.253). Same file, same content.

That is worth fixing. The clusters are fine; the resolution dependence is not.

## Provenance

`stubs/raster stock/provenance.json` records title, author, licence and Commons URL per file.
Licences are CC0, CC BY 2.0, CC BY-SA 2.0/3.0/4.0. Files stay in gitignored `stubs/` and are never
redistributed; the fetch script makes the stock half reproducible from a clean checkout, which the
earlier report listed as a weakness.

It fixes that half only. `stubs/` is gitignored, so a clean checkout still cannot recover
`red-sox-logo`, `cartoon`, `mario`, `ui-screenshot`, `kid-drawing` or the balloon. What survives is
the five `public/` sources and the authored SVG. The bench skips the rest with a notice naming each
one and why, so an incomplete run says so rather than quietly reporting a smaller corpus:

```
note: skipping 12 source(s) not present: red-sox-logo, cartoon, mario, …
      lives in gitignored stubs/ and cannot be rebuilt from a clean checkout
      fetched, not committed: run `node scripts/fetch-raster-stock.mjs`
      also skipping photo-jpeg-q40, derived from a skipped source
```
