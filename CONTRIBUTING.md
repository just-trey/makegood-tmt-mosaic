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
npm test
npm run smoke       # builds and exercises the app end-to-end
```

If `format:check` fails, format only the files you actually touched
(`npx prettier --write <files>`) rather than running `npm run format`, which
rewrites the whole tree and buries the real diff.

`npm run test:coverage` runs the same suite and adds a per-file coverage report
(terminal summary plus browsable HTML in `coverage/`). It is a sixth command,
not a sixth gate — CI doesn't run it and there's no threshold to clear. Reach
for it when you're deciding where a new test would earn its keep, especially
under `src/geometry/` and `src/export/`, where a wrong result still looks
plausible.

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
