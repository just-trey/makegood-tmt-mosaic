# An invalid test of the compensating blur, kept so it is not repeated

**Run**: 2026-08-20, on the working tree of `docs/blur-downscale-null-result`, parent `ebc4311`. The
`blur` mode is part of this change, so the parent alone cannot run the command below. WSL2 /
Chromium 149.0.7827.55 / Node 24.18.0.

**Reproduce**: `node_modules/.bin/vite-node scripts/bench-raster.ts blur` (all five vector corpus
sources, 25 rows).

**Answers**: nothing about the downscale ratio. This records an experiment that cannot test what it
was built to test.

## What it was for

The "trace parameters are calibrated against a downscale that is no longer constant" section of
[tech-debt.md](../tech-debt.md) proposes deriving `DETAIL_PASS_BLUR` from the realised downscale
ratio. Checking that needs the ratio varied with the artwork held fixed, so five vector sources were
rendered at 1024 through 4096, each traced with the compensation on and off.

## Why it does not count

**The control arm barely moves.** `componentsOff`, the trace with no compensation, across the five
rungs:

| Source                | componentsOff at ratio 1 / 1.5 / 2 / 3 / 4 |
| --------------------- | ------------------------------------------ |
| gradient-illustration | 10 / 10 / 10 / 10 / 10                     |
| pattern-cow           | 3 / 3 / 3 / 3 / 3                          |
| pattern-dalmatian     | 17 / 17 / 17 / 17 / 17                     |
| pattern-tiger         | 11 / 11 / 11 / 11 / 11                     |
| pattern-zebra         | 479 / 273 / 488 / 285 / 485                |

Four of five never change at all. Zebra's does swing, but not with the ratio: its edge density
alternates 0.1841 / 0.2086 / 0.1845 / 0.2088 / 0.1847 across the odd and even rungs, crossing 0.2025
where the interpolated base blur rounds from 0 to 1. Its arm tracks that flip, not the downscale.

The reason is the design. The working image is always 1024, and a vector baked at 4096 then filtered
down to 1024 is essentially the same raster as one baked at 1024 directly. The anti-aliased fringe a
real downscale destroys, which is the loss `DETAIL_PASS_BLUR` exists to replace, is never created at
any rung. The ratio in that table is nominal.

**The vector-only guard caused it.** It was added so content could be held fixed while the ratio
varied, which is the right instinct. But re-rendering a vector holds the fringe fixed too, and the
fringe is the mechanism under test.

So this run cannot distinguish "the ratio does not predict the benefit" from "this bench never
realised a downscale". It says nothing either way, and the tech-debt proposal is **untested rather
than refuted.**

## What a valid version needs

Genuinely different raster pixels per rung: one large flat-art raster resampled to several sizes the
way a user's exports would be, so each rung carries the fringe its own resampling produced.

**No harness in this repo can do that today, `blur` mode included.** It rejects raster sources, and
lifting that guard would not be enough: `decodeAtEdges` ignores `renderEdge` for a raster mime, so
every rung would decode byte-identical pixels and the ladder would be degenerate in a second way.
Building it means producing the resampled files first, as real inputs, rather than asking the
decoder to vary a source it treats as fixed.

What `blur` mode does carry forward is the check that caught this: its footer derives the flat-arm
test from the run, so a degenerate ladder announces itself instead of reading as a result.

## What the table does show, at a fixed working size

Not about the ratio, and worth recording because it is consistent across all 25 rows: the
compensation's effect depends entirely on the artwork.

| Source                | edge density    | With compensation                   |
| --------------------- | --------------- | ----------------------------------- |
| pattern-cow           | 0.0034 – 0.0037 | no change at every rung             |
| gradient-illustration | 0.0387 – 0.0493 | no change at every rung             |
| pattern-tiger         | 0.0176 – 0.0202 | hurts at 3 rungs, no change at 2    |
| pattern-dalmatian     | 0.0225 – 0.0251 | hurts at every rung, +147% to +200% |
| pattern-zebra         | 0.1841 – 0.2088 | helps at every rung, −42% to −46%   |

**It never helps any source but zebra, and never hurts zebra.** That the constant is wrong for some
artwork is not in doubt, and it matches the earlier corpus finding that it quadrupled region count on
`cartoon`. What to replace it with is open.

An earlier draft proposed a mechanism: that `DETAIL_PASS_BLUR` duplicates the base blur `autoParams`
derives from edge density. That does not hold. Every source it hurts sits far below
`FLAT_EDGE_DENSITY` (0.12), so the interpolation clamps to zero and returns the identical flat
endpoint for each, carrying no signal that distinguishes them. Note also that the base blur rounds
from 0 to 1 at 0.2025, not at 0.12.

## Caveats on even that

- Five sources, four of them two-colour vector patterns. No photograph, no cartoon, no scan.
- Region count is the measure and it is a proxy. A lower count is not automatically a better trace,
  and **nothing here was looked at**.

## Wrong turns

Three, and they are the reason this file exists.

- **The first version compared arrays instead of counts** and drew both images at 512 when one was
  meant to be the working size. It produced a table where zebra alternated between helping and
  hurting down the ratio column, which reads as exactly the correlation this report cannot rule on.
  It was caught only because the alternation looked implausible.
- **The second version was reported as a clean null result.** Three sources, verdict constant per
  source, ratio does not predict. A review round found the control arm was flat and the conclusion
  unsupportable, and that `tech-debt.md` had already been edited to block the direction on it.
- **The default source list was widened from three to five** to answer a sample-size finding, and
  the report's tables were not re-run against it. Every table above is from the five-source run.
