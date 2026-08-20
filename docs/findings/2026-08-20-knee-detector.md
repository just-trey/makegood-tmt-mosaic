# The knee detector does not work

**Run**: 2026-08-20, on the working tree of `feat/colors-picks-itself`, parent `fd30816`. The `knee`
mode is part of this change. WSL2 / Chromium 149.0.7827.55 / Node 24.18.0.

**Reproduce**: `node_modules/.bin/vite-node scripts/bench-raster.ts knee red-sox-logo mario cartoon
ui-screenshot kid-drawing pattern-cow`.

**Revises** the Colors result in
[2026-08-19 raster corpus calibration](2026-08-19-raster-corpus-calibration.md), which reported the
knee "correct on 6 of the 8 sources whose right answer is clear". That was hand-scored off one
full-resolution curve. Scored by a mechanical rule, it is correct on at most 2 of 6 at any single
resolution. The problem that section describes is unchanged; its proposed solution is not viable.

## What was proposed

`docs/tech-debt.md` proposes picking the palette size automatically from a knee in the region-count
curve, the way blur and despeckle are already picked from the image. Nothing was built, so this
measured whether it could be.

## The measurement

The rule: walk `k` from 2 to 12, take the largest single-step jump in component count over uncapped
steps, and pick the `k` before it if that jump is at least 3x.

Each rung is a real browser decode at that size, and its trace parameters are derived the way
`parse.ts` derives them **for that size**, so a column is what the app would have produced had it
worked the image there. `blur` is shown because it differs by column and an earlier version of this
measurement held the largest column's blur on for all of them, which invented knees that do not ship.

| Source        | Right | @192 | @256 | @384 | @512  | @1024 |
| ------------- | ----- | ---- | ---- | ---- | ----- | ----- |
| pattern-cow   | 4     | none | none | none | none  | **4** |
| red-sox-logo  | 4     | 5    | 5    | n/a  | n/a   | n/a   |
| cartoon       | 6     | none | none | 4    | 3     | n/a   |
| mario         | 8     | none | none | 4    | **8** | none  |
| ui-screenshot | 6     | none | 4    | none | 4     | **6** |
| kid-drawing   | 6     | none | none | 3    | 3     | 5     |

`n/a` is a source smaller than the rung: `workingSize` never upscales, so there was nothing to
resample.

## Three findings

**1. It is wrong far more often than right.** At best 2 of 6 in any one column, and the two columns
that get two right are different columns. At 512, the largest size that costs under a second, it is
right once.

**2. The answer is unstable across resolution, in both directions and without a trend.** `mario`
picks 8 (correct) at 512 and nothing at 1024. `ui-screenshot` goes none, 4, none, 4, 6 across the
five sizes. `cartoon` picks 4 then 3 as the image grows. A detector has to choose one working size,
and no size is right for more than a third of the corpus.

**An earlier draft claimed the mechanism was that downsampling averages the fringe away, so the knee
exists only at full resolution. That is not what this shows.** `mario`'s knee exists at 512 and is
gone at 1024, the opposite direction. The curve is simply unstable: the quantizer lands on different
clusterings at different pixel counts, and the knee rule reads whichever jump that produced.

**3. It is not a knee.** `ui-screenshot`'s component curve over k = 2 to 12 at the working size:

```
8, 12, 17, 28, 27, 229, 277, 91, 57, 271, 604
```

It leaps 8.5x, falls to a third, leaps again. "Find the knee" assumes one bend. This has several, in
both directions.

## Cost

3.5 to 5.2 seconds for the full ladder at 1024; 0.5 to 1.2 seconds at 512; 0.1 to 0.7 seconds at 192. Nothing is cheap enough to hide inside an image load, and the cheap columns are the wrong ones.

A small source has no cheap-versus-expensive choice at all: `red-sox-logo` is 300x300, so every
column that exists for it is a small one, and both are wrong.

## What this does not settle

The section's complaint stands and is unfixed: a fixed default of 6 is wrong in both directions,
halos on a three-colour logo and lost colours on a nine-colour cartoon. Only the
knee-over-region-count approach is rejected.

A cheaper signal may exist. Distinct colours surviving a coarse quantize, or the ΔE spread of the
palette, would both be single-pass and neither has been measured. Nothing here recommends one.

The remaining option is to spend the time: run the ladder at full resolution behind the progress
curtain that already exists, accept about four seconds on load, and take a result that is right
about a third of the time. That is a product decision, and on these numbers a poor trade.

## Wrong turns

- **The trace parameters were derived once from the full working image** and reused for every
  smaller column, so the detail-pass blur stayed on where the app would have switched it off. That
  produced knees at 256 and 384 that do not exist in shipping behaviour: `pattern-cow` appeared to
  pick 4 at three small sizes and in fact picks nothing there.
- **The size ladder was a point-sampling resample in this file**, while the app area-averages
  through `drawImage`. The report's central claim at the time was about what averaging does to the
  fringe, and nothing in the run had averaged anything. Both are now real browser decodes.
- **The last column was keyed by each source's own working edge**, so sources smaller than a rung
  printed duplicate cells under different headers, and one source lost a column entirely.
