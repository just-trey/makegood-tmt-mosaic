---
name: debug-csg-failure
description: Investigate an assembly-mode CSG failure — a "Couldn't build/combine the cut solid", "Boolean cut failed", or "Couldn't fit the inlay" warning — and force any of those branches against the real Manifold engine with ?csgfault to check what actually ships. Use when one of those warnings is reported, or after changing anything in the assembly cut/inlay path.
model: opus
---

# Debug a CSG failure

Two different jobs, and it's worth knowing which one you're on:

- **A user hit a warning.** Start at "Which failure is this" — the outcome is
  already documented and the fix is usually upstream of the boolean.
- **You changed the cut/inlay path** and need to know the degradation still
  works. Skip to "Force a branch against the real engine."

## Which failure is this

[docs/troubleshooting.md](../../../docs/troubleshooting.md) has one section per
warning string and, more usefully, what each one costs the user — color
dropped, part uncut, empty recess, part dropped. Read it rather than
re-deriving the outcome from the code; the section on the 3D boolean failures
enumerates all four.

Two things worth keeping straight, because the strings look alike:

- **"Couldn't build the cut solid for color … "** is the 2D→3D step, not a
  boolean between solids. It fires when the clipped region won't extrude into a
  watertight prism at all. The app already retries it once with the region
  repaired by Manifold's 2D engine, so a warning that survives that is usually a
  genuinely bad path in the SVG — and path-cleaning at the source
  (Illustrator/Inkscape **Path → Union**) is the real fix.
- **"Couldn't measure the fill area on … "** isn't a boolean failure at all,
  despite sitting in the same family of messages. It's `fillExtent()` returning
  nothing, and it degrades to a single copy of the artwork rather than a fill.
  Don't chase it into Manifold.

Counting the `Couldn't …` sites in
[src/geometry/assembly.ts](../../../src/geometry/assembly.ts) will mislead you:
six strings, but only **four** are Manifold boolean branches (the per-color
merge, the part-wide merge, the body difference, the inlay intersection). The
other two are the extrude step and the fill measure above. Two further failure
branches don't use the word at all — the part mesh being unreadable by the
engine, and the part not being watertight.

## Force a branch against the real engine

The `CSG failure handling` tests in
[tests/assembly.test.ts](../../../tests/assembly.test.ts) cover every branch,
but with `Manifold.union` / `.difference` / `.intersection` replaced by spies.
That proves the handler runs. It cannot show what the engine, the viewport and
the exporter do afterwards, which is the half that ships.

[src/geometry/csgFault.ts](../../../src/geometry/csgFault.ts) arms a forced
failure from the URL at the five points where a real one originates:

| `?csgfault=`   | Forces                                      | Documented outcome                   |
| -------------- | ------------------------------------------- | ------------------------------------ |
| `color-union`  | one color's cutters failing to merge        | that color dropped, others still cut |
| `part-union`   | the part-wide cutter merge                  | part exported uncut                  |
| `difference`   | the body cut                                | part exported uncut, no inlays       |
| `body-mesh`    | mesh conversion **after** the cut succeeded | same, plus the freed-handle path     |
| `intersection` | one inlay                                   | pocket cut, recess ships empty       |

Add `:N` to fire only the first N times **per rebuild** (`?csgfault=color-union:1`).
The budget resets per build on purpose — a session-wide one gets spent by an
intermediate rebuild, and the build left on screen then comes out clean with its
predecessor's warning already cleared, which reads as "the fault did nothing."

Two traps when driving this by hand:

- `color-union` merges one color's prisms **across zones**, so with a single
  artwork every color has one prism, `Manifold.union` is never called, and the
  fault fires where no real failure could originate. Load the artwork twice
  before trusting that case.
- Unlimited `color-union` drops every color on every part, which is
  indistinguishable from `part-union` in the exported file. Use `:1`.

The hook is deliberately **not** `import.meta.env.DEV`-gated, for the same
reason `window.__mosaic` isn't (see [src/main.ts](../../../src/main.ts)): the
drive scripts verify `vite preview` output, which is a production build, so a
DEV gate would put these branches out of reach of exactly the checks that need
them. An armed page announces itself as a standing warning.

## The repeatable check

```bash
npm run build && node scripts/check-csg-failure.mjs [outDir]
```

Drives the wheel through every fault point plus two undamaged baselines,
exports a real 3MF each time, and asserts what reached the file. Run it after
touching the cut/inlay path. It fails loudly on a branch that degrades
_silently_ (no warning) as well as one that degrades wrongly — a silent drop is
the worse bug, since the user prints a part that's missing a color and nothing
said so.

It asserts against a measured baseline rather than literals, which is what makes
the interesting distinction possible: `intersection` and `difference` both ship
one body and zero inlays, so **body triangle count** is the only thing in the
file that separates "pocket cut, recess empty" from "exported uncut." Baseline
numbers and the first full run are in
[docs/tech-debt.md](../../../docs/tech-debt.md).

What this does **not** cover: the faults force the handler to run, so they prove
the degradation and the WASM cleanup, not that Manifold fails on any particular
real mesh. A genuinely malformed part reaching the engine is still untested.

## Then

Verify in the app, not only through the script — arm one fault, look at the
viewport, and read the warning panel as a user would. Then run `ship-it`; this
touches `src/geometry/`, so `/code-review` is required, not optional.
