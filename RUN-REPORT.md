# Run report — fix pass, 2026-08-08

Worktree `mosaic-agent-run`, base commit `c2d7767`. Nine branches, each off the base, each meant to
be cherry-picked rather than merged as a set. Nothing was pushed and nothing merged.

Environment for every driven number below: production build (`npm run build`) served by `vite
preview`, `MOSAIC_GPU=1`, renderer
`ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060), OpenGL ES 3.1)` — hardware, never
SwiftShader. Machine: Intel i7-10700 (8C/16T, 2.9 GHz), 15 GB, WSL2 kernel 6.18.33.2, Node 24.18.0.

---

## What shipped, and where

| Item                             | Branch                           | Commits |
| -------------------------------- | -------------------------------- | ------- |
| 1 Zone-pick occlusion + check    | `fix/zone-pick-occlusion`        | 2       |
| 2 Remove the mesh-swap path      | `fix/no-mesh-swap-on-autoload`   | 1       |
| 3 Selection off the accent hue   | `fix/selection-not-accent-hue`   | 1       |
| 4 Part thumbnail from the mesh   | `fix/part-thumbnail-from-mesh`   | 1       |
| 5 Fill-refusal warning per cause | `fix/tile-warning-per-cause`     | 2       |
| 6 `FOOTREST_OBJECT_SETTINGS`     | `chore/footrest-object-settings` | 1       |
| 7 Help dialog on Back            | `fix/help-dialog-back-nav`       | 1       |
| 8–10 Three reports               | `docs/run-findings`              | 1       |
| Spike (never merge)              | `spike/zone-first-selection`     | 1       |

All five gates (`lint`, `format:check`, `typecheck`, `test:coverage`, `smoke`) were run on each code
branch before its commit, and again after each review round.

`/code-review high` is mandatory for anything under `src/geometry/` or `src/export/`, and was
additionally asked for on item 1. That is items 1 (`src/scene/`, asked for), 5 (`src/geometry/`) and
6 (`src/export/`). **I nearly missed item 6** — I had written a sentence into this report explaining
that it was "covered by" item 5's review, which it was not. Running it instead of explaining it away
found a real thing: a third copy of the footrest's `objectSettings` literal in `docs/pipeline.md`,
carrying a value the code does not have. Commit `2fa2536`.

Each reviewed item then took **two** rounds, never three — items 1 and 5 both found real defects in
round 1, fixed them, and stopped. Items 2, 3, 4 and 7 touch neither directory and had no mandatory
review; they were checked by the two fresh reviewers below instead.

Test count went from 989 on the base to 997 (item 1), plus 3 (item 2), 6 (item 7) and 7 (item 5) on
their own branches. No existing assertion was modified anywhere; where one constrained a rewrite
(item 5's `/more than \d+ tiles/`) the new wording was chosen to keep it true rather than the
assertion changed to fit.

## What I measured

**Zone-pick occlusion (item 1).** Chair, four genuinely distinct viewpoints, 1748-sample grid each.

|                     | before | after |
| ------------------- | -----: | ----: |
| through-picks       | **33** | **0** |
| missed-picks        |      0 |     0 |
| named cases passing |  0 / 2 | 2 / 2 |

A "through-pick" is a sample on bare body — no design surface visible at all — that still selected
one. Per angle before: 3 / 13 / 1 / 16.

**Zone-pick cost of the fix.** Chair (368,330 tris), 400 random points: median 0.30 ms unchanged,
p95 0.80 → 5.5 ms, worst 1.3 → 9.5 ms. Inside one 60 fps frame, which is why it stayed a plain
raycast instead of acquiring a BVH.

**Rebuild cost, one zone against five** (`docs/findings/zone-rebuild-cost.md`). All five at once:
4.0 s at 100% scale, 17.0 s at 400%. Five separate one-zone rebuilds: 8.3 s and 22.1 s. **All-at-once
is cheaper**; what zone-first buys is no single wait over 5.3 s against 17.0 s.

**Checker audit** (`docs/findings/indirect-success-signals.md`). Two confirmed by driving: smoke's
`#btn-export`-enabled wait returns 36 ms into a 480 ms rebuild (8% of the work it names), and
`settledAfterRebuild()` reports success after 30,009 ms when no rebuild was ever scheduled.

**Seam sliver** (`docs/findings/seam-sliver-sighting.md`). 22 configurations, up to 2.4M triangles
of cut chair, four rotations — **no sighting**, with the detector proven live against `?csgfault`
first.

## What I was wrong about

This is the part worth reading.

**1. I built a check that agreed with the bug, and only noticed because I stopped to write down
why it couldn't.** My first design for the occlusion check answered "which zone is visible here?"
by raycasting the chart meshes — which is what `zonePick.ts` does, so it would have agreed with the
broken code including about the bug, and reported green. The tech-debt entry about checkers
under-verifying is what caught it, before any code was written. The oracle became the rendered
picture instead. I then wrote a second version of the same mistake into the coverage check: "the
ink stopped growing when I scaled up" is indistinguishable from "nothing I did reached the app", so
that now runs three scales and fails if the smallest doesn't ink visibly less.

**2. My four camera angles were three.** `/code-review` found that the angle list read as four
poses from the default but composed, so `+260` and `−260` cancelled: two of them were the same
azimuth and the right rear was never looked at, while the log said four viewpoints. The frame-hash
guard I had written specifically to catch a silent no-op could not catch it — the view _did_
change, just not to the place the name promised. I had verified the mechanism and not the
destination.

**3. I claimed depth shading brought back the hub boss and the mounting clips. It doesn't.** I
wrote that comment before looking at the rendered thumbnails. The wheel and the hubcap are both
discs seen nearly face-on; their depth range is dominated by the view's own tilt, and a few
millimetres of clip against a 220–280 mm diameter is under a pixel of gradient. The comment is
corrected and the residual is its own tech-debt section. Left as it was, it would have been a false
claim in a code comment, which is worse than the missing feature.

**4. I misread the cost of the zone-first spike before measuring it.** I expected per-zone rebuilds
to be cheaper because each does less. They are about **twice** the total, because the
whole-assembly work is per rebuild rather than per zone. The argument for zone-first is the shape of
the wait, not its size — the opposite of what I would have written from intuition, and the opposite
of what someone will claim for it.

**5. I under-specified the fill-refusal doc and had to be caught.** I wrote that "no repeat size"
means a zero-size viewBox. It cannot: `tileCellOf` falls back to the artwork's bounding box
whenever the viewBox isn't positive both ways. So in the one branch of five whose stated cause was
wrong — inside the change whose entire purpose is not naming the wrong cause — I named the wrong
cause. Round 2 fixed the message and the doc.

**6. The seam-sliver hunt's first pass proved nothing and I nearly reported it.** Pass 1 recorded
only the warning count, which cannot fail if nothing is being built. Pass 2 records triangle counts
per configuration and pass 3 forces a real warning to prove the detector is live. The first pass is
exactly the shape of the thing I was auditing in the other report, written by me, on the same day.

**7. I assumed a 30-second step was a slow rebuild.** Twice, while writing the occlusion check,
before working out it was `settledAfterRebuild()` absorbing a timeout for an action that scheduled
nothing. That became finding 2 of the audit.

## Judgment calls, and where each one is recorded

Every open question went to `docs/tech-debt.md` or a findings report rather than to
`DECISIONS-NEEDED.md`, which is why **that file does not exist on any branch** — the CLAUDE.md
lifecycle wants it drained to empty before merge, and promoting a finding to tech-debt is one of
the three outcomes it allows. Nothing was skipped as undecidable.

- **The selection frame's off-surface amber was left alone.** It is a warning, not a selection, and
  the existing comment defends the colour choice against the obvious alternative. Recorded, with the
  convention-21 problem it still has, in the tech-debt section item 3 rewrote.
- **Three panel-side selection tints still use the accent** (`.artwork-row.active`,
  `.base-swatch.selected`, `.auto-merge-labels span.active`). The swatch is the sharp one: a blue
  ring around a blue filament. Not in scope for item 3, which was the viewport; kept as the surviving
  half of that tech-debt section rather than deleted with it.
- **The wheel and the hubcap still share a thumbnail.** Own section, with the measurement and what
  separating them would take.
- **The occlusion fix introduced a 3 px dead line down part seams.** Correct behaviour — the ray
  really does slip through the 0.53 mm clearance between two charts — but a residual, so it has its
  own section with the measured width and a bound the check enforces.
- **`npm run check:zone-occlusion` is not in CI** and the docs now say so plainly rather than
  calling it "what keeps this closed". It needs a browser and ~12 minutes.

## Docs touched, and the ones deliberately not

CHANGELOG on six branches (item 6 is an internal refactor with no behaviour change, so none).
`docs/tech-debt.md` sections deleted on items 1, 5, 6, 7 and rewritten on item 3 — each after
checking what the section still owed and moving that out first. `docs/roadmap.md`: the surface-first
dependency updated (item 1) and the per-kind-icons bullet removed as shipped (item 4).
`docs/troubleshooting.md` gained a section for the four fill refusals.

**In-app help: judged unchanged for all seven, and here is why for the two that could have needed
it.** Item 1's help text already says clicking a surface binds the design to it; the fix makes the
app match what the help already claimed, so the drift closed rather than opened. Item 2 removed a
control, but the help dialog never documented it (the only dropzone it describes is the flat-mode
STL reference, a different control).

**Analytics: no catalog change on any item.** Checked rather than assumed — the removed part
dropzone (item 2) fires no `track()` call, so nothing in `docs/analytics.md` was orphaned, and no
item added a control.

## Left behind for the next cycle

- The audit's structural finding: there is no way for a driven check to say "wait for the thing I
  just caused, and fail if I caused nothing." Four of its ten findings are that one gap. The app
  already counts its own work in `whenIdle`; exposing the count would close all four and is smaller
  than any individual fix on the page.
- The seam sliver needs constructing, not sweeping — a shape placed deliberately across one named
  seam so its footprint on the far part is a sliver and nothing else.
- The zone-first spike's item 3: retiring the placement globals. Everything else in that feature is
  small and safe; that one is large, and it fails quietly.
