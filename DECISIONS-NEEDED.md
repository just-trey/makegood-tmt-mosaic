# Decisions needed

## Should the covers reference carry the wheels' tires?

`stubs/dead-zones.3mf` has the printed wheel only — two halves plus the cap. The real wheel in the
2026-08-30 photos runs a tire ring outside that, and the bake has no idea it exists.

Measured on the stub:

|                                            |                                                        |
| ------------------------------------------ | ------------------------------------------------------ |
| wheel body                                 | 280.0mm across, 48.5mm thick, silhouette 31,302mm²     |
| its straight-on shadow on `left` / `right` | 36,619 / 36,730mm² (both casters per side)             |
| what the bake now marks dead there         | 12,891 / 14,489mm² (the rest is the 20mm bleed margin) |
| a 30mm tire ring would add                 | 22,447 / 23,215mm² of zone surface                     |

The 30mm is scaled off the photo, not measured: the hub reads ~340px across for a known 280mm, and
the yellow band ~37px. Treat it as "about as much again as the stub covers", not as a figure to
build on.

Leaving it out errs safe — surface under the tire is treated as printable, so it costs a filament
change on plastic nobody sees, and never leaves blank plastic showing. Nothing here is blocked on
it. The call is whether re-exporting the reference with tires is worth that filament, and that is
yours; I have not added coverage for them.
