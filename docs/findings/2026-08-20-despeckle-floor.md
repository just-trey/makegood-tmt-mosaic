# The despeckle floor did not hold, and raising it made things worse

**Run**: 2026-08-20, branch `tech-debt-pr-l-printable-floor` against `230ce70`. WSL2 kernel
6.18.33.2-microsoft-standard-WSL2, Node 24.18.0, Chromium via `scripts/lib/rastercorpus.ts`.

**Reproduce**: `node_modules/.bin/vite-node scripts/bench-raster.ts despeckle`. The `despeckle`
mode is part of this change; the corpus cache is the one PR J built.

**Revises** the `MAX_COMPONENTS` section of `docs/tech-debt.md`, which stays open with a
different diagnosis: the raise works now, and still does not bound the count.

**Found while measuring something else.** The work in hand was section 25, the despeckle floor
expressed in mm rather than as a share of the image. The first measurement of a _higher_ floor
returned more components, not fewer, which is the opposite of what a floor does.

## The defect

`despeckle` absorbs every component under `minArea` into the label that surrounds it most, over two
fixed passes, relabelling every speck in a pass at once. The vote counted **all** neighbours,
including other specks being relabelled in the same pass, so two adjacent specks traded labels
instead of merging and a nest of them re-formed one layer down. The pass shuffled noise rather than
removing it.

Two consequences, both at the shipping defaults:

- The floor was violated by the pass that had just applied it. 28 of 38 corpus rows came back with
  components under their own floor: 399 of the cartoon's 414, 1227 of gravel's 1251.
- `MAX_COMPONENTS` did not cap. It raises the floor to the size that fits under 800 and re-runs, a
  move that only works if a higher floor means fewer components. On `stock-gravel` the raise
  returned **1251** components with `capped: true`.

## The wrong turn: peel in rounds

The first fix was two lines: only a component at or above the floor may absorb one, and loop until
no speck has a survivor beside it. It held the floor on all 38 corpus rows and took 2 to 6 rounds.
Review killed it on two measurements, both reproduced:

- **It does not always terminate under the floor.** A field with no component above the floor
  anywhere has no absorber, so the loop exits on round 1 with everything intact. 100x100 of
  8-label noise at `despeckleFrac` 0.02 returned **7245 components with `capped: true`**, which is
  the original defect with a different cause.
- **Each round costs a component labelling**, so cost went linear in how deeply specks nest. A
  1024px 300-ring bullseye took **10.7s**, against 0.30s for a 10-ring one. The corpus reaches 6
  rounds, so the bench could not see it.

## The fix

The merges are unions over one component labelling, not relabellings applied in rounds:

- Label once, and record the shared boundary length for every adjacent pair with a speck on one
  side (pairs of survivors are never read, and tallying them costs a million map writes on a
  1024px image for nothing).
- Take the specks smallest first. Each joins the neighbouring **label** with the longest shared
  boundary, which is the same vote as before, and unions with every neighbour carrying that label,
  since taking the label connects them anyway.
- A merged blob still under the floor goes back in the queue.

There is always a neighbour to join unless the speck is the whole image, and every join removes a
component, so this ends with nothing under the floor. The noise field above now returns **1**
component; the 300-ring bullseye takes 2.3s, and that time is now in tracing 221 rings rather than
in peeling.

## Corpus, before and after

Default Detail (50), each source at the palette size the corpus entry names. `under` counts
components below the floor the trace itself applied.

| source                | floor px | components | under     | painted | points        |
| --------------------- | -------- | ---------- | --------- | ------- | ------------- |
| pattern-cow           | 157      | 3 -> 3     | 0 -> 0    | 2 -> 2  | 44 -> 140     |
| pattern-dalmatian     | 157      | 45 -> 17   | 28 -> 0   | 4 -> 2  | 2058 -> 1454  |
| pattern-zebra         | 575      | 278 -> 107 | 203 -> 0  | 4 -> 3  | 6551 -> 7010  |
| pattern-tiger         | 157      | 28 -> 17   | 17 -> 0   | 4 -> 4  | 758 -> 1658   |
| makegood-logo         | 146      | 50 -> 50   | 0 -> 0    | 3 -> 3  | 2132 -> 2132  |
| red-sox-logo          | 88       | 56 -> 57   | 0 -> 0    | 4 -> 4  | 2714 -> 2734  |
| cartoon               | 151      | 414 -> 21  | 399 -> 0  | 6 -> 5  | 7117 -> 2000  |
| mario                 | 759      | 102 -> 30  | 73 -> 0   | 8 -> 8  | 4655 -> 3857  |
| ui-screenshot         | 299      | 27 -> 19   | 12 -> 0   | 6 -> 6  | 724 -> 534    |
| kid-drawing           | 442      | 22 -> 22   | 0 -> 0    | 6 -> 6  | 1814 -> 1802  |
| gradient-illustration | 157      | 10 -> 10   | 0 -> 0    | 6 -> 6  | 210 -> 202    |
| photo                 | 432      | 67 -> 30   | 39 -> 0   | 8 -> 8  | 4288 -> 3910  |
| stock-gravel          | 384      | 1251 -> 67 | 1227 -> 0 | 8 -> 5  | 23413 -> 4749 |
| stock-foliage         | 390      | 78 -> 22   | 56 -> 0   | 8 -> 7  | 4708 -> 4054  |
| stock-brick           | 384      | 334 -> 144 | 218 -> 0  | 8 -> 8  | 8755 -> 5191  |
| stock-crowd           | 433      | 290 -> 66  | 230 -> 0  | 8 -> 8  | 7304 -> 3953  |
| stock-night           | 369      | 45 -> 35   | 14 -> 0   | 8 -> 8  | 2860 -> 2846  |
| stock-bokeh-food      | 210      | 71 -> 62   | 10 -> 0   | 8 -> 8  | 3092 -> 2950  |
| photo-jpeg-q40        | 456      | 105 -> 41  | 66 -> 0   | 8 -> 8  | 6290 -> 5235  |

- **Clean flat art is untouched.** `makegood-logo` is identical, `red-sox-logo`, `kid-drawing` and
  `gradient-illustration` move by one component or a few points. None of them ever violated the
  floor.
- **`painted` drops on five rows** (dalmatian, zebra, cartoon, gravel, foliage). Those colours were
  only ever painted in pieces under the floor, so the narrower palette is the honest count: it is
  the same "colours that actually paint something" narrowing `parseRasterImage` already applies at
  the end.
- **Points can rise where components fall.** `pattern-cow` goes 44 to 140 on three components: a
  coalesced blob has a longer outline than the tidy shape the fringe used to be split into. It is
  small in absolute terms, and the sources that carried real speck counts drop hard (gravel 23413
  to 4749).
- No timing regression. Trace time per source moved by less than the run noise, and the sources
  with the most specks got faster.
- **At Detail 100 the pattern textures carry more, not less.** `pattern-cow` goes 3 components and
  50 points to 8 and 710, `pattern-tiger` 3223 points to 6684, `pattern-zebra` 7812 to 13846. Same
  cause as the cartoon's eyelashes: specks that used to be shuffled into nothing now coalesce into
  marks big enough to keep. The four line-art sources (`makegood-logo`, `red-sox-logo`,
  `kid-drawing`, `gradient-illustration`) stay put at both Detail settings: `makegood-logo` is
  identical, and the other three move by at most one component and twenty points.

## `MAX_COMPONENTS`, the recorded case

`tech-debt.md` recorded `red-sox-logo` at 8 colours returning 841 components with `capped: true`.
Same source, same settings, sweeping the palette:

| colors | before        | after        |
| ------ | ------------- | ------------ |
| 4      | 56, uncapped  | 57, uncapped |
| 6      | 463, uncapped | 68, uncapped |
| 8      | 841, capped   | 80, uncapped |
| 12     | 1868, capped  | 96, uncapped |
| 16     | 2348, capped  | 81, uncapped |

The raise now cuts the count instead of scattering it, and no corpus row exceeds the cap. **It
still does not bound it**, and the first draft of this report claimed otherwise. Absorbing specks
merges them into each other, so components appear above the new floor and "the floor is above all
but the largest 799" does not mean 799 come back. It reproduces on a speck field handed straight to
`traceLabelMap` with a high floor.

**It did not reproduce through the decode path, and a draft of this report said it had.** The
generated pixel art it claimed on (1024px, 16 colours, Detail 100, 1015 components, capped) was
measured at its working size instead of at MEASURE_EDGE, which is not what the app does. Drawn at
512 the same artwork reads **0.3045**, past the photographic cutoff, so the app never gives it the
1024px pass at all: it traces at 512, the cap's raise fires, and 78 components come back, well
under the cap. Working size is decided by measured density, not by a slider, so "both sliders at
their maxima" reaches nothing in particular. Whether a decodable image can still get past the cap
is open, and `tech-debt.md` carries it along with the `deChecker` split.

## What it looks like

Rendered from the traced components (`stubs/` is gitignored, so these are not committed):

- **cartoon**: 414 components to 21. The eyelashes and the beak line survive as continuous marks
  where they used to be broken dashes. The peel-in-rounds version erased them entirely at 14
  components, which is how the two approaches differ in practice: coalescing specks keeps a
  printable mark where absorbing them into the field loses the feature.
- **stock-gravel**: 1251 unprintable specks to 67 blobs that keep the texture's character.
- **pattern-dalmatian**: same spots, minus a grey anti-aliasing fringe that was two of its four
  colours.
- **photo** (a balloon): visually unchanged, slightly cleaner cloud edges.

## What this does not touch

- The floor is still a share of the image, so it still means a different printed size on every
  part. That is section 25, and it is the work this came out of.
- Nothing tells the user that a colour they asked for painted nothing. The colour list shows the
  narrowed palette, and the `capped` notice fires only on `MAX_COMPONENTS`, which now fires much
  less often.
