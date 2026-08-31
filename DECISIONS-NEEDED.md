# Decisions needed

## The covers file's paired casters are 180-degree rotations of each other, not mirrors

**Question**: is `stubs/dead-zones.3mf` right about the casters, or is the CAD assembly wrong? The
answer decides whether `covers.mirrorAxis` should snap them at all.

**Measured 2026-08-30** (`npx vite-node scripts/bake-zones.mjs scripts/zone-configs/chair-body.json`
prints the residual; the axis-map search behind the rest is in the run notes):

| Question                                                     | Answer                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| Are the two paired caster bodies the same body?              | Yes: 8,953 vertices and 48.500 x 154.059 x 279.997mm, both |
| Are they related by the x mirror `symmetrizeCovers` assumes? | No: 21.976mm apart, 3,958 of 8,953 vertices over 1mm       |
| What relates them exactly?                                   | `(x, y, z) -> (-x, y, -z)`, residual 0.000mm               |

`(-x, y, -z)` has determinant +1. It is a 180-degree rotation about the vertical axis, not a
mirror. So `symmetrizeCovers` replacing one body with `mirror_x` of the other moves real geometry
by up to 21.976mm — it is off by a further `mirror_z`.

**What I could not decide**: whether the assembly is meant to be mirror-symmetric there.

- If it is, the covers file is wrong (a caster placed by rotation where it should be mirrored) and
  the fix is a re-export, after which the snap is correct and a vertex-level shape check can be
  enforced instead of only reported.
- If it is not — the caster really is fitted rotated, so the left and right wheels present
  different faces outward — then the snap is wrong for this file and `mirrorAxis` should come off,
  which changes the baked dead regions and re-opens the knife-edge asymmetry the snap was added to
  settle (see `symmetrizeCovers`' own note).

Nothing here is guessable from the mesh: both stories produce exactly this file.

**Not blocking the current bake.** The check that shipped refuses a pair that is not the same body
at all (vertex count, bbox extent) and only _reports_ the mirror residual, so
`public/stl/chair-body-zones.json` is byte-identical to what was already on the branch. Open thread
recorded in `docs/tech-debt.md`.
