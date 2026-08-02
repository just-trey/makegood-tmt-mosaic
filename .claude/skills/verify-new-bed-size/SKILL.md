---
name: verify-new-bed-size
description: Verify and bake chair export placement for a printer bed size beyond the two already checked (270mm Snapmaker, 256mm Bambu A1). Use when asked to support a new printer/bed size, or when a bed other than those two is reported to place plates or prime towers wrong.
model: opus
---

# Verify a new bed size

Every bed size besides the Bambu A1 (256mm) and Snapmaker U1 (270mm) currently
inherits the 270mm plate/tower positions **untested** — see README "Known
limitations" and [docs/tech-debt.md](../../../docs/tech-debt.md). This is the
sequence that promotes a new bed size from untested to verified. It has a human
step in the middle that cannot be automated — plan for that when scheduling
this.

Before running any of this, re-read each script's own `USAGE`/header comment
rather than trusting the flags below — they're transcribed from what's there
today, and this skill only orchestrates, it doesn't own the contract.

## 1. Generate the example exports

```bash
npm run build && node scripts/export-chair-examples.mjs [outDir]
```

Drives the real app (see [run-app](../run-app/SKILL.md)) through both variants
on both printer targets, each with a 4-filament test SVG in fill mode across
every zone — the number of filaments matters because it's the case that
actually needs a prime tower. Reports per-plate filament counts and tower
position, and fails loudly if any plate came out body-only (artwork didn't
reach it) or if a tower landed off the _current_ bed. Files land in `outDir`
(default `stubs/`).

## 2. Human step — cannot be automated

Open each exported `.3mf` in Bambu Studio or Orca Slicer configured for the
**new** bed size. For every plate: drag the prime/wipe tower into a position
that actually clears the geometry, then save the file back.

Stop here and hand off explicitly. There is no way to work this out from
outside the slicer — it depends on what the slicer actually lays down for that
bed, which is the entire reason this step exists rather than being computed.

## 3. Bake placement from the verified files

```bash
npx vite-node scripts/bake-chair-placement.mjs [<reference.3mf>] \
  [--towers <verified.3mf>] [--out <file.ts>] [--tol <mm>]
```

Defaults: reference `stubs/chair-body-all-parts.3mf`, towers
`stubs/chair-tower-reference-snapmaker.3mf` and
`stubs/chair-tower-reference-a1.3mf`, out `src/export/chairPlacement.ts`. Add
the new bed's human-saved file(s) from step 2 via `--towers` (repeatable — the
first file supplies the default deltas, later ones override only where they
disagree).

This re-verifies every shipped mesh's plate-space bounding box against the
reference before writing anything, and refuses to write on a mismatch — that
guard is what catches a part that's been re-packed or revised since the
reference was captured, rather than silently baking a pose against a mesh that
no longer matches. Tower deltas are stored as an offset from each plate's
anchor part, not as a bed coordinate, so they survive the re-centering a
different bed size applies to the whole plate.

## 4. Confirm the diff and record what's now verified

- `git diff src/export/chairPlacement.ts` should touch only the new bed's
  rows. Anything else changing means an unrelated part moved and needs its own
  placement re-check (see [add-part](../add-part/SKILL.md) step 4) before you
  proceed.
- Update README "Known limitations" and
  [docs/tech-debt.md](../../../docs/tech-debt.md) to record the newly verified
  bed size, so the next reader doesn't have to re-derive which sizes are
  actually checked from git history.

Then run the `ship-it` skill — this touches `src/export/`, so `/code-review` is
required, not optional.
