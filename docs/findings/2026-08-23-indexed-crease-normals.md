# Indexed crease normals, in the browser

**Measured 2026-08-23.** Branch `indexed-crease-normals` against `main` at `023b41f`. Chrome via
Playwright, production build for the render comparison and a Vite dev server for the timing.
Renderer: `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060), OpenGL ES 3.1)`.
Machine: Intel i7-10700 (8 cores / 16 threads, 2.9 GHz), 15 GB RAM, WSL2 kernel
6.18.33.2-microsoft-standard-WSL2, Node 24.18.0.

Companion to [2026-08-23-boolean-pass-and-weld.md](2026-08-23-boolean-pass-and-weld.md), which
measured the same thing in Node and concluded it was worth building. This one is the live check on
what shipped.

## Timing

`bufferGeometryFromTris` called both ways on the same soup, median of 3, warmed. Driven in-page
against the real module.

| Part                  |    tris | `toCreasedNormals` | from index |  speedup |
| --------------------- | ------: | -----------------: | ---------: | -------: |
| chair-handle-left     |  46,318 |             82.0ms |      8.5ms |     9.6x |
| chair-storage-left    |  46,494 |             63.0ms |      8.4ms |     7.5x |
| chair-wing-left       |  37,820 |             53.6ms |      5.9ms |     9.1x |
| chair-seat-center     |  18,716 |             25.3ms |      2.8ms |     9.0x |
| chair-caster-std-left |   8,434 |             10.9ms |      1.3ms |     8.4x |
| **total**             | 157,782 |        **234.8ms** | **26.9ms** | **8.7x** |

**The Node bench and the browser disagree, and the browser is the figure that counts.**
`scripts/bench-shading.ts candidate` measures 12.9x on all 13 parts; the display path runs in a
browser, so 8.7x is what a user gets.

Both numbers moved once during review. An earlier draft read 5.4x here and 7.2x in Node, taken
before `Math.hypot` was dropped from the hot loop: it guards against intermediate overflow that
needs coordinates near 1e154, and it measured 11x slower than `Math.sqrt` of the sum. The bench
also carried its own copy of the pass, which had drifted from the shipped one in exactly that
respect; it imports the real function now, so the two cannot diverge again.

## Render

Chair loaded via `?kind=chair-body`, production build, same camera, screenshot clipped to the
canvas, before and after:

- **616 of 864,800 pixels differ (0.071%)**, max channel delta **8/255**.
- Chamfers, seat-clip detail and the embossed logo on the storage leg are all intact. That logo is
  the specific thing `CREASE_ANGLE_RAD` exists to protect: a blanket weld plus
  `computeVertexNormals()` melted it, which is why the crease angle is 30 degrees and not three's 60.

That 0.071% is the expected consequence of sharing vertices exactly rather than by three's 0.01mm
bucket, and matches the corner-level measurement: 65 of 138,954 corners on `chair-handle-left`
differ by more than 1 degree (0.05%).

**The hubcap renders byte-identical: 0 of 864,800 pixels changed.** It is a generated part built
through Manifold, and its index comes from that boolean. tech-debt.md predicted this and it holds:
Manifold emits exactly coincident vertices, so exact sharing and the 0.01mm bucket agree
everywhere. A packed 3MF is the case where they can disagree, because a mesh author can place two
vertices inside one bucket without joining them.

**That result was claimed once before it was true.** The first version of the wiring stopped at
`GeneratedMesh.indexed`: the hubcap kind's `buildMesh` built its return object field by field and
never forwarded it, so the part kept `toCreasedNormals` and rendered byte-identical for the boring
reason. Nothing about the render distinguishes the two cases, which is the trap. The handoff is
now asserted in `tests/hubcap.test.ts`, checked by re-introducing the omission.

## What was left alone, deliberately

An uploaded STL is soup with no sharing recorded, so it keeps `toCreasedNormals` unchanged. That
is not only the cheap option, it is the safer one: switching it to an exact weld would change how
a user's own file shades, and nobody has looked at that. See the tech-debt section.

## Null result worth keeping

**A test written the obvious way took 573 seconds.** Reading a real 46k-triangle part through
`load3MF` needs jsdom for `DOMParser`, and jsdom's `getElementsByTagName` is a live collection, so
walking 23k `<vertex>` elements is quadratic. The same assertions run in **246ms** with the 3MF
scanned by regex in the Node environment. `load3mf-indexed.test.ts` already carried this warning
for the bake readers; it applies to any test that wants a real packed part.
