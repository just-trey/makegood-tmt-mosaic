# Working in this repo

## Skills

Three project skills in `.claude/skills/` carry the recurring workflows in
full — read the skill rather than reconstructing the steps:

- `ship-it` — the pre-PR gate (the five checks + the four docs that drift)
- `add-part` — adding a MakeGood TMT part as an assembly kind
- `release` — cutting and tagging a release

## Before opening a PR

Run the `ship-it` skill — it has the five CI gates (which also block merge
into `main`) and the four docs that drift silently. `/code-review` is
required, not optional, when the diff touches `src/geometry/` or
`src/export/`.

## Git workflow

- `main` is protected: PRs required, the CI check must pass, no direct
  pushes, no force-push or branch deletion.
- Branch off `main`, keep one focused change per branch/PR.
- Versioning is semver, currently pre-1.0 (`0.x.y`) — see
  [CONTRIBUTING.md](CONTRIBUTING.md#versioning) before deciding whether a
  change is PATCH/MINOR/MAJOR-equivalent.

## Code conventions

- TypeScript `strict` is on (see [tsconfig.json](tsconfig.json)); don't
  weaken it to make something compile.
- Default to no comments. Only add one for a non-obvious _why_ — a hidden
  constraint, a workaround for a specific bug, behavior that would surprise
  a reader. [src/turf.d.ts](src/turf.d.ts) and the retry logic in
  [src/geometry/regions.ts](src/geometry/regions.ts) are examples of
  comments that earn their keep.

## Geometry pipeline

For the full pipeline walkthrough, see README.md's "How it works" section.

**Before touching boolean/polygon code**: `@turf/turf` is pinned to `6.5.0`
deliberately — read README.md's "TODO / tech debt" section first, it
explains why and what upgrading requires.
