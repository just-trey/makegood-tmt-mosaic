# Cut-region width: no width separates dust from surface

**Commit** `fdada8b` (after #297). **Machine** WSL2, RTX 2060. Every figure and
every table below prints from one command against the shipped
`public/stl/chair-body-zones.json`:

```
npx vite-node scripts/measure-cut-width.mjs
```

committed with this report. Nothing was re-baked.

**Result: no width separates, so no guard should ship on this measurement.**
The 87 `cutRegions` pieces run from 0.0354mm wide to 144.9mm with no daylight
anywhere a guard could sit. The run does print one real gap — 9.3963mm to
30.7459mm, a factor of 3.27, 61 pieces below it and 26 above — and it is not a
candidate: it is 11.7x the widest width swept (0.80mm), and a threshold there
would drop 61 of the 87 pieces. Thin strips are not a narrow band of
dust below some threshold: they are what subtracting two loops traced from the
same triangles produces, and they run from 0.035mm to at least 1.59mm at the
same shape. Outcome (b) of the three the plan allowed.

**Scope**: the 87 are what the shipped sidecar holds, which is the survivors of
142 — `subtractRegions` already drops the rest at `MIN_CUT_PIECE_MM2`, 55 of
them, per that constant's docstring. So what is ruled out is a width guard
_added to_ the area floor, which is the only guard anyone would build. The
missing 55 are all below the floor and would only densify the low tail, so
nothing here turns on them.

## What was measured

Per PIECE — one element of one chart's `cutRegions` — never per chart or zone:

- Net area from `regionNetArea` in `scripts/lib/zonebake.mjs`, reused not
  re-derived.
- **The real morphological opening**: `offset(-w/2, 'Miter', 2, 16)` then
  `offset(+w/2, …)` on a `CrossSection` of the piece's own rings under
  `'EvenOdd'`, the exact calls `narrowFeatureArea` makes.
- **Each piece's own width**, bisected to 1e-4mm on erosion emptiness. That
  threshold is twice the largest circle that fits anywhere in the piece.
- Area lost to the opening as a fraction of the piece, so a big region with one
  thin limb is distinguishable from a piece that is entirely a hairline.

One check that the rings and fill rule are right, and one that the two
derivations agree:

| check                                            | catches                    | result                              |
| ------------------------------------------------ | -------------------------- | ----------------------------------- |
| `CrossSection.area()` against `regionNetArea`    | wrong rings or fill rule   | worst disagreement 0.0273%          |
| sweep empty/not-empty against the bisected width | sweep/bisection divergence | agree on every piece at every width |

The second is **not** independent of the fill rule, and calling it that would
be the stronger claim it cannot support: both sides ask the same
`offset(-w/2).isEmpty()`, so a wrong rule satisfies both. Only the first checks
the rule.

## The sweep

348,643.0mm² of cut region in all. "empty" is the whole piece opening to
nothing, which is what a guard would drop.

| width | empty | their mm² | empty % of all | widest dropped | narrowest kept | gap  | part-eaten >50% |
| ----- | ----- | --------- | -------------- | -------------- | -------------- | ---- | --------------- |
| 0.05  | 3     | 2.080     | 0.0006         | 0.0433         | 0.0601         | 1.39 | 3               |
| 0.10  | 9     | 6.827     | 0.0020         | 0.0922         | 0.1012         | 1.10 | 9               |
| 0.15  | 22    | 11.479    | 0.0033         | 0.1458         | 0.1881         | 1.29 | 4               |
| 0.20  | 25    | 20.670    | 0.0059         | 0.1950         | 0.2609         | 1.34 | 1               |
| 0.30  | 27    | 21.261    | 0.0061         | 0.2672         | 0.3632         | 1.36 | 2               |
| 0.40  | 34    | 25.083    | 0.0072         | 0.3980         | 0.4129         | 1.04 | 2               |
| 0.50  | 35    | 28.704    | 0.0082         | 0.4129         | 0.5156         | 1.25 | 2               |
| 0.60  | 39    | 30.932    | 0.0089         | 0.5307         | 0.7671         | 1.45 | 1               |
| 0.80  | 40    | 32.108    | 0.0092         | 0.7671         | 0.8324         | 1.09 | 3               |

"gap" is narrowest-kept over widest-dropped, both printed beside it. "empty %
of all" is the empty pieces' own share, and sits beside their area for that
reason.

Dropping is nearly free by area, which is the argument that misleads. The
worst-hit chart at every width from 0.15 up is `seat-right/chair-storage-right`,
losing 0.511 of its 6.4mm² — 7.986%, one piece of two. No chart loses more,
at any swept width.

## There is no gap

46 of the 87 pieces are under 1mm. The script prints every step between
consecutive widths in that tail. The largest is **1.445x**, from 0.5307mm to
0.7671mm. Every other step is 1.000x to 1.39x.

For scale, in this repo:

| separation                                       | factor          | verdict it carries                                   |
| ------------------------------------------------ | --------------- | ---------------------------------------------------- |
| `CLIP_REMNANT_FLOOR_MM2`, hairline vs real chart | ~10⁵ **area**   | shipped                                              |
| `MIN_HOLE_WIDTH_MM`, fold vs real hole           | 1.79 width      | shipped, and its own docstring calls the margin thin |
| widest step in this tail                         | 1.445 width     | between two pieces of the same shape                 |
| step at each candidate width                     | 1.04–1.45 width | —                                                    |

The first row is an **area** ratio and does not compare with the width ratios
below it — 0.025mm² against 1,258–3,029mm², from `CLIP_REMNANT_FLOOR_MM2`'s
docstring. It is here because it is the separation this repo has shipped a
floor on, not because 10⁵ and 1.445 are the same kind of number.

The 1.445x step is not a boundary between two populations. Either side of it:

| piece                           | width  | net mm² | bbox         | fill  |
| ------------------------------- | ------ | ------- | ------------ | ----- |
| `left/chair-wheel-mount-left#1` | 0.5307 | 0.679   | 3.148 x 4.34 | 0.050 |
| `front/chair-handle-right#5`    | 0.7671 | 1.176   | 3.236 x 4.37 | 0.083 |

Both are curved ribbons in a box they barely fill. Choosing 0.6mm would split
one population, not two.

**The shape does not change at any width.** `seat-right/chair-wheel-mount-right#0`
is 3.582 x 84.94mm, 5.975mm², fill 0.020 — a strip 85mm long — and its opening
width is **1.5895mm**, four times any candidate. Ribbons of that character run
the whole range. There is no width above which they stop.

Where the character does change is between 0.8331mm (fill 0.103) and 0.9057mm
(fill 0.414), a step of **1.087x**. Fill is not monotonic in width either: it
drops back to 0.083, 0.098 and 0.020 at 1.13, 1.24 and 1.59mm. Slenderness
does no better — the largest step anywhere in its ordering is 1.614x, and it
sits at 84 to 136, deep inside the ribbons.

## The area floor really is missing this class

Confirmed, and worse than the tech-debt section says. Three pieces:

| piece                                | width  | net mm² | bbox          |
| ------------------------------------ | ------ | ------- | ------------- |
| `seat-left/chair-wheel-mount-left#2` | 0.1881 | 2.860   | 0.217 x 30.39 |
| `right/chair-wheel-mount-right#5`    | 0.1943 | 3.159   | 0.207 x 32.53 |
| `left/chair-wheel-mount-left#4`      | 0.1950 | 3.172   | 0.256 x 32.53 |

`MIN_CUT_PIECE_MM2` is 0.16mm² and is printed by the script beside these. The
#296 hairline was 0.020 x 8.08mm and 0.025mm². These are the same shape, ten
times wider and four times longer, and clear the floor by a factor derived from
the two printed numbers: 17.9x, 19.7x, 19.8x.

So the class is shipping and the area floor does not touch it. That is a real
confirmation. It is not an argument for a width, because no width picks it out.

## Holes are not narrow features — checked, with three exceptions

The named slot resolves to `back/chair-storage-right#0 hole3`, **1.434 x
16.56mm, 23.21mm²**. It survives every swept width untouched:

| width       | still a hole      | its mm² | bbox          |
| ----------- | ----------------- | ------- | ------------- |
| 0.05 – 0.80 | yes, at every one | 23.21   | 1.434 x 16.56 |

Across all 13 hole-bearing pieces (33 holes, 50,994.6mm²), total hole area only
grows as the width rises, to 51,070.8mm² at 0.80mm. An opening erodes solid, so
it cannot close a hole.

**Three holes stop being holes, at every width including 0.05mm**:
`front/chair-handle-right#4` hole0 and hole1, `front/chair-handle-left#3`
hole0. They are 0.903 x 4.74mm (0.45mm²), 0.455 x 5.44mm and 0.466 x 5.44mm
(0.53mm² each). What fails is not the hole. The solid between each and the
piece boundary is under 0.05mm, so the erosion opens it to the edge and the
hole becomes a bay. They are edge nicks from the cover subtraction, not
features. Every hole from 1.434mm up survives to 0.80mm.

No hole perimeter enters any width figure in this report. The proxy uses the
outer ring alone, and the opening reads the solid.

## The seam overlaps are a different population

Confirmed separately, in the same command:

- 41 overlap pieces, 25 over the area floor.
- Thinnest over the floor: **0.1537mm by bbox, 0.0996mm by opening.**
- **0 of 41 is itself a `cutRegions` piece.**

Each is the intersection of two charts' claims. The 0.15mm figure is therefore
not a constraint on a guard over `cutRegions`, and was not treated as one. It
reproduces `docs/findings/2026-09-07-seam-ribbon-closed.md` exactly.

## Only one kind has cut regions at all

`ASSEMBLY_KINDS` is read directly: **1 of 4 kinds has a `zonesFile`**
(`chair-body`). The others are `wheel`, `hubcap`, `footrest`. The tech-debt
section's "across every kind" resolves to this line.

## What the proxy got wrong

The 4·area/perimeter figures that motivated the investigation are a sort key at
best. Against the opening, over the same 87 pieces:

|                      |                                                                         |
| -------------------- | ----------------------------------------------------------------------- |
| understates by up to | **11.65x** (`seat-right/chair-wheel-mount-right#0`, 0.1365 vs 1.5895mm) |
| overstates by up to  | 1.80x (`left/chair-handle-left#0`, 116.96 vs 64.99mm)                   |
| under 0.4mm          | 42 pieces by proxy, 34 by opening, 33 in both                           |
| median piece         | 0.5064mm by proxy, **0.9209mm** by opening                              |

Specifics from the hypothesis:

- **The narrowest piece is not the one named.** `right/chair-wing-right#3` is
  the proxy's narrowest at 0.0297mm; its real width is 0.0601mm and it ranks
  4th. The real narrowest is `left/chair-wheel-mount-left#5` at **0.0354mm**,
  which the proxy ranks 2nd.
- **Its length was understated 2x.** "~14mm long" is area over proxy width
  (0.423 / 0.0297 = 14.2). Its bounding box is **28.18mm**.
- **The count does not reproduce.** The hypothesis says 12 pieces under 0.15mm
  by proxy. The same formula over the same file gives **23** here, and the
  opening gives **22**. The narrowest (0.030mm) and the median (0.506mm)
  reproduce exactly, so the formula matches and the count does not. The
  throwaway script is gone, so the difference cannot be traced.

Only the direction survived: there is a narrow population, and it clears the
area floor.

## Null results and wrong turns

- **The width sweep alone would have looked decisive.** 25 pieces and 20.67mm²
  drop at 0.2mm, 0.0059% of the chair's cut region, and no chart loses more
  than 7.99% of itself at any width. Every one of those numbers says "safe",
  and none of them says the threshold is a measurement. The gap column is what
  refuses it, and it had to be printed to be seen.
- **A "total mm² lost" column was printed, then cut.** It summed what the
  opening eats off all 87 pieces, including the wide ones it barely touches, so
  most of it was 16-segment arc discretisation on long boundaries plus the fixed
  `CrossSection.area()` against `regionNetArea` basis offset — not erosion. It
  is gone rather than relabelled, because a column whose honest caption is
  "mostly noise" is a column the next reader will quote anyway. The per-piece
  `lost@` fractions stay: on one piece the noise floor is visible (0.002 on a
  9.4mm-wide piece) instead of summed into a headline.
- **Slenderness and fill were tried as the discriminant instead.** Both are
  printed per piece. Neither separates: fill is not monotonic in width, and
  slenderness's biggest step is 1.614x at 84-to-136. Recorded so the next
  attempt does not spend the same afternoon.
- **A boundary sample flickered.** Asking "is this spot still a hole" with
  `turf.pointOnFeature` put the sample on the hole's own boundary, and an
  opening restores a boundary only to its 16-segment arc discretisation. One
  55.58mm² hole read as lost at 0.10 and 0.30mm and present at 0.15, 0.20 and
  0.40mm. Sampling a 0.05mm inset copy, checked back against the original ring,
  is stable. `turf.centroid` was never used; the seam report's third wrong turn
  was the reason.
- **Ring count is not hole count.** The opening splits one hole into two rings
  at 0.05mm and merges rings at 0.80mm, so 33 holes read as 31 and 27 rings.
  Both are printed; only the per-original survival test answers the question.
- **Not measured: whether any dropped piece is visible.** The #296 hairline cut
  a 0.4mm mark into surface the cushion covers. Nothing in the sidecar says
  which of these 87 pieces sit under a cushion. That would need a driven run,
  and no figure here depends on it.

## What this means for the tech-debt section

The section, "Nothing measures whether a cut region is too NARROW to print,
only how small", should be **rewritten against these numbers and kept open**,
retitled around the question this measurement leaves answerable: "Nothing says
whether a thin cut-region strip is surface a cover hides". No guard.

- Its premise holds: the area floor is an area, and pieces 19.8x over it are
  0.20 x 32.5mm.
- Its remedy does not: it asks for "a width chosen against real features", and
  the measurement says the features have no width to choose between.
- Its two named worries are both retired. The 1.43mm slot is a hole and
  survives every width. The 0.15mm seam overlaps are a different population,
  0 of 41 of them a `cutRegions` piece.
- What is left open is a different question — whether a _shape_ test, or fixing
  the subtraction so it stops emitting ribbons along a shared boundary, is
  worth having. The rewritten section carries it, unmeasured.
- **The population this sweep did NOT cover** gets its own section, "Nobody has
  swept the design ink `CLIP_REMNANT_FLOOR_MM2` actually guards". The runtime
  floor sees a placed design's ink clipped to a part, not baked part geometry,
  and nothing here measures it.

A constant picked off this sweep would be a number with a printed table behind
it and no measurement in it. That is the failure CLAUDE.md rule 4 names.
