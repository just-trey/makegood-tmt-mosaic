# Contributing to TMT Mosaic

Thanks for considering a contribution. This project is a small, volunteer-run
tool that supports [MakeGood](https://makegood.design)'s Toddler Mobility
Trainer, so keeping the process lightweight matters more than process for its
own sake.

By participating, you're expected to follow the [Code of
Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bug fixes and small improvements**: just open a PR.
- **New features or anything that changes behavior**: open an issue first to
  discuss the approach before writing code. This avoids wasted work if the
  idea doesn't fit the project's direction — see
  [docs/roadmap.md](docs/roadmap.md) for known wanted directions.

## Development setup

```bash
npm install
npm run dev        # dev server with hot reload
```

Before opening a PR, make sure all five of these pass — they're exactly what CI
runs, and `main` is protected, so a red one blocks the merge:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage   # the suite, plus the coverage floors below
npm run smoke           # builds and exercises the app end-to-end
```

If `format:check` fails, format only the files you actually touched
(`npx prettier --write <files>`) rather than running `npm run format`, which
rewrites the whole tree and buries the real diff.

## Coverage floors

`npm run test:coverage` is the test gate — the same suite as `npm test`, plus a
coverage report (terminal summary and browsable HTML in `coverage/`) and a floor
for each directory, declared in [vite.config.ts](vite.config.ts). Plain
`npm test` still runs the suite uninstrumented if you want a faster inner loop,
but CI runs the coverage one, so that's the one that decides.

The floors are a **ratchet, not a target**: each sits a few points _under_ what
that directory already achieves, so they never ask for a test that doesn't exist
yet — they only stop the number sliding backwards. Tripping one means coverage
went down in your diff, and the fix is a test, not a lower floor. A breach looks
like this, and is a floor rather than a failing test:

```
ERROR: Coverage for statements (91.4%) does not meet "src/geometry/**" threshold (92%)
```

It names a glob because the floors are aggregates over a whole directory — read
the coverage table to find which file in it lost ground.

Two floors are tripwires rather than targets, and are set well below the rest on
purpose: `src/scene/` is dominated by `viewport.ts`, which owns the WebGL
renderer and can't be unit tested without a GL context, and `src/ui/` is mostly
DOM wiring. They exist so those areas can't quietly rot, not to be met.

To raise a floor after genuinely improving an area, run `npm run test:coverage`,
read the actual, and edit the number by hand — `autoUpdate` is deliberately off,
since it rewrites `vite.config.ts` mid-run and lands surprise diffs in a PR.

See the [README](README.md) for how the codebase is organized
(`src/svg/`, `src/geometry/`, etc.) and the known limitations/tech-debt
sections before making structural changes.

## Pull requests

- Branch off `main` before you start. `main` is protected — it takes PRs
  only, and rejects direct pushes — so a commit made on `main` can never
  land anyway. The pre-commit hook refuses those outright rather than
  letting you find out at push time; if you've already started,
  `git checkout -b <name>` brings your uncommitted work with it.
- Keep PRs focused — one logical change per PR is easier to review and
  revert if needed.
- Describe _why_ the change is needed, not just what it does — the diff
  already shows what changed.
- Add or update tests under `tests/` for behavior changes.
- If your change is user-visible, add an entry under `[Unreleased]` in
  [CHANGELOG.md](CHANGELOG.md).

## Versioning

This project uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
It's currently pre-1.0 (`0.x.y`), which under semver means the public
behavior (file formats produced, supported SVG features, CLI/UI surface) can
still change between minor versions without a major bump. Once the export
formats and supported input surface feel settled, we'll cut `1.0.0` and
start honoring the stricter pre/post-1.0 compatibility guarantees.

- **PATCH** (`0.1.x`): bug fixes, no behavior change to existing outputs.
- **MINOR** (`0.x.0`): new features, backward-compatible.
- **MAJOR** (`x.0.0`, post-1.0 only): breaking changes to exported file
  formats or supported inputs.

Releases are tagged (`vX.Y.Z`) against `main`, with notes drawn from
[CHANGELOG.md](CHANGELOG.md). Pushing a `v*` tag is what deploys the live
site — merging to `main` does not. This means `main` can carry multiple
merged, CI-checked PRs ahead of what's actually live; nothing ships until a
release is deliberately tagged.

## Questions

Open a [GitHub issue](https://github.com/just-trey/makegood-tmt-mosaic/issues)
or reach out at oss@lazybeagle3d.com.
