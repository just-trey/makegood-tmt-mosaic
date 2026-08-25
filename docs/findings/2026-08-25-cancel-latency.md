# Where a long rebuild actually spends its time

**Run:** 2026-08-25, branch `fix-cancel-inside-part`, WSL2 + `MOSAIC_GPU=1`
(ANGLE / D3D12 / RTX 2060). `npm run build` + `vite preview`, driven headless.
Fixture: a wheel carrying an SVG of N non-overlapping rects, 3 colors unless
stated. Cancel clicked at a fixed **t+10s** after the curtain appears; latency is
click to curtain-down.

Written because the 2026-08-24 cycle's **T0-7** diagnosed the wrong phase, and
the first fix built on that diagnosis did almost nothing. The numbers are the
only reason that showed up.

## What was measured

| Build                                                   | Cancel sites                     | Latency                        |
| ------------------------------------------------------- | -------------------------------- | ------------------------------ |
| 6000 regions, 3 colors                                  | per-part only (as shipped)       | **140.4s** (cycle, 2026-08-24) |
| 6000 regions, 3 colors                                  | + per-colour, in the cutter loop | **132.2s**                     |
| 6000 regions, **40 colors**                             | + per-colour, in the cutter loop | **135.3s**                     |
| 6000 regions, 3 colors                                  | + both `regions.ts` yield points | **0.3s**                       |
| 6000 regions, 3 colors, **second rebuild** (depth edit) | as above                         | **0.3s**                       |

## The wrong turn, and the number that caught it

The cycle read 140.4s as the per-part cut being uninterruptible, since
`throwIfCancelled` had one call site at the top of the part loop. Adding a
per-colour check inside the cutter loop — with a `catch` owning `colorPrisms`, so
it is safe — moved it to 132.2s.

**The 40-colour run is what settled it.** If the time were in the cutter loop,
thirteen times more colour boundaries would have cut latency sharply. It went
_up_, to 135.3s. The check was never being reached.

The readout stands at **11%** when the click lands at t+10s. That is inside
`computeNetRegionsByColor`, the 2D paint-order pass, which runs before any
Manifold solid exists. Checking at its two existing yield points: 0.3s.

Note the cycle recorded the readout _climbing_ 24%→40% on this fixture. Both are
true and not in tension: the phase is long, not stuck, and a click at t+10s lands
early in it.

## Why the fix could not go where the cycle pointed

`src/cancel.ts` records the constraint: inside a part, `owned` and `partMan` are
Manifold solids freed by hand on each branch with no outer `try/finally`, so a
throw leaks WASM that repeated cancelling accumulates. `regions.ts` is safe for
the opposite reason to the one the fix needed elsewhere — **it allocates no
solids at all**, so there is nothing to own.

## The null result worth keeping

The per-colour check in the cutter loop **stays**, and on this fixture it is
worth nothing. It is correct, it carries its own owner, and it covers the case
where the time really is in the cutting. Keeping a measurement that showed a
change doing nothing is the point of writing this down: the next person to look
at cancel latency should not re-derive the 132.2s.

## What is not measured

- **No heap measurement behind the new call sites.** The 177.0 MB heap-flat
  figure in `tech-debt.md` was taken on 2026-08-17 against the single original
  site. The `colorPrisms` catch is reasoned from ownership; the `regions.ts`
  sites from there being nothing allocated.
- **The memo.** `computeNetRegionsByColor` is memoized on the shapes array
  identity, so a rebuild that reuses a cached pass would skip both new checks.
  The second-rebuild row above was measured for exactly that reason and came back
  at 0.3s, so the case did not reproduce here; it is not proof the memo can never
  hit in a way that matters.
- **Only the wheel.** No footrest or hubcap runs.
