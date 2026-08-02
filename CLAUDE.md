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

## Docs

Where writing goes — pick one, don't split a topic across two:

- **README** — orientation only: what it is, how to run it, how it works at a
  level someone can hold in their head, what it can't do. Keep it under ~200
  lines; if a section outgrows that, it belongs in `docs/`.
- **[docs/pipeline.md](docs/pipeline.md)** — how the geometry actually works;
  read this before touching `src/geometry/` or `src/export/`.
- **[docs/tech-debt.md](docs/tech-debt.md)** — deferred work, known-wrong
  behavior, measurements worth not re-taking. One `##` section per item,
  stating what was measured, why it was deferred, and what closing it would
  take. This is where the "write deferred work down, don't just remember it"
  rule points.
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — one section per
  user-visible warning string.
- **[docs/roadmap.md](docs/roadmap.md)** — ideas not yet built.
- **CHANGELOG.md** — what changed per release, nothing else.

**Before touching boolean/polygon code**: `@turf/turf` is pinned to `6.5.0`
deliberately — read [docs/tech-debt.md](docs/tech-debt.md) first, it explains
why and what upgrading requires.

## Planning

Every plan names the model for each work item, so the choice is made once at
planning time instead of re-litigated per session:

- **Opus** — `src/geometry/`, `src/export/`, placement/scene math, anything
  where a wrong number ships a bad print.
- **Sonnet** — `src/ui/`, state plumbing, docs, config, test scaffolding.
- Split a PR across both when it has a geometry half and a UI half.

Verify by running the app, not only by running the tests.
