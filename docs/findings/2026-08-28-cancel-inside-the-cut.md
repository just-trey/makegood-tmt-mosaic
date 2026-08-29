# Cancelling once the cut has started

**Run:** 2026-08-28, branch `debt/h-cancel-finally`, WSL2 + `MOSAIC_GPU=1`
(ANGLE / D3D12 / RTX 2060). `npm run build` + `vite preview`, driven headless by
`scripts/check-cancel-latency.mjs` (committed with this change). Fixture: a wheel
carrying an SVG of 6000 non-overlapping rects in 3 colors, the shape the
[2026-08-25 run](2026-08-25-cancel-latency.md) used.

Closes the rest of that report: the per-part body now has one `finally` over the
Manifold solids it holds, and three more `throwIfCancelled` sites inside it.

## What was measured

`npm run build && MOSAIC_GPU=1 node scripts/check-cancel-latency.mjs 6000 6`

| Round | Cut phase reached after | Cancel latency | WASM heap |
| ----- | ----------------------- | -------------- | --------- |
| 1     | 160.9s                  | **0.08s**      | 16.8 MB   |
| 2     | 0.7s                    | **0.05s**      | 16.8 MB   |
| 3     | 2.1s                    | **0.05s**      | 16.8 MB   |
| 4     | 0.7s                    | **0.04s**      | 16.8 MB   |
| 5     | 0.8s                    | **0.05s**      | 16.8 MB   |
| 6     | 0.7s                    | **0.04s**      | 16.8 MB   |

- The click is armed **inside the page** and fires from a rAF when the curtain's
  readout crosses 42%, which is the first reading past the region pass (0-40%
  regions, 40-100% the per-part cut). Driving the click from node missed the
  window: the cut phase is short and holds the main thread between yields.
- Round 1's 160.9s is the region pass. Rounds 2-6 are depth edits, which reuse
  the memoized regions and re-enter the cut in under 3s.
- **Four further runs of the same command reproduced it, and bound the spread.**
  Round 1 came back between **0.07s and 0.29s**, rounds 2-6 between **0.04s and
  0.06s**, and the heap was flat in every run. The region pass itself moved most:
  156.6s, 160.9s and 215.2s on the same fixture. The first cancel of a session is
  the one worth quoting as a third of a second rather than a twentieth.
- Every round asserts Export came back **disabled**. A build that completed
  leaves it enabled, so the assertion separates "the press aborted the cut" from
  "the cut happened to finish just then".

## The heap number means something, and here is the run that proves it

Same script, same fixture, with the new `finally` body emptied and everything
else left in place:

| Round     | 1    | 2    | 3    | 4    | 5    | 6        |
| --------- | ---- | ---- | ---- | ---- | ---- | -------- |
| WASM heap | 16.8 | 16.8 | 20.2 | 24.2 | 29.1 | **34.9** |

**+18.1 MB over six cancels** by that table, against +0.0 MB with the `finally`
in place. The script's own summary line prints +18.2 MB, off the unrounded byte
counts rather than the megabytes above. That
is the leak the 2026-08-25 report reasoned about and could not measure, and it is
why a check could not previously sit inside a part.

WASM, not the JS heap: a leaked Manifold solid lives in the engine's
`WebAssembly.Memory`, which `usedJSHeapSize` does not count. The script reads it
by walking the instance's exports for a `WebAssembly.Memory` **value** —
manifold-3d's glue reaches its heap as `wasmExports["I"]`, so an earlier version
looking up `exports.memory` by name reported a flat 0.0 MB and measured nothing.

## The phase split, unchanged

The region pass still owns nearly all of a first rebuild: round 1 spent 160.9s
before the readout left it. The 2026-08-25 conclusion stands, and this run does
not re-measure the cut phase's own duration -- the table's column is arm-to-click
time, not that. What changed is only that the short phase is no longer
uninterruptible.

## What is not measured

- **Only the wheel.** No footrest, hubcap or chair run. The chair in Fill is the
  case where the cut itself is heavy (93.6s for one zone, recorded on
  `showOverlay`), so it is where a single atomic boolean would show.
- **The step already running is still atomic.** The checks sit between colours
  and between booleans, so the floor is one union, difference or intersection, or
  one colour's extrusions plus the repair ladder behind them. On this fixture
  that is inside 0.08s; on a heavy part it is unmeasured.
- **Each latency carries about a frame.** Both the click and the curtain-down
  reading come from rAF callbacks, so every figure is quantised to roughly 16ms
  on this machine. The rounds 2-6 spread is two to four frames wide, and the
  variation inside it may be nothing else. Round 1's 0.29s outlier is not: that
  is eighteen frames.
- **Why the first cancel is the slow one is not established.** It is the only one
  arriving straight off a 160s region pass, on a part whose booleans have not run
  yet. Nothing here separates a cold allocator from a longer first boolean.
- **The `regions.ts` sites still have no heap measurement**, and still do not
  need one: that pass allocates no solids.
