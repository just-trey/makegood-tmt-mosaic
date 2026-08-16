---
name: verify-new-bed-size
description: Verify and bake chair export placement for a printer bed size beyond the two already checked (270mm Snapmaker, 256mm Bambu A1). Use when asked to support a new printer/bed size, or when a bed other than those two is reported to place plates or prime towers wrong.
model: opus
---

# Verify a new bed size

Every bed besides the Bambu A1 (256mm) and Snapmaker U1 (270mm) inherits the
270mm plate and tower positions **untested**: see README "Known limitations" and
[tech-debt.md](../../../docs/tech-debt.md). This sequence promotes a bed from
untested to verified.

**It has a human step in the middle that cannot be automated.** Plan for that
when scheduling.

Before running any of this, re-read each script's own `USAGE` header rather than
trusting the flags below. They are transcribed from what's there today; this
skill orchestrates, it doesn't own the contract.

## 1. Generate the example exports

```bash
npm run build && node scripts/export-chair-examples.mjs [outDir]
```

Drives the real app (see [run-app](../run-app/SKILL.md)) through both variants
on both printer targets, each with a 4-filament test SVG filled across every
zone. The filament count matters: it is the case that actually needs a prime
tower.

Reports per-plate filament counts and tower position, and fails loudly if a
plate came out body-only (artwork didn't reach it) or a tower landed off the
_current_ bed. Files land in `outDir`, default `stubs/`.

## 2. Human step, cannot be automated

Open each exported `.3mf` in Bambu Studio or Orca Slicer configured for the
**new** bed size. For every plate, drag the prime tower into a position that
actually clears the geometry, then save the file back.

**Stop here and hand off explicitly.** There is no way to work this out from
outside the slicer: it depends on what the slicer lays down for that bed, which
is the whole reason this step exists rather than being computed.

## 3. Bake placement from the verified files

```bash
npx vite-node scripts/bake-chair-placement.mjs [<reference.3mf>] \
  [--towers <verified.3mf>] [--out <file.ts>] [--tol <mm>]
```

Defaults: reference `stubs/chair-body-all-parts.3mf`, towers
`stubs/chair-tower-reference-snapmaker.3mf` and
`stubs/chair-tower-reference-a1.3mf`, out `src/export/chairPlacement.ts`.

Add the new bed's saved files from step 2 via `--towers`, which is repeatable:
the first supplies the default deltas, later ones override only where they
disagree.

The script re-verifies every shipped mesh's plate-space bounding box against the
reference before writing, and **refuses to write on a mismatch**. That guard
catches a part re-packed or revised since the reference was captured, rather
than silently baking a pose against a mesh that no longer matches.

Tower deltas are stored as an offset from each plate's anchor part, not a bed
coordinate, so they survive the re-centering a different bed applies.

## 4. Confirm the diff and record what is now verified

- `git diff src/export/chairPlacement.ts` should touch only the new bed's rows.
  Anything else means an unrelated part moved and needs its own placement
  re-check ([add-part](../add-part/SKILL.md) step 4) first.
- Update README "Known limitations" and
  [tech-debt.md](../../../docs/tech-debt.md) with the newly verified bed, so the
  next reader doesn't re-derive which sizes are checked from git history.

Then run `ship-it`. This touches `src/export/`, so `/code-review` is required,
not optional.
