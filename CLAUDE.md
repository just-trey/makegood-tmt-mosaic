# Working in this repo

## Skills

The project skills in `.claude/skills/` carry the recurring workflows in
full — read the skill rather than reconstructing the steps:

- `ship-it` — the pre-PR gate (the five checks + the four docs that drift)
- `run-app` — launching it for manual or headless verification
- `add-part` — adding a MakeGood TMT part as an assembly kind
- `bake-zones` — baking the design zones of a multi-surface part
- `verify-new-bed-size` — checking export placement on an unverified bed
- `debug-csg-failure` — investigating an assembly-mode CSG warning
- `release` — cutting and tagging a release

## Before opening a PR

Run the `ship-it` skill — it has the five CI gates (which also block merge
into `main`) and the four docs that drift silently. `/code-review` is
required, not optional, when the diff touches `src/geometry/` or
`src/export/`.

Run it **before pushing**, and **again after acting on its findings**. Fixes
to geometry findings are themselves geometry changes, and they are written
under pressure to make a specific complaint go away — which is exactly when a
too-narrow patch gets bolted on. On PR #113 three consecutive rounds each
found a real bug introduced by the previous round's fix; the second was caught
on code a live run had already reported clean. Reviewing after the push means
announcing green and then withdrawing it.

**That is two passes, not a loop.** A third round is a signal to stop and
reassess, not to keep going. A reviewer looking hard at a large diff will
always return something, so "it found a real thing" stops being a reason to
continue — what matters is _what kind_ of thing. Ask where the findings are
landing:

- **Wrong output** — a bad number, a wrong pose, a warning that doesn't fire.
  Fix it, and the re-review is earned.
- **Arguable defaults** — a margin, a fallback, which of two defensible
  behaviors to pick. That is taste, and another round will generate more of
  it indefinitely.

PR #147 is the worked example. Round 1 found four real defects in the original
code and round 2 a genuine latent bug. Round 3 then returned four more, but one
was introduced by round 2's own fix, two were judgment calls, and the fix
invented a constant to satisfy a reviewer rather than a measurement. All three
rounds were "real findings"; only the first two were worth the churn. Note
where the churn concentrated: `suggestTowerPos`, a _suggestion_ that already
warns whenever it is unsure, while the numbers that decide whether a print
succeeds — the verified plate constants — had been stable and live-verified
since the commit that introduced them.

If a third round still looks necessary, that is usually the diff being too big
rather than the code being unsound. Split it, or take the remaining concern to
its own PR against real evidence — a live run, a real print — instead of
another review pass.

## Git workflow

- `main` is protected: PRs required, the CI check must pass, no direct
  pushes, no force-push or branch deletion.
- Branch off `main`, keep one focused change per branch/PR.
- Versioning is semver, currently pre-1.0 (`0.x.y`) — see
  [CONTRIBUTING.md](CONTRIBUTING.md#versioning) before deciding whether a
  change is PATCH/MINOR/MAJOR-equivalent.

## Code conventions

- TypeScript `strict` is on (see [tsconfig.json](tsconfig.json)); don't
  weaken it to make something compile.
- Default to no comments. Only add one for a non-obvious _why_ — a hidden
  constraint, a workaround for a specific bug, behavior that would surprise
  a reader. [src/turf.d.ts](src/turf.d.ts) and the retry logic in
  [src/geometry/regions.ts](src/geometry/regions.ts) are examples of
  comments that earn their keep.
- **Before changing what a shared value means** (`colorSettings`, a depth, a
  placement), open every reader of it, not just the one you're editing.
  Changing it at one call site and reasoning only about that site is what
  produced all three rounds of findings on PR #113 — a typed `0` made
  meaningful in `src/ui/colorList.ts` was still read as "unset" in
  `src/geometry/assembly.ts`, and a depth clamped there was then discarded by
  the `resolveCutDepth` it was handed to.
- **A tolerance is not a user-facing value.** `0.02mm` keeps a boolean
  well-defined; offered to someone as the depth their recess was cut at, it
  names something that slices to nothing and still costs an AMS slot. If a
  number will be shown to a user or given to them as a fallback, it has to be
  a number that makes sense on a printer.
- Needing a special case that reaches across a boundary — `if (part.cutThrough)`
  in code that shouldn't know how parts cut — means the model is wrong further
  up. Deleting one such special case closed three review findings at once.

## Audience

Built for hobbyist printer owners and MakeGood volunteers, not CAD users —
they know their slicer, not Fusion or mesh editing. A feature or fix that
requires CAD literacy to use is a bug in the tool. The success measure: a
first-time volunteer reaches a printable, correctly-colored 3MF without
touching a 3D modeling tool. Prefer the simpler workflow when two options
both work. Full framing, including how this compares to MakerWorld Mesh
Graffiti: [docs/audience.md](docs/audience.md).

## Docs

Where writing goes — pick one, don't split a topic across two:

- **README** — orientation only: what it is, how to run it, how it works at a
  level someone can hold in their head, what it can't do. Keep it under ~200
  lines; if a section outgrows that, it belongs in `docs/`.
- **[docs/audience.md](docs/audience.md)** — who this is built for and the
  success measure; read this before filing or acting on UX/workflow findings.
- **[docs/pipeline.md](docs/pipeline.md)** — how the geometry actually works;
  read this before touching `src/geometry/` or `src/export/`.
- **[docs/ui-conventions.md](docs/ui-conventions.md)** — the numbered behavior
  rubric for anything user-facing. Findings against it cite convention numbers,
  not prose. It **verifies** a specific change against a fixed bar; it does not
  discover problems nobody knew about — that is `maker-workflow-review` and the
  `review-gauntlet` lenses, which it does not replace. Recurring review findings
  graduate into conventions; the conventions then stop them recurring. Behavior
  only — `design-system/` owns the visual language.
- **`design-system/`** — color, type, spacing, radius, states, and the component
  specs. Authoritative on _look_; silent on _model_.
- **[docs/system-audit.md](docs/system-audit.md)** — generated, not authored. The
  `system` lens of `/review-gauntlet` overwrites it every run and its header pins
  the commit, viewport and drive script behind it. Don't hand-edit it, and don't
  cite it for a measurement it doesn't contain — a manually added claim is
  indistinguishable from a measured one, which is the failure the file exists to
  prevent. To change what it says, run the lens.
- **[docs/analytics.md](docs/analytics.md)** — the event catalog; one of the four
  docs `ship-it` checks for drift.
- **[docs/tech-debt.md](docs/tech-debt.md)** — **open** deferred work and
  known-wrong behavior. One `##` section per item, stating what was measured,
  why it was deferred, and what closing it would take. This is where the
  "write deferred work down, don't just remember it" rule points.

  **When the work lands, delete the section.** Don't mark it `FIXED` and leave
  it — a list that only ever grows stops being a work list, and this one had
  reached 1100 lines. The record of the fix is the CHANGELOG entry and the
  commit; anything a future reader still needs — the measurement that picked a
  constant, the approach that was tried and lost — goes in a comment next to
  the code it constrains, where someone changing that line will actually hit
  it. `CREASE_ANGLE_RAD` in [src/app/rebuild.ts](src/app/rebuild.ts) is the
  worked example: it carries the numbers that chose it over the alternative,
  and its tech-debt section is gone.

  **Before deleting, read what the section still owes and move that out first.**
  A section can be almost entirely closed and still carry the one thread that
  isn't — a follow-up, an unclaimed optimization, a caveat nobody has measured.
  That survives as its own section; only the closed part goes. This rule's first
  use got it wrong: #140 deleted the flat-shading section along with the "index
  the display meshes" follow-up it carried, and a review had to put it back.

  Only keep a closed item here when it is still load-bearing for something
  open — an entry in a list whose own conclusion is that an audit is owed, say.

- **`docs/findings/`** — one dated report per driven investigation: what was
  measured or hunted, on which commit and machine, and what came back —
  including the null results, which are the ones nobody else can reconstruct.
  A report is pinned to its run and never edited to stay current; when it
  changes what an open item claims, the pointer goes _from_ that item in
  `tech-debt.md` _to_ the report, and the item stays the thing you read first.
  `tech-debt.md` says what is owed; a finding says what was seen.

- **DECISIONS-NEEDED.md** — a per-run inbox, never a document. An agent that
  hits something it cannot decide appends an entry with enough context to
  answer in one line, skips the item, and continues rather than blocking.

  Before the branch merges the file drains to empty and is deleted. Every
  entry ends up in one of three places:

  - **Resolved** — the answer becomes a comment next to the code it
    constrains, where someone changing that line will actually see it.
  - **Promoted** — it was a finding, not a decision. It goes to
    `tech-debt.md` or `roadmap.md`.
  - **Still open** — then the branch is not done. An unresolved entry is a
    blocker, not a footnote.

  A finding is promoted; a decision — something only a human can settle, where
  the agent has no basis to pick — stays in the file. If the file drains to
  empty because everything was promoted, check that nothing needing a human
  went with it.

  A file called "decisions needed" surviving on `main` means the decisions
  weren't needed.

- **[docs/troubleshooting.md](docs/troubleshooting.md)** — one section per
  user-visible warning string.
- **[docs/roadmap.md](docs/roadmap.md)** — ideas not yet built.
- **CHANGELOG.md** — what changed per release, nothing else.

**Before touching boolean/polygon code**: `@turf/turf` is pinned to `6.5.0`
deliberately — read [docs/tech-debt.md](docs/tech-debt.md) first, it explains
why and what upgrading requires.

## Planning

Every plan names the model for each work item, so the choice is made once at
planning time instead of re-litigated per session:

- **Opus** — `src/geometry/`, `src/export/`, placement/scene math, anything
  where a wrong number ships a bad print.
- **Sonnet** — `src/ui/`, state plumbing, docs, config, test scaffolding.
- Split a PR across both when it has a geometry half and a UI half.

Verify by running the app, not only by running the tests.
