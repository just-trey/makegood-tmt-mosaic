# Rules for docs/

One rule set per destination. The destination table, DECISIONS-NEEDED.md, and
the writing style all stay in the root CLAUDE.md.

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

**And grep for what points at it.** The rule above covers what the section
still owes; it does not cover what points at the section from outside.
Before deleting, grep `docs/tech-debt.md` for `(above)`, `(below)`, the
section's title words, and any count it contributed to a surviving section.
#268 deleted a closed section and orphaned an `(above)` in the surviving
quote-gate section, which also still cited four counts that PR had moved.

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
