# One zone against five, on the sticker path

**Measured 2026-08-08.** Commit `c2d7767`, production build (`npm run build`), `vite preview`,
`MOSAIC_GPU=1`.
Renderer: `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060), OpenGL ES 3.1)`.
Machine: Intel i7-10700 (8 cores / 16 threads, 2.9 GHz), 15 GB RAM, WSL2 kernel
6.18.33.2-microsoft-standard-WSL2, Node 24.18.0.
Script: [scripts/bench-zone-rebuild.mjs](../../scripts/bench-zone-rebuild.mjs), three passes per
cell, chair body, Sticker mode, a plain three-colour SVG with no absolute size (so it auto-fits the
way a dropped file does).

Timed from the click that changes the zone binding to the rebuild curtain going down and the app's
own idle counter settling — i.e. what the user waits, not what the boolean costs.

## The numbers

| Zone bound         | design at 100% |    tris | design at 400% |      tris |
| ------------------ | -------------: | ------: | -------------: | --------: |
| Left side          |          1.2 s | 388,462 |          3.8 s |   580,824 |
| Back               |          2.2 s | 396,620 |          5.2 s |   682,644 |
| Front              |          2.0 s | 405,654 |          4.9 s |   583,164 |
| Right side         |          1.2 s | 388,676 |          3.8 s |   580,852 |
| Seat               |          1.7 s | 402,638 |          4.4 s |   560,070 |
| **five, one each** |      **8.3 s** |       — |     **22.1 s** |         — |
| **All zones**      |      **4.0 s** | 508,702 |     **17.0 s** | 1,514,186 |

Spread across the three passes was at most 0.2 s in every cell but "all zones at 400%" (16.7–17.3
s), so these are not noisy.

## What it says

**All five at once is cheaper than five separate one-zone rebuilds — 2.1x cheaper at 100%, 1.3x at
400%.** Binding one design to every zone costs 4.0 s; binding it to each of the five in turn costs
8.3 s of waiting spread over five interactions. The whole-assembly work that does not depend on
which zone is bound — reading the parts, the per-part boolean setup, re-triangulating and handing
368k triangles of chair to the display path — is paid once per rebuild, not once per zone, and at
100% it is most of the time.

**So a zone-first UI does not make the work cheaper by making it smaller; it makes it more
frequent.** Five selections is 8.3 s of curtain rather than 4.0 s, and 22.1 s rather than 17.0 s
once the design is large enough to matter. The gain is in the shape of the wait, not its total: no
single pause is longer than 5.3 s at any size measured here, against 17.0 s for the all-zones
rebuild. Against convention 23 ("any operation that can exceed a few seconds is cancellable and
names what it is working on"), a zone-first flow is a _better_ place to be — five 4-second waits
each naming one surface is a far easier thing to make cancellable and legible than one 17-second
wait naming nothing.

**The design's size dominates the zone count.** A 400% design is 3.2x the cost of the same design
at 100% on the same single zone, and 4.3x on all zones. What is being paid for is pocket area, not
surfaces touched. That also explains the gap between this and the 19.5 s five-zone sticker figure
in [tech-debt.md](../tech-debt.md): that measurement used a design covering the zones, and this one
at 400% reproduces it (17.0 s). An ordinary auto-fit sticker is 4.0 s. **Both are true and they are
5x apart, so "a five-zone sticker rebuild is 19.5 s" should not be quoted without saying at what
size.**

## What this does not measure

- **Fill mode**, which is withheld on the chair (`withholdFill`) and is the path with the
  405.6 s / 93.6 s numbers. Nothing here contradicts those; a sticker is a different amount of
  geometry.
- **The first bind**, which pays for parsing and zone-chart attachment as well. Every number above
  is a re-bind on an already-loaded design, which is what a zone-first UI would do repeatedly.
- **Whether a per-zone rebuild could be made incremental.** These are all full rebuilds — changing
  the binding re-cuts all thirteen parts, including the eight the zone does not touch. That is the
  interesting number a zone-first design would want next, and it is not one this measurement can
  produce: nothing in the pipeline rebuilds a subset today.
- **A cancel.** There still isn't one, at any of these durations.
