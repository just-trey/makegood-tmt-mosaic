---
name: ship-it
description: 'Pre-PR gate for this repo: checks DECISIONS-NEEDED.md is drained, runs the eight CI gates locally, then checks the four docs that drift silently (CHANGELOG, README, in-app help panel, analytics catalog) against the actual diff, checks any new user-facing string against the plain-language conventions, and watches CI without polling. Use before opening or updating a PR, or when asked "is this ready to push / ready for a PR".'
model: sonnet
---

# Ship it

The eight gates below are exactly what `.github/workflows/ci.yml` runs, and `main`
is protected, so a red gate blocks merge. Running them locally is cheaper than a
round trip through GitHub.

## 0. Any open decisions first

```bash
test -s DECISIONS-NEEDED.md && { echo "DECISIONS-NEEDED.md has open entries, not done yet."; cat DECISIONS-NEEDED.md; }
```

**If that prints anything, stop.** CLAUDE.md: "an unresolved entry is a blocker,
not a footnote." Writing the entry down is step one. It still owes one of three
outcomes: resolved into a code comment, promoted to `tech-debt.md` or
`roadmap.md`, or genuinely still open, in which case say so rather than
continuing. Don't run the rest of this skill, and don't open or update the PR,
until the file is gone.

The check is mechanical on purpose: "I wrote the entry" and "the branch is
done" are different claims.

## 1. Run the gates

Run these together, in the background, and wait for the notification:

```bash
npm run lint && npm run format:check && npm run check:copy && npm run check:troubleshooting && npm run check:comments && npm run typecheck && npm run test:coverage && npm run smoke
```

`smoke` builds first, so expect minutes. Don't poll; the harness re-invokes you
when it exits.

The test gate is `test:coverage`, not `npm test`, because that is what CI runs:
the same suite plus the per-directory coverage floors in
[vite.config.ts](../../../vite.config.ts). A breach reads:

```
ERROR: Coverage for statements (n%) does not meet "src/geometry/**" threshold (m%)
```

**That is a coverage floor, not a broken or flaky test.** Don't hunt for a
failing assertion. Floors are per-directory aggregates, so read the coverage
table to find which file lost ground. The fix is a test, not a lower number:
floors sit _under_ what the code already achieves, so tripping one means
coverage went backwards in this diff.

**Never fix a `format:check` failure with `npm run format`.** That rewrites line
endings across ~90 files on Windows and buries the real diff. Format only what
you touched:

```bash
npx prettier --write <the files you edited>
```

The husky and lint-staged pre-commit hook already formats staged files, so this
is usually a no-op.

## 2. Check the four silent-drift docs against the diff

Get the diff first (`git diff main...HEAD --stat`), then walk these. Each is
conditional: decide from the changed paths, and say which ones you judged
not-applicable and why.

| Trigger in the diff                                                  | What to update                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any user-visible change                                              | A bullet under `## [Unreleased]` in [CHANGELOG.md](../../../CHANGELOG.md), Keep a Changelog category (Added/Changed/Fixed/Removed). Skip for internal refactors, tests, CI/tooling with no behavior change.                                                     |
| A pipeline step or a Known Limitations bullet changed                | [README.md](../../../README.md)'s `## How it works` / `## Known limitations`, and [docs/pipeline.md](../../../docs/pipeline.md) for the full walkthrough.                                                                                                       |
| A roadmap item shipped or a new one was deferred                     | [docs/roadmap.md](../../../docs/roadmap.md). A **shipped** item moves out of the roadmap and becomes a real feature description; leaving it listed as unbuilt is the failure mode here.                                                                         |
| Deferred work, a new measured limitation, or a tech-debt item closed | [docs/tech-debt.md](../../../docs/tech-debt.md): one `##` section per item.                                                                                                                                                                                     |
| A left-panel control added/removed/renamed, or what it does changed  | The `#help-dialog` block in [index.html](../../../index.html). Its sections mirror `#left` 1:1 and the copy is static, so nothing catches this drift but you.                                                                                                   |
| A left-panel control or other primary user action added/changed      | Its `track()` event plus the catalog in [docs/analytics.md](../../../docs/analytics.md). Follow that doc's `## Adding a new event` section and its `## Rules`: no PII, `snake_case`, fire on real user intent (not on page load or programmatic state changes). |

## 2b. Check any new user-facing string against plain language

Only if the diff adds or changes a **user-facing string**: help dialog, panel
copy, a label, a warning, a notice, an error. Otherwise skip, and say so.

**The test for every word**: would it appear in Bambu Studio's or Orca's UI, or
in a Printables comment thread? If yes it is free, leave it. If no it is ours,
replace it. This is not a reading-age check: the reader runs a slicer daily, and
writing down to them fails just as hard as jargon does.

For each changed string, check conventions 33–37 of
[docs/ui-conventions.md](../../../docs/ui-conventions.md):

- **33** — their words, real numbers. Every number that was there is still
  there, and no word is one only a CAD user would have.
- **34** — it names what is on screen (a part, a color, a recess, a file), not
  the step inside (a solid, a boolean, a build stage).
- **35** — it does not stop to explain a word they already own, and any
  unavoidable term of ours is defined at first use in a few plain words.
- **36** — the rewrite is not longer than what it replaced. If it is, cut the
  explanation rather than padding the word. Check by counting.
- **37** — a diagnostic the user cannot act on is behind a disclosure that says
  so, and is exempt from 33.

The jargon table in that section is the reference for substitutions. If a string
needs a term that isn't in it, add the row, and make the replacement obey 36
first.

**This is a copy check, not a rewrite pass.** It gates what the diff introduces.
Existing copy that already fails is a tracked tech-debt item; widening the diff
to fix it is how a focused PR stops being one.

## 2c. A bug fix, guard, clear, or check ships with a test seen to fail

Only if the diff fixes a bug **or adds a guard, a clear, a check, or a warning**
(a clamp, a `return` on bad input, a `clearWarnings` site, a cancel check, a
validation). Skip it for a pure feature, refactor, or docs change, and say so.

> Every bug fix ships with a test proven to fail pre-fix. Write the test first,
> run it against the old code, and confirm it fails. Only then apply the fix. A
> test that was never shown to fail proves nothing.

**"Proven" means you read the failure output.** A test written after the fix
passes on the first run whether or not it touches the bug.

For a bug fix: write the test against the bug as reported, run it on the unfixed
code and keep the failure message, apply the fix, run it again.

**For a new guard there is no "unfixed code", so the proof is the mutation
run**: stash or comment out the guard, run its test, read the failure, restore
the guard, run it again. A guard whose test stays green with the guard removed
has no test. This cost rounds on three PRs in one week:

- #229: three tests passed with the feature stubbed out, one asserted about a
  confirm it could not fire, and only mutation runs showed it.
- #230: the same wrong-axis bug survived three rounds because each fixture
  used a sign the guard happened to handle (`topZ: -90`, twice), and the first
  test's `< 20` was satisfied by the degenerate 0.2mm it sat next to.
- #231: two assertions matched strings no source emitted, so removing the
  `needsTower` guard failed nothing.

Say the failure you saw, as expected against actual: the wrong number it
returned, not "it failed". For a mutation run, say what you removed and what the
test then reported.

If the bug cannot be reached from a test (a WebGL path, a real printer), name
the driven check or live run that stands in for it, with the same evidence:
what it reported before and after. #243's smoke assertion is the worked
example: stashing each of the two source files failed a different check.

## 3. Code review

```bash
{ git diff main...HEAD --name-only
  git diff HEAD --name-only
  git ls-files --others --exclude-standard; } | sort -u
```

All three lines are needed. `git diff main...HEAD` alone is **empty while the
work is uncommitted**, most of the time this skill runs, and an empty list reads
as "purely prose" and skips the gate (a 1300-line diff nearly shipped unreviewed
that way). The second line catches staged and unstaged edits, the third new
files never added.

**If any changed path is executable, run `/code-review`.** Source, tests,
scripts, config, build files. The only exemption is a purely prose diff: docs,
CHANGELOG, comments.

This is not scoped to `src/geometry/` and `src/export/`: that scope let a
700-line bench through unreviewed, and the review that eventually ran found
three claims in its findings report read off rows the shipping code never uses.

### Run it twice, at least

Once **before pushing**, and again **after you act on its findings**.

- A fix to a finding is itself a change, written under pressure to make one
  complaint go away. That is when a too-narrow patch gets bolted on.
- PR #113: three rounds in a row, each found a real bug introduced by the
  previous round's fix. Round 2 found it in code a live run had already
  reported clean.
- Reviewing only after the push means announcing green, then withdrawing it.

### Stop on the kind of finding, not on the count

Keep going while rounds return wrong output. Stop when a round returns taste.

A reviewer will always return something, so "it found a real thing" is not the
test. What matters is _which kind_:

- **Wrong output**: a bad number, a wrong pose, a warning that never fires, a
  claim the measurement does not support. Fix it. The next round is earned.
- **Arguable defaults**: a margin, a fallback, one of two defensible
  behaviors. That is taste. Another round produces more of it, forever.

There is no round cap. A fourth round that keeps surfacing wrong numbers is
worth running; a second that returns only judgment calls is where to stop.

PR #147 is the worked example of stopping:

- Round 1 found four real defects. Round 2 found a genuine latent bug.
- Round 3 returned four more: one introduced by round 2's own fix, two judgment
  calls, and a fix that invented a constant to satisfy a reviewer rather than a
  measurement. That is where the churn started.
- It landed on `suggestTowerPos`, a _suggestion_ that already warns when unsure.
  The numbers that decide whether a print succeeds (the verified plate
  constants) had been stable and live-verified since they landed.

Six guards that matter more than the count:

- **Findings anchor in the diff.** A finding lands on the changed lines or
  their direct blast radius. A pre-existing issue becomes a
  `docs/tech-debt.md` item, never review commentary.
- **A settled finding stays settled.** One judged fixed or no-change-needed
  in an earlier round is never re-raised.
- **Never invent a constant to satisfy a reviewer.** A number that closes a
  finding without a measurement behind it is worse than the finding.
- **If rounds keep finding real defects, suspect the diff.** A change that
  needs four rounds is usually too big rather than unsound. Split it instead of
  another pass.
- **A defect in the previous round's fix, in the same area, twice: cut the
  area.** Revert it to what shipped, write the open threads into
  `docs/tech-debt.md` with what each round found, and let the rest ship. #241
  is the worked example: three rounds each found a defect in the
  markup-splitting regex, and the area went rather than a fourth patch. #230 is
  the counter-example: the same wrong-axis bug survived three rounds because
  each fix got a third patch instead.
- **Prose has no stop signal, so it gets one pass, at the end.** Code rounds
  review the code diff; a finding on a comment, a CHANGELOG bullet, a
  tech-debt section, a troubleshooting entry, or the PR body is applied
  without re-entering review. After the last clean code round, one
  `/code-review low` pass over the prose, applied, then ship. #270 ran ten
  rounds and rounds 2-10 were all prose, with the code correct after round
  1; #269 repeated it in rounds 7-8; #264 took 15 rounds on 3 prose files.
  "There is no round cap" still holds — what changed is what counts as a round.

Say which round you stopped at and why, in terms of what the last round
returned.

## 4. Push, then watch CI in one blocking call

Branch off `main` if you aren't already on a branch. `main` rejects direct
pushes, force-pushes and branch deletion, and the pre-commit hook enforces it,
so you hit that at the first commit.

After pushing, watch CI with a **single background** call:

```bash
n=0
until [ "$(gh pr checks --json name --jq length 2>/dev/null || echo 0)" -gt 0 ]; do
  n=$((n + 1))
  [ $n -ge 30 ] && { echo "no checks registered after 150s: NOT green, investigate"; exit 1; }
  sleep 5
done
gh pr checks --watch --fail-fast
```

**Bare `gh pr checks --watch` is not safe directly after `gh pr create`.**
GitHub takes a few seconds to register check runs for a new PR. Until it does,
`gh` prints "no checks reported on the branch" and **exits 0**, so a PR whose CI
had not started reads as passing (#124). The `until` loop waits for at least one
check to exist, and hard-fails if none appear.

The loop runs inside one shell call: one model turn, not one per iteration.
**Do not loop `gh pr checks` or `gh run list` from the model side.** Each poll
re-sends the whole conversation, so N polls cost N× the context; one blocking
watch costs 1×, flat.

Read the actual result text before calling it green. "No checks reported", a
zero-duration pass, and an empty check list are all failures to verify.

CI runs the same eight gates as step 1, so if those passed locally this step is
confirmation, not discovery. Worth it on release tags and on changes that could
behave differently in CI's environment; optional otherwise. Say which case you
think it is.

## Scope

One focused change per branch and PR. If the work splits cleanly into
independent changes, prefer separate PRs; bundle only what is genuinely coupled.
