# Working in this repo

## Commands

```bash
npm install
npm run dev         # dev server with hot reload
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run format      # prettier --write .
npm test            # vitest run
npm run smoke       # build + end-to-end smoke test (scripts/smoke.mjs)
npm run build       # typecheck + production build to dist/
```

## Before opening a PR

- `lint`, `format:check`, `typecheck`, `test`, and `smoke` must all pass —
  CI runs the same steps on every PR and blocks merge into `main` if any
  fail. A pre-commit hook (husky + lint-staged) auto-formats staged files;
  don't run `npm run format` across the whole repo — it churns file endings
  on Windows.
- If the change touches `src/geometry/` or `src/export/`, run `/code-review`
  on the diff before opening the PR. Skip it for docs, UI copy, and other
  trivial changes.
- Add a bullet under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for
  any user-visible change (Keep a Changelog categories: Added/Changed/Fixed/
  Removed). Skip it for internal refactors, tests, or CI/tooling changes with
  no behavior change.
- Update [README.md](README.md) if the change touches something it
  documents — the feature list, "How it works" pipeline steps, "Known
  limitations", or "Roadmap ideas". A shipped roadmap item moves out of
  "Roadmap ideas" into a real feature description, not left listed as
  unbuilt.
- Update the in-app help panel (`#help-dialog` in [index.html](index.html))
  if the change adds/removes/renames a left-panel control or section, or
  changes what one does — the panel's sections mirror `#left`'s 1:1 and its
  copy is static, so it drifts silently otherwise.

## Git workflow

- `main` is protected: PRs required, the CI check must pass, no direct
  pushes, no force-push or branch deletion.
- Branch off `main`, keep one focused change per branch/PR.
- Versioning is semver, currently pre-1.0 (`0.x.y`) — see
  [CONTRIBUTING.md](CONTRIBUTING.md#versioning) before deciding whether a
  change is PATCH/MINOR/MAJOR-equivalent.

## Code conventions

- ESLint (`eslint.config.js`, typescript-eslint recommended) + Prettier
  (`.prettierrc.json`) are configured — run `npm run lint` /
  `npm run format` rather than hand-formatting.
- TypeScript `strict` is on (see [tsconfig.json](tsconfig.json)); don't
  weaken it to make something compile.
- Default to no comments. Only add one for a non-obvious _why_ — a hidden
  constraint, a workaround for a specific bug, behavior that would surprise
  a reader. [src/turf.d.ts](src/turf.d.ts) and the retry logic in
  [src/geometry/regions.ts](src/geometry/regions.ts) are examples of
  comments that earn their keep.

## Architecture map

- `src/svg/` — SVG parsing (paths/shapes → geometry, transforms, curve
  flattening)
- `src/geometry/` — region computation (`regions.ts`), flat-plate mode
  (`flat.ts`), assembly-mode mesh cutting (`assembly.ts`)
- `src/assembly/` — part library loading and assembly-mode part logic
- `src/export/` — 3MF/STL export
- `src/scene/` — three.js viewport
- `src/ui/` — panel wiring, one module per left-panel section
- `src/state/` — filament palette and other async-loaded state

For the full pipeline walkthrough, see README.md's "How it works" section.

**Before touching boolean/polygon code**: `@turf/turf` is pinned to `6.5.0`
deliberately — read README.md's "TODO / tech debt" section first, it
explains why and what upgrading requires.
