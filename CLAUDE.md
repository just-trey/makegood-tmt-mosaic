# Working in this repo

## Skills

Recurring workflows live in `.claude/skills/`. Read the skill instead of
rebuilding the steps from memory.

| Skill                 | Use it for                                          |
| --------------------- | --------------------------------------------------- |
| `ship-it`             | The pre-PR gate: seven checks, four docs that drift |
| `run-app`             | Launching the app, by hand or headless              |
| `add-part`            | Adding a MakeGood TMT part as an assembly kind      |
| `bake-zones`          | Baking design zones on a multi-surface part         |
| `verify-new-bed-size` | Checking export placement on an unverified bed      |
| `debug-csg-failure`   | Investigating an assembly-mode CSG warning          |
| `release`             | Cutting and tagging a release                       |
| `fix-campaign`        | Several tech-debt items at once, merged on green    |

## Before opening a PR

Run the `ship-it` skill. It carries the seven CI gates (the same ones that
block merge into `main`) and the four docs that drift silently.

`/code-review` is **required**, not optional, on **every PR that changes code**.

The one exemption is a diff that is only prose: docs, CHANGELOG, comments. If
it changes a line anything executes, including scripts and config, it gets
reviewed.

How many rounds to run, when to stop, and the six guards that matter more
than the count live in the `ship-it` skill, step 3. Load it before the first
round: the short version is run it before pushing and again after acting on
the findings, and stop when a round returns taste instead of wrong output.

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
| **[docs/ui-conventions.md](docs/ui-conventions.md)**   | Numbered behavior rubric for anything user-facing (rules in docs/CLAUDE.md)                   |
| **`design-system/`**                                   | Color, type, spacing, radius, states, component specs                                         |
| **[docs/system-audit.md](docs/system-audit.md)**       | Generated by the `system` lens, never authored (rules in docs/CLAUDE.md)                      |
| **[docs/analytics.md](docs/analytics.md)**             | The event catalog                                                                             |
| **[docs/tech-debt.md](docs/tech-debt.md)**             | Open deferred work and known-wrong behavior (rules in docs/CLAUDE.md)                         |
| **`docs/findings/`**                                   | One dated report per driven investigation (rules in docs/CLAUDE.md)                           |
| **`docs/review-cycles/`**                              | One dated file per `/review-cycle` run (rules in docs/CLAUDE.md)                              |
| **`docs/spikes/`**                                     | One write-up per throwaway prototype (rules in docs/CLAUDE.md)                                |
| **DECISIONS-NEEDED.md**                                | Per-run inbox for things an agent can't decide (rules below)                                  |
| **[docs/troubleshooting.md](docs/troubleshooting.md)** | One section per user-visible warning string                                                   |
| **[docs/roadmap.md](docs/roadmap.md)**                 | Ideas not yet built                                                                           |
| **CHANGELOG.md**                                       | What changed per release, nothing else                                                        |

Read `docs/audience.md` before filing or acting on a UX or workflow finding.
Read `docs/pipeline.md` before touching `src/geometry/` or `src/export/`.

**Before touching boolean or polygon code**: `@turf/turf` is pinned to
`6.5.0` on purpose. Read [docs/tech-debt.md](docs/tech-debt.md) first. It
explains why, and what an upgrade would take.

The rules for each destination under `docs/` load from
[docs/CLAUDE.md](docs/CLAUDE.md) whenever you work on a file there. Read it
before closing a tech-debt item or writing a findings report.

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

The plan also names the `/code-review` level per work item, chosen once the
same way. Calibration for this repo: round 1 at `high`, later code rounds at
`medium`, the single prose pass at `low`. After a taste-only round, offer to
skip further rounds.

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

### 4. No claims without a measurement

Do not propose an optimization or file a perf finding based on code
shape alone. Benchmark against real sample files first. Unmeasured
suspicions go in tech-debt.md marked "unmeasured", not in findings
or fixes.

The same bar applies to every number in a write-up, not only a perf
one. A count or figure in a PR body, a commit message, a tech-debt
section or a findings report names the command or script that
produced it, and re-running that command reproduces it. #240 cited
127, 267 and 220 prose strings in one document, and "26 problems
across 4 blocks" that was 26 across 10. #241 said 6 unguarded sites
where there were 2, 14 strings where there were 19, and 5 parseFloat
calls where there were 9. Each cost a full review round on counts
alone. A number nobody can re-derive reads exactly like a measured
one, which is the failure being prevented.

---

Mechanical rules are enforced by lint/CI, not this file: the shape
of user-facing copy by `npm run check:copy`, the troubleshooting quotes by
`npm run check:troubleshooting`, unsafe `any` flow and
`parseInt` radix by ESLint, formatting by Prettier. Numeric input
guards are only partly covered, and `docs/tech-debt.md` says which
part. Workflow rules (test proven to fail pre-fix) live in the
review and ship skills. Do not duplicate them here.
