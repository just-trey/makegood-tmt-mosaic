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
  idea doesn't fit the project's direction — see the [Roadmap
  ideas](README.md#roadmap-ideas-not-built) section of the README for known
  wanted directions.

## Development setup

```bash
npm install
npm run dev        # dev server with hot reload
```

Before opening a PR, make sure these all pass:

```bash
npm run typecheck
npm test
npm run smoke       # builds and exercises the app end-to-end
```

See the [README](README.md) for how the codebase is organized
(`src/svg/`, `src/geometry/`, etc.) and the known limitations/tech-debt
sections before making structural changes.

## Pull requests

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
