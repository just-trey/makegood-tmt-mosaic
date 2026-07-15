# Working in this repo

## Keep CHANGELOG.md and README.md current as you go

Don't leave documentation for a separate pass — update it in the same change
that makes it necessary.

- **CHANGELOG.md**: before considering any user-visible change done, add a
  bullet under `## [Unreleased]` (create that section if it's missing),
  using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories
  (Added/Changed/Fixed/Removed). "User-visible" means anything that changes
  what the app does, what it exports, what it accepts as input, or how it
  behaves. Internal refactors, test-only changes, and CI/tooling changes with
  no behavior change don't need an entry.
- **README.md**: if a change affects something the README documents — the
  feature list, the "How it works" pipeline steps, "Known limitations", or
  "Roadmap ideas" — update that section too. A shipped roadmap item should
  move out of "Roadmap ideas" and into a real description of the feature,
  not stay listed as unbuilt.
- When cutting a release, roll the accumulated `[Unreleased]` entries into a
  new dated version section — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
  versioning policy.
