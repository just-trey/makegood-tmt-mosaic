# Decisions needed

## Two sheets of the whole-chair net overlap, and ink there cuts twice

The net attaches `left` and `right` to `back` at the registration Phase A measured. At that
registration the sheets **cross**: `back`'s storage-box and handle lobes lie under the flanks'.
Measured by the bake (`npx vite-node scripts/bake-zones.mjs scripts/zone-configs/chair-body.json`,
which warns with these figures): **left/back 8,730mm², right/back 8,226mm²**, all of it live
surface (the flanks' wheel shadows do not fall in it). It is two different pieces of the chair —
`assertNoDoubleClaim` guarantees no triangle is in two zones — so a mark drawn there is cut in two
places at once.

Shipped as: measured, warned about at bake time, and cross-hatched on `net-template.svg` with a
legend line. Nothing is dropped and nothing is silent, but a design centred on the canvas will hit
it.

**Question: is that acceptable, or should the net partition the canvas so each point belongs to one
zone?** Partitioning means a per-chart `netRegions` in the sidecar (this zone's claim less what
earlier sheets already cover), a flag on the build input, and a clip the mapper applies — the
`keepSide` mechanism is the precedent. It would cost the later zone that surface **only** for a
whole-chair binding; binding that zone directly still reaches it. Answer "ship the warning" or
"partition it" and the rest of the branch is unaffected either way.
