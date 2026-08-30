# Decisions needed

## Is the back cushion in `stubs/dead-zones.3mf` bigger than the real one?

The Front sheet's four marked areas are 80-86% clear after the hemisphere rebake, not gone:

| Marked box (template mm)      | Before  | After  |
| ----------------------------- | ------- | ------ |
| top-left (9,46)-(23,68)       | 138mm²  | 27mm²  |
| top-right (193,46)-(211,68)   | 154mm²  | 30mm²  |
| low-left (9,157)-(50,222)     | 912mm²  | 180mm² |
| low-right (165,157)-(211,222) | 1068mm² | 151mm² |

Measured by rastering each box at 0.25mm against every `front` chart's `deadRegions` in the
sidecar, before (`git show 2454dbd:public/stl/chair-body-zones.json`) and after.

The residual is not classifier noise. Every sample still marked hidden in the two left-hand boxes
sits on `chair-handle-right` at x = -90..-97, y = 338..507, z ≈ -455, with a cover triangle 2-7mm
away and a blocked fraction of **1.000** — all 32 directions run into the back cushion. Those
points are inside the cushion body's own bbox (x ±137, y 325..550, z -478..-385), so the cushion's
side face is pressed against the handle's inner face there.

The brief says that surface is visible and "must come out entirely". The geometry in the covers
file says it is buried. One of these has to give, and only you can say which:

- **The covers file is right** — the residual stays, and the acceptance target was written against
  the old (much larger) slivers rather than these.
- **The cushion is modelled oversize** — the fix is in `stubs/dead-zones.3mf`, not in the
  classifier. Trimming the cushion's width there re-bakes these boxes to zero on its own.

Not decidable from here: I have no reference for the real cushion's width. Nothing was tuned to
close it — a threshold picked to delete surface measured as fully enclosed would be a number with
no measurement behind it.
