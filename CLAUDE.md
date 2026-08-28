# Working in this repo

## Skills

Recurring workflows live in `.claude/skills/`. Read the skill instead of
rebuilding the steps from memory.

| Skill                 | Use it for                                        |
| --------------------- | ------------------------------------------------- |
| `ship-it`             | The pre-PR gate: six checks, four docs that drift |
| `run-app`             | Launching the app, by hand or headless            |
| `add-part`            | Adding a MakeGood TMT part as an assembly kind    |
| `bake-zones`          | Baking design zones on a multi-surface part       |
| `verify-new-bed-size` | Checking export placement on an unverified bed    |
| `debug-csg-failure`   | Investigating an assembly-mode CSG warning        |
| `release`             | Cutting and tagging a release                     |

## Before opening a PR

Run the `ship-it` skill. It carries the six CI gates (the same ones that
block merge into `main`) and the four docs that drift silently.

`/code-review` is **required**, not optional, on **every PR that changes code**.

The one exemption is a diff that is only prose: docs, CHANGELOG, comments. If
it changes a line anything executes, including scripts and config, it gets
reviewed.

It used to be scoped to `src/geometry/` and `src/export/`, on a token-cost
argument that no longer applies. That scoping had a real failure mode: a
700-line measurement bench sat outside it, and the review that eventually ran
found three claims in its report read off rows the shipping code never uses.
Wrong numbers do not respect directory boundaries.

### Run it twice, at least

Once **before pushing**, and again **after you act on its findings**.

- A fix to a finding is itself a change, written under pressure, to make one
  specific complaint go away.
- That is exactly when a too-narrow patch gets bolted on.
- PR #113: three rounds in a row, each found a real bug introduced by the
  previous round's fix. Round 2 found it in code a live run had already
  reported clean.
- Reviewing only after the push means announcing green, then withdrawing it.

### Stop on the kind of finding, not on the count

Keep going while rounds return wrong output. Stop when a round returns taste.

A reviewer looking hard at a big diff will always return something. So "it
found a real thing" is not the test. What matters is _which kind_ of thing:

- **Wrong output**: a bad number, a wrong pose, a warning that never fires, a
  claim the measurement does not support. Fix it. The next round is earned.
- **Arguable defaults**: a margin, a fallback, one of two defensible
  behaviors. That is taste. Another round produces more of it, forever.

There is no round cap. A fourth round that keeps surfacing wrong numbers is
worth running. A second round that returns only judgment calls is where to
stop.

PR #147 is the worked example of stopping:

- Round 1 found four real defects. Round 2 found a genuine latent bug.
- Round 3 returned four more. One was introduced by round 2's own fix, two
  were judgment calls, and the fix invented a constant to satisfy a reviewer
  rather than a measurement.
- All three rounds found "real things". Only the first two were worth acting
  on, and round 3 is where the churn started.
- The churn landed on `suggestTowerPos`, a _suggestion_ that already warns
  when unsure. The numbers that decide whether a print succeeds (the verified
  plate constants) had been stable and live-verified since they landed.

Three guards that matter more than the count:

- **Never invent a constant to satisfy a reviewer.** A number that closes a
  finding without a measurement behind it is worse than the finding.
- **If rounds keep finding real defects, suspect the diff.** A change that
  needs four rounds is usually too big rather than unsound. Splitting it is
  the fix, not another pass.
- **A defect in the previous round's fix, in the same area, twice: cut the
  area.** Revert it to what shipped, write the open threads into
  `docs/tech-debt.md` with what each round found, and let the rest of the
  change ship. #241 is the worked example: three rounds each found a defect
  in the markup-splitting regex, and the area went rather than a fourth
  patch. #230 is the counter-example: the same wrong-axis bug survived three
  rounds because each fix got a third patch instead.

## Git workflow

- `main` is protected: PRs required, CI must pass, no direct pushes, no
  force-push, no branch deletion.
- Branch off `main`. One focused change per branch and PR.
- Versioning is semver, currently pre-1.0 (`0.x.y`). Read
  [CONTRIBUTING.md](CONTRIBUTING.md#versioning) before calling a change
  PATCH, MINOR, or MAJOR.

## Code conventions

- TypeScript `strict` is on (see [tsconfig.json](tsconfig.json)). Don't
  weaken it to make something compile.
- Comments: see [Comments](#comments) below.
- UI copy follows [docs/ui-conventions.md](docs/ui-conventions.md)
  (vocabulary table, conventions 1-6, plain language 33-37) and the same
  sentence rules: short sentences, each doing one job. `npm run check:copy`
  gates the shape (sentence length, joins, splices, em dashes). Docs are not
  held to this: they are working notes, not copy anyone reads in the app.
- **Plain language is the bar for every user-facing string, and it is not a
  reading-age rule.** The reader runs a slicer daily. The line is their
  vocabulary against ours: if a word appears in Bambu Studio's UI or a
  Printables thread it is free (filament, layer height, prime tower, tileable),
  and if it is ours it goes (quantize, boolean, cut solid, viewBox).
  - Their words, real numbers. Never drop a measurement to sound friendlier.
  - Never explain a word they already own. That is where rambling starts.
  - Removing jargon must not make the sentence longer. If the plain version
    runs long, cut the explanation instead of padding the word.
  - The jargon table in conventions 33-37 carries the substitutions, and
    `ship-it` step 2b checks them.
- **Before changing what a shared value means** (`colorSettings`, a depth, a
  placement), open every reader of it, not just the one you are editing.
  - Changing it at one call site and reasoning only about that site caused
    all three rounds of findings on PR #113.
  - A typed `0` made meaningful in [src/ui/colorList.ts](src/ui/colorList.ts)
    was still read as "unset" in
    [src/geometry/assembly.ts](src/geometry/assembly.ts).
  - A depth clamped there was then discarded by the `resolveCutDepth` it was
    handed to.
- **A tolerance is not a user-facing value.** `0.02mm` keeps a boolean
  well-defined. Told to someone as the depth their recess was cut at, it
  names something that slices to nothing and still costs an AMS slot. Any
  number shown to a user, or handed to them as a fallback, has to make sense
  on a printer.
- **A special case that reaches across a boundary means the model is wrong
  further up.** Example: `if (part.cutThrough)` in code that should not know
  how parts cut. Deleting one such special case closed three review findings
  at once.

## Comments

- Comments explain **why**, never **what**. If the code says it, no comment.
- Default is zero comments. Each one must earn its place by recording a
  non-obvious decision, constraint, or gotcha. [src/turf.d.ts](src/turf.d.ts)
  and the retry logic in [src/geometry/regions.ts](src/geometry/regions.ts)
  are the worked examples.
- One line where possible. Docstrings may run 2-4 lines when they carry real
  constraints, never longer.
- Em dashes and long sentences are fine here. The bar applies to user-facing
  copy only, and `npm run check:copy` is what draws that line.
- Never write: banner or divider comments, changelog-style comments ("updated
  to handle X"), comments restating a type signature, comments narrating
  obvious control flow.
- Preserve existing comments that document intentional approximations, known
  limitations, or "this looks wrong but isn't" cases.

## When making changes

- Do not add comments or docs describing the change you just made. The git
  commit message is the changelog.

## Audience

Built for hobbyist printer owners and MakeGood volunteers, not CAD users.

- They know their slicer. They do not know Fusion or mesh editing.
- A feature or fix that needs CAD literacy to use is a bug in the tool.
- **Success measure**: a first-time volunteer reaches a printable,
  correctly-colored 3MF without touching a 3D modeling tool.
- When two options both work, ship the simpler workflow.
- Full framing, including the comparison to MakerWorld Mesh Graffiti:
  [docs/audience.md](docs/audience.md).

## Docs

Pick one destination per topic. Don't split a topic across two.

| Destination                                            | What it holds                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **README**                                             | Orientation only: what it is, how to run it, how it works, what it can't do. Under ~200 lines |
| **[docs/audience.md](docs/audience.md)**               | Who this is for, and the success measure                                                      |
| **[docs/pipeline.md](docs/pipeline.md)**               | How the geometry actually works                                                               |
| **[docs/ui-conventions.md](docs/ui-conventions.md)**   | Numbered behavior rubric for anything user-facing (rules below)                               |
| **`design-system/`**                                   | Color, type, spacing, radius, states, component specs                                         |
| **[docs/system-audit.md](docs/system-audit.md)**       | Generated by the `system` lens, never authored (rules below)                                  |
| **[docs/analytics.md](docs/analytics.md)**             | The event catalog                                                                             |
| **[docs/tech-debt.md](docs/tech-debt.md)**             | Open deferred work and known-wrong behavior (rules below)                                     |
| **`docs/findings/`**                                   | One dated report per driven investigation (rules below)                                       |
| **`docs/review-cycles/`**                              | One dated file per `/review-cycle` run (rules below)                                          |
| **`docs/spikes/`**                                     | One write-up per throwaway prototype (rules below)                                            |
| **DECISIONS-NEEDED.md**                                | Per-run inbox for things an agent can't decide (rules below)                                  |
| **[docs/troubleshooting.md](docs/troubleshooting.md)** | One section per user-visible warning string                                                   |
| **[docs/roadmap.md](docs/roadmap.md)**                 | Ideas not yet built                                                                           |
| **CHANGELOG.md**                                       | What changed per release, nothing else                                                        |

Read `docs/audience.md` before filing or acting on a UX or workflow finding.
Read `docs/pipeline.md` before touching `src/geometry/` or `src/export/`.

**Before touching boolean or polygon code**: `@turf/turf` is pinned to
`6.5.0` on purpose. Read [docs/tech-debt.md](docs/tech-debt.md) first. It
explains why, and what an upgrade would take.

### docs/ui-conventions.md

- Findings against it cite convention numbers, not prose.
- It **verifies** a change against a fixed bar. It does not discover problems
  nobody knew about.
- Discovery is `maker-workflow-review` and the `review-gauntlet` lenses. This
  file does not replace them.
- Recurring review findings graduate into conventions. The conventions then
  stop them recurring.
- Behavior only. `design-system/` owns the visual language, and is silent on
  the model.

### docs/system-audit.md

- The `system` lens of `/review-gauntlet` overwrites it every run.
- Its header pins the commit, viewport, and drive script behind it.
- Don't hand-edit it. To change what it says, run the lens.
- Don't cite it for a measurement it doesn't contain. A hand-added claim is
  indistinguishable from a measured one, which is the failure this file
  exists to prevent.

### docs/tech-debt.md

Holds **open** work only. One `##` section per item, stating what was
measured, why it was deferred, and what closing it would take. This is where
"write deferred work down, don't just remember it" points.

**When the work lands, delete the section.**

- Don't mark it `FIXED` and leave it. A list that only grows stops being a
  work list. This one had reached 1100 lines.
- The record of the fix is the CHANGELOG entry and the commit.
- Anything a future reader still needs (the measurement behind a constant,
  the approach that was tried and lost) goes in a comment next to the code it
  constrains, where someone changing that line will hit it.
- `CREASE_ANGLE_RAD` in [src/app/rebuild.ts](src/app/rebuild.ts) is the
  worked example. It carries the numbers that chose it over the alternative,
  and its tech-debt section is gone.

**Before deleting, move out what the section still owes.**

- A section can be almost entirely closed and still carry one open thread: a
  follow-up, an unclaimed optimization, an unmeasured caveat.
- That thread survives as its own section. Only the closed part goes.
- This rule's first use got it wrong. #140 deleted the flat-shading section
  along with the "index the display meshes" follow-up inside it, and a review
  had to put it back.

Keep a closed item only when it is still load-bearing for something open, for
example an entry in a list whose own conclusion is that an audit is owed.

### docs/findings/

One dated report per driven investigation, or per work run that measured its
way through several.

- Record what was measured or hunted, on which commit and machine, and what
  came back.
- Include the null results and the wrong turns. Nobody else can reconstruct
  those, and they are why a run report earns a place here. `main` keeps the
  conclusions in code and CHANGELOG. Only the report says which of them were
  nearly something else.
- A report is pinned to its run and never edited to stay current.
- When a report changes what an open item claims, the pointer goes _from_ the
  item in `tech-debt.md` _to_ the report. The item stays the thing you read
  first.
- `tech-debt.md` says what is owed. A finding says what was seen.

### docs/review-cycles/

One dated file per `/review-cycle` run, written by the skill, not by hand.

- Each pins the frozen build it judged and the slate of lenses it ran.
- The next cycle grades itself against the last one, so an old cycle is
  evidence of what was true then. Never edit one to stay current.
- Findings that survive adjudication leave for `tech-debt.md`, `roadmap.md`,
  or a convention. A cycle file records the review, not the work list.

### docs/spikes/

One write-up per throwaway prototype: what was built to answer a question,
what it answered, what it could not reach.

- The code is thrown away and the write-up is the deliverable.
- Nothing here describes shipped behavior, and nothing is built from it.
- A spike that finds a defect promotes it out to `tech-debt.md` or
  `roadmap.md`, where someone will meet it again. A write-up nobody re-reads
  is not a work list.

### DECISIONS-NEEDED.md

A per-run inbox, never a document.

- An agent that hits something it cannot decide appends an entry with enough
  context to answer in one line, skips the item, and continues. It does not
  block.
- Before the branch merges, the file drains to empty and is deleted.

Every entry ends in one of three places:

- **Resolved**: the answer becomes a comment next to the code it constrains,
  where someone changing that line will see it.
- **Promoted**: it was a finding, not a decision. It goes to `tech-debt.md`
  or `roadmap.md`.
- **Still open**: the branch is not done. An unresolved entry is a blocker,
  not a footnote.

A finding gets promoted. A decision stays: that is something only a human can
settle, where the agent has no basis to pick. If the file drains to empty
because everything was promoted, check that nothing needing a human went with
it.

A file called "decisions needed" surviving on `main` means the decisions
weren't needed.

### Writing style

Applies to every doc above, and to `docs/` generally.

- Docs are working notes for the owner and Claude. Optimize for scanning.
- First line states the result or decision. Detail follows, never leads.
- Bullets over paragraphs. One fact per bullet. Sentences under ~20 words.
- Em dashes are fine. These are working notes, not copy a user reads.
- Record findings, numbers, caveats, and decisions. Never narrate the
  reasoning journey, justify the doc's existence, or editorialize.
- Bold key terms only, never whole sentences.
- Tables for anything with more than two data points.

## Planning

Every plan names the model for each work item, so the choice is made once at
planning time instead of re-litigated every session.

| Model      | Owns                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| **Opus**   | `src/geometry/`, `src/export/`, placement and scene math, anything where a wrong number ships a bad print |
| **Sonnet** | `src/ui/`, state plumbing, docs, config, test scaffolding                                                 |

Split a PR across both when it has a geometry half and a UI half.

Verify by running the app, not only by running the tests.

## Code rules (check before finishing any change)

These are judgment rules a linter cannot catch. Verify each one
explicitly before you consider a change done. If a rule cannot apply
to this change, say so in your summary instead of skipping it
silently.

### 1. Never silently drop or skip user content

If a part, shape, color, or input is excluded from output for any
reason (empty result after a CSG op, mesh mismatch, failed
operation), surface a named warning that identifies what was dropped
and why. Silent exclusion is always a bug, even when the exclusion
itself is correct.

Before finishing, ask: does any code path in this change discard
something without telling the user? If yes, add the warning.

### 2. Route new cases through the existing shared pipeline

When adding a case (a new SVG element type, a new export path, a new
shape handler), it must go through the same traversal, transform,
and exclusion logic every existing case uses. Do not write a
parallel one-off query or shortcut: it will silently miss
transforms, defs/clipPath exclusions, or other rules the shared path
already handles.

Before finishing, ask: did I add any lookup or handler that bypasses
the shared pipeline? If yes, fold it in.

### 3. Failures degrade per-unit, not globally

If one color, part, or shape can fail destructively (crash, corrupt
output), catch it at that unit's boundary so the rest of the
operation completes and the failure is reported for that unit only.
A single bad input must never abort or corrupt the whole export.

### 4. No perf claims without a measurement

Do not propose an optimization or file a perf finding based on code
shape alone. Benchmark against real sample files first. Unmeasured
suspicions go in tech-debt.md marked "unmeasured", not in findings
or fixes.

---

Mechanical rules are enforced by lint/CI, not this file: the shape
of user-facing copy by `npm run check:copy`, unsafe `any` flow and
`parseInt` radix by ESLint, formatting by Prettier. Numeric input
guards are only partly covered, and `docs/tech-debt.md` says which
part. Workflow rules (test proven to fail pre-fix) live in the
review and ship skills. Do not duplicate them here.
