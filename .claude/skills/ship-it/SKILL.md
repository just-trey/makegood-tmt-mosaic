---
name: ship-it
description: 'Pre-PR gate for this repo: checks DECISIONS-NEEDED.md is drained, runs the six CI gates locally, then checks the four docs that drift silently (CHANGELOG, README, in-app help panel, analytics catalog) against the actual diff, checks any new user-facing string against the plain-language conventions, and watches CI without polling. Use before opening or updating a PR, or when asked "is this ready to push / ready for a PR".'
model: sonnet
---

# Ship it

The six gates below are exactly what `.github/workflows/ci.yml` runs, and `main`
is protected, so a red gate blocks merge. Running them locally is cheaper than a
round trip through GitHub.

## 0. Any open decisions first

```bash
test -s DECISIONS-NEEDED.md && { echo "DECISIONS-NEEDED.md has open entries, not done yet."; cat DECISIONS-NEEDED.md; }
```

**If that prints anything, stop.** CLAUDE.md: "an unresolved entry is a blocker,
not a footnote." Writing the entry down is step one, not the whole job. It still
owes one of three outcomes: resolved into a code comment, promoted to
`tech-debt.md` or `roadmap.md`, or genuinely still open, in which case say so
rather than continuing. Don't run the rest of this skill, and don't open or
update the PR, until the file is gone.

The check is mechanical on purpose. It is easy to settle the one decision a task
named and move straight to shipping without noticing that "I wrote the entry"
and "the branch is done" are different claims.

## 1. Run the gates

Run these together, in the background, and wait for the notification:

```bash
npm run lint && npm run format:check && npm run check:copy && npm run typecheck && npm run test:coverage && npm run smoke
```

`smoke` builds first, so expect minutes, not seconds. Don't poll it; the harness
re-invokes you when it exits.

The test gate is `test:coverage`, not `npm test`, because that is what CI runs:
the same suite plus the per-directory coverage floors in
[vite.config.ts](../../../vite.config.ts). A breach reads:

```
ERROR: Coverage for statements (n%) does not meet "src/geometry/**" threshold (m%)
```

**That is a coverage floor, not a broken or flaky test.** Don't hunt for a
failing assertion. It names a glob because floors are per-directory aggregates,
so read the coverage table to find which file lost ground. The fix is a test,
not a lower number: floors sit _under_ what the code already achieves, so
tripping one means coverage went backwards in this diff.

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
conditional: decide from the actual changed paths, and say out loud which ones
you judged not-applicable and why.

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
copy, a label, a warning, a notice, an error. Skip it entirely otherwise, and
say you did.

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
  explanation rather than padding the word. Check this one by counting.
- **37** — a diagnostic the user cannot act on is behind a disclosure that says
  so, and is exempt from 33.

The jargon table in that section is the reference for the substitutions. If a
string needs a term that isn't in it, add the row, and make the replacement obey
36 before you do.

**This is a copy check, not a rewrite pass.** It gates what the diff introduces.
The existing copy that already fails is a tracked tech-debt item, and widening
the diff to fix it is how a focused PR stops being one.

## 2c. A bug fix, guard, clear, or check ships with a test seen to fail

Only if the diff fixes a bug **or adds a guard, a clear, a check, or a warning**
(a clamp, a `return` on bad input, a `clearWarnings` site, a cancel check, a
validation). Skip it for a pure feature, a refactor, or a docs change, and say
you did.

> Every bug fix ships with a test proven to fail pre-fix. Write the test first,
> run it against the old code, and confirm it fails. Only then apply the fix. A
> test that was never shown to fail proves nothing.

**"Proven" means you read the failure output**, not that a test exists and now
passes. A test written after the fix passes on the first run whether or not it
touches the bug, and there is no way to tell those apart afterwards.

The order that satisfies this for a bug fix:

1. Write the test against the bug as reported.
2. Run it on the unfixed code. Keep the failure message.
3. Apply the fix.
4. Run it again. It passes.

**For a new guard there is no "unfixed code", so the proof is the mutation
run**: stash or comment out the guard, run its test, read the failure, restore
the guard, run it again. A guard whose test stays green with the guard removed
has no test. This is the case the bug-fix wording used to miss, and it cost
rounds on three PRs in one week:

- #229: three tests passed with the feature stubbed out, one asserted about a
  confirm it could not fire, and only mutation runs showed it.
- #230: the same wrong-axis bug survived three rounds because each fixture
  used a sign the guard happened to handle (`topZ: -90`, twice), and the first
  test's `< 20` was satisfied by the degenerate 0.2mm it sat next to.
- #231: two assertions matched strings no source emitted, so removing the
  `needsTower` guard failed nothing.

Say the failure you saw, in terms of expected against actual. "It failed" is
not the claim; the wrong number it returned is. For a mutation run, say what
you removed and what the test then reported.

If the bug cannot be reached from a test (a WebGL path, a real printer), say so
and name the driven check or the live run that stands in for it. That is a
different claim, and it needs the same evidence: what it reported before, and
what it reports now. #243's smoke assertion is the worked example: stashing
each of the two source files failed a different check.

## 3. Code review

```bash
{ git diff main...HEAD --name-only
  git diff HEAD --name-only
  git ls-files --others --exclude-standard; } | sort -u
```

All three lines are needed. `git diff main...HEAD` alone is **empty while the
work is still uncommitted**, which is most of the time this skill runs, and an
empty list reads as "purely prose" and skips the gate. That is how a 1300-line
diff nearly shipped unreviewed on the branch that introduced this rule. The
second line catches unstaged and staged edits, the third catches new files that
have never been added.

**If any changed path is executable, run `/code-review`.** Source, tests,
scripts, config, build files. The only exemption is a diff that is purely
prose: docs, CHANGELOG, comments.

This is not scoped to `src/geometry/` and `src/export/` any more. It used to
be, and the gap let a 700-line bench through unreviewed; the review that
eventually ran found three claims in its findings report read off rows the
shipping code never uses.

Then run it **again after acting on the findings**. A fix written to close one
complaint is exactly where a too-narrow patch lands.

**How many rounds**: as many as keep returning wrong output. Stop when a round
returns only arguable defaults, which is taste and never runs out. There is no
cap, and there is no credit for stopping early. See CLAUDE.md's "Stop on the
kind of finding, not on the count" for the two guards that matter more than the
number: never invent a constant to satisfy a reviewer, and suspect the diff if
rounds keep finding real defects.

Say which round you stopped at and why, in terms of what the last round
returned.

## 4. Push, then watch CI in one blocking call

Branch off `main` if you aren't already on a branch. `main` rejects direct
pushes, force-pushes and branch deletion, and the pre-commit hook enforces it,
so you hit that at the first commit rather than here.

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

**Bare `gh pr checks --watch` is not safe directly after `gh pr create`, which
is exactly when this skill runs it.** GitHub takes a few seconds to register
check runs for a new PR. Until it does, `gh` prints "no checks reported on the
branch" and **exits 0**, which is indistinguishable from success by exit code.
The harness then reports a completed command with no error, so a PR whose CI had
not started reads as passing. This has already happened once (#124). The `until`
loop waits for at least one check to exist, and hard-fails rather than passing
if none appear.

The loop runs inside one shell call, so it does not violate the no-polling rule:
one model turn total, not one per iteration.

**Do not loop `gh pr checks` or `gh run list` from the model side.** Each poll
re-sends the whole conversation, so N polls cost N× the context. One blocking
watch costs 1×, flat, however long CI takes.

Read the actual result text before calling it green. "No checks reported", a
zero-duration pass, and an empty check list are all failures to verify.

CI runs the same six gates as step 1, so if those passed locally this step is
confirmation rather than discovery. Worth it on release tags and on changes that
could behave differently in CI's environment; optional otherwise. Say which case
you think it is instead of watching reflexively.

## Scope

One focused change per branch and PR. If the work splits cleanly into
independent changes, prefer separate PRs; bundle only what is genuinely coupled.
