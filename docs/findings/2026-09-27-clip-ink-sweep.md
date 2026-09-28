# Clipped design ink runs right up against `CLIP_REMNANT_FLOOR_MM2`

**Commit** `bc9ab32`. **Machine** WSL2. Every figure below reproduces from:

```
RUN_CLIP_INK_SWEEP=1 npx vitest run scripts/measure-clip-ink.test.ts
```

**Result: the floor is not comfortably clear of real, shipped Fill content.**
9.4% of the foreground-ink pieces this sweep recorded (760 of 8,056) sit below
`CLIP_REMNANT_FLOOR_MM2` (0.16mm²), and the narrowest piece that survives sits
at 0.160048mm² — 1.00003x the floor, indistinguishable from it. This doesn't
retire `docs/tech-debt.md`'s open question, it sharpens it: whether that
near-floor ink is dust (a clip-boundary numerical artifact, the same species
`CLIP_REMNANT_FLOOR_MM2`'s own docstring names) or genuine drawn content isn't
answered by an area sweep alone, and the answer differs sharply by pattern.

## What was measured

The four shipped patterns (`public/patterns/{cow,dalmatian,zebra,tiger}.svg`)
as real Fill designs at 100% scale, through the real `buildAssemblyGeometry`
pipeline, on real parts:

- `wheel-half`, `wheel-hub-cap`, `footrest` — real STL/3MF meshes, the
  largest flat patch (or the `preferFaceNormal`-selected one for footrest).
- A generated hubcap disc at `HUBCAP_DEFAULT_DIAMETER_MM` (220mm), built the
  same way `measure-wall.ts` does.
- Four `chair-body` zones, not all 8: `wing-left` (1 printed part),
  `seat-left` (2), `left` (4) and `front` (6) — chosen to span the sidecar's
  actual part-count range. A full 8-zone run exceeded 10 minutes once the
  parse-fresh-per-call fix below made every build do real per-color CSG; see
  "wrong turns".

`dropUnprintableRemnants` (`src/geometry/regions.ts`) was intercepted with
`vi.mock`'s partial-passthrough form: every export except
`dropUnprintableRemnants` is the real one, and the wrapped function records
each piece's area exactly as the function's own decomposition produces it,
then calls straight through to the real implementation. This taps the two
live call sites in `assembly.ts` (`placedInkFeatures`, `dropSpecks`) rather
than re-deriving their clip logic.

## Separating ink from the shared tile background

Every pattern SVG's first path is a full 60x60mm background rect. A clip
artifact born from that SAME square meeting the SAME real zone edge at the
SAME tile position is identical geometry regardless of which pattern painted
it — the only way two different-colored artworks land the exact same area at
the exact same part/zone slot. Grouping recorded pieces by (part/zone, area)
and keeping only the ones that do NOT recur across all 4 patterns separates
that shared-background population (the bake's own cut-region-width question,
already answered in `docs/findings/2026-09-08-cut-region-width.md`) from
pieces that depend on what was actually drawn:

| population                                          | count |
| --------------------------------------------------- | ----- |
| total pieces `dropUnprintableRemnants` saw          | 8,072 |
| background-square (identical across all 4 patterns) | 16    |
| foreground ink (pattern-specific)                   | 8,056 |

## The area histogram

| range (mm²)   | pieces |
| ------------- | ------ |
| [0, 0.001)    | 61     |
| [0.001, 0.01) | 113    |
| [0.01, 0.1)   | 467    |
| [0.1, 0.16)   | 119    |
| **[0.16, 1)** | 749    |
| [1, 10)       | 1,636  |
| [10, 100)     | 4,160  |
| [100, 1000)   | 630    |
| [1000, 10000) | 107    |
| [10000, ∞)    | 14     |

760 pieces (61+113+467+119) sit below the floor. The narrowest piece AT or
ABOVE it is 0.1600477645480396mm² on `chair-body/seat-left`, painted by
tiger.

## Which pattern is responsible

| pattern   | sub-floor pieces |
| --------- | ---------------- |
| zebra     | 652              |
| dalmatian | 70               |
| tiger     | 33               |
| cow       | 5                |

86% of the sub-floor population is zebra alone. `tests/patterns-assets.test.ts`
already documents zebra as the one pattern whose marching-squares tracing
needed contour thinning to fit the vertex budget — the same fine-detail
tracing plausibly explains why it also produces far more sub-floor pieces
than the other three, which are blockier, hand-simpler shapes.

Many of the smallest recorded pieces are extreme slivers (aspect ratios into
the hundreds — e.g. 0.108403mm² at 0.0214 x 18.276mm), consistent with a
clip boundary running near-parallel to a stripe edge, the same failure mode
`CLIP_REMNANT_FLOOR_MM2`'s docstring already names. But not all of them are:
several near-floor pieces have aspect ratios close to 1 (e.g. 0.102094mm² at
0.5482 x 0.7091mm), and this sweep has no way to tell a compact clip artifact
from a compact piece of a genuinely small zebra marking without tracing each
piece back to its source loop — not attempted here.

## What this means for the tech-debt section

The section's closing test — "if the narrowest deliberate stroke turns out to
be far above the floor, the argument gains a number" — fails. The narrowest
surviving piece is AT the floor, not far above it, and a real 9.4% of
recorded ink falls under it. Per the section's own other branch ("if artwork
routinely runs at 0.2mm[-equivalent area], the speck notice is firing on
content people meant, which is a different bug"), this narrows the section
rather than closing it. It does not resolve whether the speck notice is
firing on content people meant, because that needs per-piece provenance this
sweep doesn't have.

## Null results and wrong turns

- **A shared parsed artwork object, reused across builds against different
  parts, silently corrupted the palette.** The very first version of this
  sweep parsed each pattern once and reused the `ParsedSVG` across all 12
  builds per pattern (4 flat kinds + 8 zones). Every build after the first
  showed only ONE merged `#000000` palette color instead of the artwork's
  real two (`#0a0a0a` foreground, background). A minimal two-call repro
  (parse once, build against `wheel-half` then `wheel-hub-cap`) did NOT
  reproduce it, so the exact trigger (something specific to the chair-zone
  path, or to running under vitest's real jsdom rather than a hand-built
  stub — both differed between the failing run and the repro) is not
  root-caused. Parsing fresh before every `buildAssemblyGeometry` call
  sidesteps it and was verified correct: the same command against
  `wheel-half`/cow alone, unmocked, via plain `vite-node`, produces the same
  two-color palette either way. **Not filed as a confirmed second defect**:
  it never reproduced outside this sweep's specific harness, and confirming
  it as a real app-runtime bug (the app does reuse a loaded design's parsed
  SVG across every rebuild) would need a driven run against the actual app,
  not this script. Worth a look if anyone sees a design's colors change
  count across unrelated rebuilds.
- **The first attempt didn't separate ink from the shared tile background**,
  and every recorded "small piece" turned out to be the SAME background
  square's clip artifact repeating identically across all 4 patterns — not a
  pattern-dependent measurement at all. Caught by noticing every value in the
  smallest-N printout was identical across cow/dalmatian/zebra/tiger, which a
  real content-dependent measurement should never be.
- **Excluding the background via `baseColorKey`** (marking it as the base
  color the way a real Fill pick normally would) produced an empty build
  (zero pieces, though `buildAssemblyGeometry` still returned non-null) under
  the vitest+jsdom harness specifically — not reproduced standalone via
  `vite-node`. Abandoned in favor of the pattern-invariance grouping above,
  which needed no pipeline input change.
- **All 8 chair-body zones, swept once real per-color CSG was restored**,
  did not finish in 10 minutes. Narrowed to the four zones above by
  part-count (1, 2, 4, 6), which is the sidecar's full range. `right` and
  `seat-right` are left-right mirrors of `left` and `seat-left` (same part
  count, reflected shape), so their own boundary complexity is the same
  species; `back` shares `front`'s 6 parts but is its own chart with its own
  boundary, not measured here.
