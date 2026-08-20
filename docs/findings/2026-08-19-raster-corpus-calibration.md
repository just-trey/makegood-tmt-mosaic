# Raster calibration against a real corpus

**Run**: 2026-08-19, commit `ffb298a`, WSL2 / Chromium 149.0.7827.55 / Playwright 1.61.1 / Node
24.18.0, GPU active (RTX 2060 via D3D12).

**Reproduce**: `node_modules/.bin/vite-node scripts/bench-raster.ts <corpus|colors|curve|scale|render|alpha>`.
Sources are decoded through Chromium and cached in `stubs/raster-corpus/`, keyed on the source
bytes plus the decode constants.

**Scope**: measurement only, no behavior change. Feeds the four open raster sections in
`docs/tech-debt.md`. Acts on none of them.

## Headline

| #   | Result                                                                                                                                                                                                             | Affects            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| 1   | Edge density does not separate photographs from flat art. The corpus photograph sits inside the flat cluster, below the zebra pattern.                                                                             | thresholds section |
| 2   | Export size moves the reading further than content does. The same two-color zebra reads photographic at 128px and flat at 384px and above.                                                                         | thresholds section |
| 3   | The knee in the region-count curve is real but weaker than it first looked: correct on 6 of the 8 sources where the right answer is clear, and both failures pick too few colors.                                  | Colors section     |
| 4   | `ALPHA_MAX_LIMIT` (4/3) is correctly documented and correctly placed. Three drafts of this report said otherwise. Its undocumented half is cost: 5.37% of a square's area, and 1.90x the vertices on a 300px logo. | curve-fit section  |
| 5   | The compensating blur quadruples region count at downscale 1.00, measured on a source the app really does ship that way.                                                                                           | downscale section  |

**The bench reproduces the app exactly.** Three files loaded into the running app at its own
defaults produce the panel readouts `6 colors · 66 regions` (mario), `6 colors · 30 regions`
(photo), `6 colors · 463 regions` (Red Sox), matching the bench on every digit. The whole chain is
covered: decode, `measureImage`, `autoParams`, `quantize`, `traceLabelMap`.

## The corpus

13 sources. `stubs/` is gitignored, so the middle column says what a clean checkout can rebuild.

| Source                | Reproducible               | Size      | edgeDensity | Reads    |
| --------------------- | -------------------------- | --------- | ----------- | -------- |
| pattern-cow           | yes, in repo               | 1024²     | 0.0034      | flat     |
| pattern-tiger         | yes, in repo               | 1024²     | 0.0176      | flat     |
| pattern-dalmatian     | yes, in repo               | 1024²     | 0.0225      | flat     |
| gradient-illustration | yes, authored by the bench | 1024²     | 0.0454      | flat     |
| makegood-logo         | yes, in repo               | 1148x1063 | 0.0723      | flat     |
| cartoon               | no                         | 500x898   | 0.1502      | flat     |
| ui-screenshot         | no                         | 1440x900  | 0.1692      | flat     |
| **photo**             | no                         | 1321x1600 | **0.1762**  | **flat** |
| photo-jpeg-q40        | recipe, needs `photo`      | 1321x1600 | 0.1807      | flat     |
| pattern-zebra         | yes, in repo               | 1024²     | 0.1841      | flat     |
| red-sox-logo          | no                         | 300²      | 0.2531      | flat     |
| mario                 | no                         | 1588x1176 | 0.2532      | flat     |
| kid-drawing           | no                         | 1200x1569 | 0.6028      | photo    |

Endpoints in `stats.ts`: `FLAT_EDGE_DENSITY` 0.12, `PHOTO_EDGE_DENSITY` 0.45, resolution cutoff
0.285.

## 1. The clusters do not separate

The tech-debt section asked to "confirm the flat and photo clusters are separated by a gap and put
the endpoints inside it", and named the overlap case: "if the clusters overlap, the statistic
itself is wrong and wants replacing rather than retuning."

They overlap. The flat cluster runs 0.0034 to 0.2532 (n=8). The photograph sits at 0.1762, inside
it, below the zebra pattern. The gap is -0.0770.

**But the sample cannot carry that conclusion.** The corpus holds exactly one photograph, and it is
a hot air balloon against a clear sky: large flat panels over a smooth gradient. Its content is
genuinely low-transition, so 0.1762 is not a misreading of that file. What the run establishes is
narrower and firmer:

- The statistic measures transition density, which is a property of content and rendered size.
- Transition density is not the same axis as photograph-versus-flat-art, and the two come apart on
  real files in both directions.
- A crayon drawing (flat intent, paper texture) reads 0.60. A photograph of a balloon reads 0.18.
  Both readings are correct about what the image needs and wrong about what the image is.

The naming, not the arithmetic, is what the measurement contradicts. Treating this as "the
statistic is wrong" is not yet supported. Treating it as "the thresholds separate detail load, and
the flat/photo names promise something they do not deliver" is.

**Still owed**: several more photographs, which the section asked for and this run could not
supply. Until then the photo endpoint stays unmeasured. See "What is still open" below.

## 2. Export size decides the regime, not content

`public/patterns/zebra.svg` is two flat colors at every size. Rasterized at each size, then decoded
the way the app decodes a dropped file:

| Render edge | Measured at | edgeDensity | Reads |
| ----------- | ----------- | ----------- | ----- |
| 128         | 128²        | 0.6324      | photo |
| 192         | 192²        | 0.4796      | photo |
| 256         | 256²        | 0.3661      | photo |
| 384         | 384²        | 0.2430      | flat  |
| 512         | 512²        | 0.1823      | flat  |
| 768         | 512²        | 0.2075      | flat  |
| 1024        | 512²        | 0.1841      | flat  |
| 1536        | 512²        | 0.2086      | flat  |
| 2048        | 512²        | 0.1845      | flat  |

A two-color pattern exported at 128px scores 3.6x the corpus photograph. The cause is documented
already, on `RasterImage.edgeDensity`: a smaller decode makes edges a larger share of the pixels,
and `MEASURE_EDGE` never upscales, so a source under 512px is measured at its own size.

The consequence is not documented anywhere: **small flat artwork is pushed toward photo treatment
by its size alone.**

The harm arrives through `autoParams`, not through the resolution cutoff. For a source already
under 512px the 0.285 cutoff is a no-op in both directions, because `workingSize` never upscales
and both branches return the source's own size. What does change is the interpolation, which is
continuous and has no cutoff to cross: `red-sox-logo` at 0.2531 already carries blur 1 and a
despeckle floor of 0.00098, 6.5x the flat-art floor, for a 300px logo of three colors. Zebra at
128px reads 0.6324, past `PHOTO_EDGE_DENSITY` entirely, so it takes the full photo parameters:
blur 2 and 0.0022, the 15x floor.

So the defect is not "a small logo trips the cutoff". It is that every parameter derived from edge
density is derived from a number that partly measures how big the file is.

Above 512 the reading is resampling noise, not signal: 0.182 to 0.209, a 14% spread with no
monotonic trend, because the downscale ratio to 512 lands differently at each size. That band is
well clear of the cutoff, so it changes nothing, but no conclusion should be drawn from a
difference that small.

This is the more useful half of result 1. It is a defect in shipping behavior, it is reproducible
from files in the repo, and it does not depend on the photograph sample at all.

## 3. The knee is real, weaker than it looked, and the cap destroys it

Region count against palette size, one color per step so every `growth` figure is a single-step
ratio. Full table via `bench-raster.ts colors`.

Judged on the 8 sources whose right answer is clear by looking at the file. The other five
(dalmatian, zebra, makegood-logo, gradient-illustration, photo-jpeg-q40) are left out because this
run has no defensible right answer for them, not because they behaved badly.

Sources where a knee exists and picks correctly:

| Source        | Knee at | Growth | Right answer                          | Agrees |
| ------------- | ------- | ------ | ------------------------------------- | ------ |
| pattern-cow   | 4 → 5   | 61x    | 2 to 4                                | yes    |
| pattern-tiger | 4 → 5   | 19.4x  | 2 to 4                                | yes    |
| red-sox-logo  | 4 → 5   | 12.2x  | 4 (tech-debt table: 4 clean, 6 halos) | yes    |
| ui-screenshot | 6 → 7   | 8.5x   | 6                                     | yes    |

Sources with no knee, where more colors are genuinely wanted:

| Source | Max growth | Right answer | Detector stays quiet |
| ------ | ---------- | ------------ | -------------------- |
| mario  | 1.83x      | 8 to 9       | correct              |
| photo  | 2.20x      | 8+           | correct              |

Two failures, both picking too few colors:

| Source      | Knee at | Growth | Right answer | Problem                                                |
| ----------- | ------- | ------ | ------------ | ------------------------------------------------------ |
| kid-drawing | 3 → 4   | 15.8x  | 5 to 6       | paper texture makes a false knee two steps early       |
| cartoon     | 5 → 6   | 12.2x  | 6            | fires one step early, on a curve that is not monotonic |

Six of eight. The section's proposal survives contact with real files, but less comfortably than a
coarser ladder suggested: on `2,3,4,5,6,8,10,12` the cartoon appeared to have no knee at all and
the count was seven of eight. That ladder was scoring two-step ratios against one-step ones. On a
uniform ladder the cartoon's knee appears and is wrong. **Any conclusion from this curve has to be
drawn on a uniform ladder**, which is not something the section says.

**The curve is not monotonic even when nothing is capped.** The cartoon runs 12, 48, 168, then
_34_ at five colors, then 414 at six. The drop to 34 is the quantizer landing on a different
clustering, not despeckling. A detector reading only the ratio to the previous step will be misled
by the recovery that follows a drop.

**The trap the section does not mention.** `MAX_COMPONENTS` (800) caps the trace by raising the
despeckle floor, and a capped step returns _fewer_ components than the one before it.
`pattern-tiger` goes 542 components at 5 colors to 18 at 6, a growth of 0.03. Read naively that is
the strongest possible knee, pointing at exactly the wrong place. Any detector must discard capped
rows rather than score them. Capping fired on dalmatian, zebra, tiger, makegood-logo, red-sox-logo,
cartoon and ui-screenshot within the sweep range.

**Second trap.** Components and points decouple. `makegood-logo` goes 50 components at 3 colors to
45 at 4, while points go 2132 to 19556, a 9x rise the component count cannot see. That is the
anti-aliased alpha fringe. A detector on components alone would call 4 colors free.

## 4. `ALPHA_MAX_LIMIT` is right, and this report said otherwise for three rounds

The comment on `ALPHA_MAX_LIMIT` says: "Past 4/3 the corner test accepts every vertex, so a higher
number doesn't mean 'smoother', it means 'no corners survive anywhere' - a square logo comes back
with rounded corners."

**That is correct.** Three drafts of this report claimed it was backwards and self-contradictory.
The claim was withdrawn only when a reviewer probed `fitChain` directly instead of reading the
sweep.

Read the code. `curve.ts` computes `alpha = (1 - 1/dd) / 0.75`, whose supremum is exactly 4/3, and
keeps a corner only when `alpha >= alphaMax`. At 4/3 that test never passes, so every vertex is
forced into a cubic. `ALPHA_CEILING` in `curve.ts` already says so in the same words.

Probed on a clean 40x40 lattice square, true area 1600 (`bench-raster.ts alpha`):

| alphaMax | points | sharp | area   | area lost |
| -------- | ------ | ----- | ------ | --------- |
| 0.8      | 4      | 4     | 1600.0 | 0.00%     |
| 1.0      | 4      | 4     | 1600.0 | 0.00%     |
| 1.2      | 4      | 4     | 1600.0 | 0.00%     |
| 1.3      | 38     | **0** | 1514.1 | **5.37%** |
| 4/3      | 38     | **0** | 1514.1 | **5.37%** |

A square comes back rounded, exactly as documented. Nothing needs correcting.

**Why the sweep read the other way.** On `red-sox-logo` at flatness 0.1, both `points` and `sharp`
explode at 4/3 (4270 to 8134, and 78 to 1382), which looks like faceting:

| alphaMax | points   | sharp    |
| -------- | -------- | -------- |
| 0.8      | 3332     | 375      |
| 1.0      | 4270     | 233      |
| 1.2      | 4910     | 78       |
| **4/3**  | **8134** | **1382** |

It is not faceting. Rounding every vertex of a jagged, anti-aliased 300px boundary produces an
oscillating curve, and flattening that curve emits many short segments meeting at sharp angles. So
`sharp` counts zigzag in the output polyline, not corners preserved from the input. On clean input
it measures corners; on noisy input at 4/3 it measures the smoothing failing. This report already
noted that `sharpTurns` is not a corner detector on lattice output, then leaned on it anyway.

**What is genuinely new, and small.** The clamp guards a fidelity failure that was documented, and
also a cost that was not. Measured against the flat-art endpoint `alphaMax` 1.0 at flatness 0.1,
both from rows printed above: a clean square loses 5.37% of its area, `red-sox-logo` goes 4270 to
8134 points (1.90x) and `ui-screenshot` 994 to 1286 (1.29x). The cost is real and
content-dependent, not a constant. That is worth one clause in the comment, not a correction to it.

Every ratio in this section names its baseline because three separate claims in earlier drafts did
not, and each was wrong in a different way: one read off a flatness that does not ship, one mixed
two baselines in a single sentence, and one quoted ratios that came from no printed row at all.

**No retune is supported either.** At the flat-art flatness that ships, 0.25, the two
corner-bearing sources disagree about moving `alphaMax` from 1.0 to 0.9:

| Source        | alphaMax | points | sharp   |
| ------------- | -------- | ------ | ------- |
| ui-screenshot | 0.9      | 684    | 219     |
| ui-screenshot | 1.0      | 738    | **231** |
| red-sox-logo  | 0.9      | 2682   | **343** |
| red-sox-logo  | 1.0      | 2932   | 267     |

On the screenshot, moving to 0.9 loses corners. On the logo it gains them. An earlier draft
recommended the move on the strength of flatness 0.1 rows, which the app never uses. The endpoints
are left where they are.

**A labelling note that matters for reading any row above.** `alphaMax` 1.0 and `flatness` 0.25 are
the flat-art _endpoints_, not what any corpus file receives. `autoParams` interpolates, so
`red-sox-logo` actually ships 1.081 / 0.310 and `ui-screenshot` 1.03 / 0.272. No corpus source runs
at exactly an endpoint, and earlier drafts of this table labelled 1.0 as "(ships)".

**Flatness above 0.4 misbehaves on small sources.** On the 300px logo, flatness 0.6 raises `sharp`
sharply relative to 0.4 at every alphaMax at or above 0.9 (304 to 718 at alphaMax 1.0). The photo
endpoint is already 0.4. Nothing to change, but the ceiling has a reason now.

## 5. The compensating blur fires where nothing was lost

`DETAIL_PASS_BLUR` is 1, added whenever the working long edge exceeds `MEASURE_EDGE`. It pays back
low-pass filtering that the downscale used to perform.

`workingSize` never upscales, so any source between 513px and 1024px is worked at its own size,
downscale 1.00, and still collects the blur. `cartoon` (500x898) is exactly that case and is in the
corpus. Ladder via `bench-raster.ts scale "stubs/raster test/cartoon cahrater.svg.webp"`:

Traced at 6 colors, which is what `cartoon`'s corpus entry records as right for it:

| Working edge | Produced | Downscale | Blur | Components | Points   | Ships   |
| ------------ | -------- | --------- | ---- | ---------- | -------- | ------- |
| 256          | 143x256  | 3.51      | 0    | 80         | 1075     |         |
| 256          | 143x256  | 3.51      | 1    | 59         | 1756     |         |
| 512          | 285x512  | 1.75      | 0    | 195        | 3060     |         |
| 512          | 285x512  | 1.75      | 1    | 219        | 3688     |         |
| 768          | 428x768  | 1.17      | 0    | 153        | 3072     |         |
| 768          | 428x768  | 1.17      | 1    | 316        | 5770     |         |
| 1024         | 500x898  | **1.00**  | 0    | **99**     | **2557** |         |
| 1024         | 500x898  | **1.00**  | 1    | **414**    | **7117** | **yes** |

**At the size the app actually ships this file, the compensation quadruples the region count (99 to 414) and multiplies point count by 2.8 (2557 to 7117).** It is paying back a low-pass filtering
that never happened, and the cost is not marginal.

The same ladder on `stubs/mario.png` (1588x1176), which _is_ downscaled:

| Working edge | Downscale | Blur | Components | Points | Ships   |
| ------------ | --------- | ---- | ---------- | ------ | ------- |
| 256          | 6.20      | 1    | 49         | 1305   |         |
| 256          | 6.20      | 2    | 32         | 1180   |         |
| 384          | 4.14      | 1    | 121        | 2876   |         |
| 384          | 4.14      | 2    | 34         | 2183   |         |
| 1024         | 1.55      | 1    | 89         | 4013   |         |
| 1024         | 1.55      | 2    | 102        | 4655   | **yes** |

At high downscale the extra blur reduces both counts, as intended. By 1.55 it has already turned
mildly harmful (89 to 102 components). At 1.00 it is clearly harmful. The section called for
deriving blur from the realised downscale ratio; this run says the ratio the decoder already knows
would flip the decision across a real and common size band, and that the flip is worth roughly 4x
in region count at the extreme.

## Null results and wrong turns

Ten of these were found by four `/code-review` passes after the first draft of this report was
written. Seven changed a number, a recommendation or a conclusion the report had already stated.
One of them inverted a headline result.

- **A bug in the bench itself, caught before it reached this report.** The first pass tested
  working _width_ against `MEASURE_EDGE`, where `parse.ts` tests the long edge. That silently
  removed the compensating blur from every portrait source. `cartoon` (500x898) reported blur 0
  where the app applies 1. The live cross-check exists partly because of it.
- **The first curve sweep was worthless and looked fine.** Run at a blanket 8 colors, it reported
  86% of `pattern-cow`'s vertices as sharp corners on a pattern made entirely of curves. 8 colors
  puts cow into 394 fringe specks, and a speck's outline is nearly all corners. The sweep was
  measuring quantization noise. Re-run at per-source palette sizes it is clean, and cow drops to 3
  components and 44 points. A sweep needs its palette size chosen per source, which the tech-debt
  section does not say.
- **`render` mode measured nothing at all above 512px.** Handing an `<img>` holding an SVG to
  `drawImage` makes Chromium rasterize the vector at the _destination_ size, so every request at or
  above the draw size returned identical crisp pixels and the table showed 0.1823 five times over.
  It is now baked to a bitmap at the export size first, then resampled, which is what a user's
  exported PNG does. This is the only place the corrected numbers reach the corpus table: the five
  vector entries moved, `gradient-illustration` most (0.0734 to 0.0454).
- **The knee count was 7 of 8 on an uneven ladder.** `2,3,4,5,6,8,10,12` scores the last three
  steps as two-step ratios against one-step ones, which flattered the late steps and hid the
  cartoon's knee entirely. On a uniform ladder it is 6 of 8. The `ui-screenshot` knee also moved,
  from "6 → 8, 10.3x" to "6 → 7, 8.5x"; same answer, different evidence.
- **The downscale-1.00 claim was an extrapolation.** The first draft asserted the blur is harmful
  at downscale 1.00 while measuring only the 1.55 rung of the mario ladder, which cannot produce a
  1.00 rung below its own source size. Measured properly on `cartoon` the effect is far larger than
  the extrapolation implied, but it was not measured when it was written down.
- **The alphaMax retune was recommended off a flatness that does not ship.** The first draft called
  0.9 "strictly better" on the evidence of flatness 0.1 rows. At the shipping 0.25 the two
  corner-bearing sources disagree and the screenshot reverses. Retracted above. A sweep table
  invites reading whichever row makes the cleanest story, and this is what that looks like.
- **The `scale` ladder ran at a blanket 8 colors.** Headline 5 was first measured on `cartoon` at
  8, where its corpus entry says 6. Same direction, larger effect at 6 (99 to 414 rather than 133
  to 484), but it was the exact trap this report documents two bullets up, repeated in a different
  mode. `scale` now takes the palette size from the corpus entry.
- **The cache key was incomplete twice.** First it omitted the decode constants, then it omitted
  the flat/photo thresholds that decide which draw is kept. Both are things this bench exists to
  argue for retuning, so both would have served pre-retune pixels under a post-retune label.
- **Result 4 was inverted for three drafts, and was the most confidently written thing here.** The
  report claimed `ALPHA_MAX_LIMIT`'s comment was backwards and promoted "correct the comment" to
  `tech-debt.md` as ready to act, which would have made a correct comment false. What went wrong is
  worth more than the finding: the conclusion was read off a sweep table over noisy real artwork,
  where the instrument (`sharp`) does not measure what its name says. Probing `fitChain` on a clean
  square settles it in one run and was never done until a reviewer did it. **A sweep tells you what
  changed. It does not tell you why, and a metric that is valid on one input is not valid on
  another.**
- **`sharpTurns` is not a corner detector on lattice output.** It works only once the fit is
  actually running. It is a valid instrument in the tables above and would be a bad one anywhere
  the trace is degenerate.
- **`scripts/gen-raster-fixtures.mjs` does not exist.** The `FLAT_EDGE_DENSITY` docstring cites it
  as the source of the seed values ("flat art lands near 0.05, photographs near 0.6"). It is
  referenced nowhere else in the repo and is not in the tree. Those two seed numbers cannot be
  re-derived from anything on `main`. Left unfixed here to keep this run additive; the docstring is
  rewritten by the section that retunes the constants.
- **No knee detector was built.** Only the curve it would read was measured.
- **The gradient illustration is authored, not sourced.** It is the one corpus entry that is not a
  real file, because the corpus had no gradient artwork. It landed at 0.0454, well onto the flat
  side, which is the answer a gradient under hard-edged shapes should give and so tells us little.
  A real gradient illustration would be a better probe.

## What is still open

| Section in `docs/tech-debt.md` | What this run changes                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| photo-vs-flat thresholds       | Cannot close. The overlap is measured but the photograph sample is n=1. Result 2 is actionable on its own and needs no more photographs.                   |
| Colors is fixed                | Ready to act, with three named traps: the cap, the component/point decoupling, and a curve that is not monotonic. Expect it to be wrong on textured scans. |
| trace parameters vs downscale  | Ready to act. The 513 to 1024px band is the case, it is worth 4.2x in region count, and the decoder already knows the ratio.                               |
| curve-fit constants            | **Nothing to act on.** The comment is right, the clamp is right, and the endpoints are left alone. The sweep is done and it defends what ships.            |

**The one thing this run needs and could not get: more photographs.** The section asked for
"several phone photos". One was available. Everything said about the photo end of the range rests
on that single unusually flat file, and no amount of re-running changes it.
