---
name: debug-csg-failure
description: Investigate an assembly-mode CSG failure (a "Couldn't cut … into …", "Couldn't merge …", or "Couldn't fit the inlay" warning) and force any of those branches against the real Manifold engine with ?csgfault to check what actually ships. Use when one of those warnings is reported, or after changing anything in the assembly cut/inlay path.
model: opus
---

# Debug a CSG failure

Two different jobs. Know which you are on:

- **A user hit a warning.** Start at "Which failure is this". The outcome is
  already documented and the fix is usually upstream of the boolean.
- **You changed the cut or inlay path.** Skip to "Force a branch against the
  real engine".

## Which failure is this

[troubleshooting.md](../../../docs/troubleshooting.md) has one section per
warning string and, more usefully, what each costs the user: colour dropped,
part uncut, empty recess, part dropped. Read it rather than re-deriving the
outcome from code.

Two strings look alike and aren't:

- **"Couldn't cut color … into …"** is the 2D-to-3D step, not a
  boolean between solids. It fires when the clipped region won't extrude into a
  sealed prism. The app already retries once with the region repaired, so a
  warning that survives is usually a genuinely bad path in the SVG.
  Path-cleaning at the source (Illustrator or Inkscape **Path → Union**) is the
  real fix.
- **"Couldn't measure the fill area on …"** is not a boolean failure at all,
  despite sitting in the same family. It is `fillExtent()` returning nothing,
  and it degrades to a single copy of the artwork. Don't chase it into Manifold.

**Almost every branch opens with `Couldn't` (the watertight check at
[assembly.ts](../../../src/geometry/assembly.ts) is the exception: "Part … isn't
a watertight/manifold mesh"), so counting those sites in
[assembly.ts](../../../src/geometry/assembly.ts) tells you nothing about which
are Manifold.** Only **four** are boolean branches: the per-colour merge
("Couldn't merge color …"), the part-wide merge ("Couldn't merge the recesses
on …"), the body difference ("Couldn't cut the recesses into …") and the inlay
intersection ("Couldn't fit the inlay …"). The rest are the two extrude attempts
("Couldn't cut color … into …"), the fill measure, the part mesh being
unreadable ("Couldn't read …") and the part not being watertight. The wording
distinguishes cut-one-colour from merge-many; it does not distinguish 2D from
3D, so map the string to a branch here rather than guessing from the verb.

## Force a branch against the real engine

The `CSG failure handling` tests in
[assembly.test.ts](../../../tests/assembly.test.ts) cover every branch, but with
`Manifold.union`, `.difference` and `.intersection` replaced by spies. That
proves the handler runs. It cannot show what the engine, viewport and exporter
do afterwards, which is the half that ships.

[csgFault.ts](../../../src/geometry/csgFault.ts) arms a forced failure from the
URL at the five points where a real one originates:

| `?csgfault=`   | Forces                                      | Documented outcome                   |
| -------------- | ------------------------------------------- | ------------------------------------ |
| `color-union`  | one color's cutters failing to merge        | that color dropped, others still cut |
| `part-union`   | the part-wide cutter merge (2+ colors)      | that part exported uncut             |
| `difference`   | the body cut                                | part exported uncut, no inlays       |
| `body-mesh`    | mesh conversion **after** the cut succeeded | same, plus the freed-handle path     |
| `intersection` | one inlay                                   | pocket cut, recess ships empty       |

Add `:N` to fire only the first N times **per rebuild**
(`?csgfault=color-union:1`). The budget resets per build on purpose: a
session-wide one gets spent by an intermediate rebuild, and the build left on
screen then comes out clean with its predecessor's warning already cleared,
which reads as "the fault did nothing".

Two traps when driving this by hand:

- **`color-union` merges one colour's prisms across zones**, so with a single
  artwork every colour has one prism, `Manifold.union` is never called, the
  fault never fires, and the build comes out clean. Load the artwork twice
  before trusting that case. `part-union` has the same shape: one colour means
  no part-wide merge and nothing to force.
- **Unlimited `color-union` is indistinguishable from `part-union`** in the
  exported file, since it drops every colour on every part. Use `:1`.

The hook is deliberately **not** `import.meta.env.DEV`-gated, for the same
reason `window.__mosaic` isn't (see [main.ts](../../../src/main.ts)): the drive
scripts verify `vite preview` output, a production build, so a DEV gate would
put these branches out of reach of the checks that need them. An armed page
announces itself on every rebuild, because loading an SVG clears the notice list
and a once-only notice would be gone by the build where the fault fires.

## The repeatable check

```bash
npm run build && node scripts/check-csg-failure.mjs [outDir]
```

Drives the wheel through every fault point plus two undamaged baselines, exports
a real 3MF each time, and asserts what reached the file. Run it after touching
the cut or inlay path.

It fails loudly on a branch that degrades _silently_ (no warning) as well as one
that degrades wrongly. **The silent drop is the worse bug**, since the user
prints a part missing a colour and nothing said so.

It asserts against a measured baseline rather than literals, which is what makes
the interesting distinction possible: `intersection` and `difference` both ship
one body and zero inlays, so **body triangle count** is the only thing in the
file separating "pocket cut, recess empty" from "exported uncut". Baseline
numbers and the first full run are in the `CASES` docstring in
[check-csg-failure.mjs](../../../scripts/check-csg-failure.mjs).

**What this does not cover:** the faults force the handler to run, so they prove
the degradation and the WASM cleanup, not that Manifold fails on any particular
real mesh. A genuinely malformed part reaching the engine is still untested.

## Then

Verify in the app, not only through the script: arm one fault, look at the
viewport, read the warning panel as a user would. Then run `ship-it`. This
touches `src/geometry/`, so `/code-review` is required, not optional.
