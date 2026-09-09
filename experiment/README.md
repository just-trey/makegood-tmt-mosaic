# Rebuild experiment: Fable vs Codex, same brief, same references

Result of running this: two branches, `fable` and `codex`, each a from-scratch build of the
TMT color-inlay tool by one model, scored on the same eight scenarios.

## What is in this folder

| File           | Role                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `PROMPT.md`    | The brief. Handed to both models verbatim. Product requirements only, no tools named. |
| `EVAL.md`      | The eight acceptance scenarios and the score sheet. Both models get to read it.       |
| `AGENTS.md`    | The neutral pointer. Bootstrap copies it to both `AGENTS.md` (Codex) and `CLAUDE.md`. |
| `artwork/`     | Test fixtures that exist only for the experiment (`gradient.svg` for S5).             |
| `bootstrap.sh` | Assembles the fresh repo from this checkout plus your gitignored `stubs/`.            |

## What the models get, and what they do not

**In:** the printed pieces (`public/stl/*.3mf`, `parts.json`), the four pattern SVGs, the
MakeGood logo, `filaments.json`, the three design-token CSS files, and every verified slicer
project and test design you drop in `stubs/` before running bootstrap.

**Out, on purpose:** all of `src/`, `docs/pipeline.md`, `chair-body-zones.json`, the
`public/templates/` SVGs, the design-system UI kit and component specs, `tech-debt.md` and the
findings. Every one of those encodes an architecture decision this repo already made (zone
unwrap, baked placement tables, the panel layout). The brief carries the product truths those
files contain (which surfaces take a design, which pieces do not, what the verified prints show)
without the mechanism.

One line in `PROMPT.md` pushes toward a web app without naming one: the "runs on the
volunteer's own computer, usable within five minutes of a link or download, nothing leaves the
machine" requirement. It is a real product requirement, so it stays. Delete that paragraph for
a purer test of what each model reaches for unprompted.

## Setup

1. Put the verified slicer projects and extra test designs in this repo's gitignored `stubs/`.
   `bootstrap.sh` lists the exact filenames it looks for and reports any it did not find.
2. Run `experiment/bootstrap.sh ../tmt-mosaic-rebuild`. It assembles the repo, commits the kit
   on `main`, and creates `fable` and `codex` from that one commit.
3. Create an empty private GitHub repo and push all three branches.
4. Fill in `reference/verified-prints/MANIFEST.md` if bootstrap left a description blank.

## Protocol

Same words, same count, same order, for both models. Log every prompt and its wall-clock time.

- **Round 0**, one message: `Read AGENTS.md and do what it says.`
- **Follow-ups**, at most N per model (pick N before starting; three is a reasonable first
  run), each the same sentence: `Continue. Work through EVAL.md in order. For each scenario,
commit the exported 3MF to evidence/ and record the result in NOTES.md.`
- A session that ends because it thinks it is done still counts its unused follow-ups: send
  them anyway. A model that says "done" after round 0 and one that needs three are both data.
- Answer no questions. `AGENTS.md` tells them not to ask; if one asks anyway, reply with the
  follow-up sentence.
- Never merge, cherry-pick or show one branch to the other model. Both branches start from the
  same commit; contamination is the one thing that invalidates the run.
- Run Fable in Claude Code on branch `fable` and Codex on branch `codex`, each in its own
  environment with the same network policy. Note the harness and model version in the log.

## Comparing

- Check out each branch, follow its README on a clean machine, and time it.
- Score `EVAL.md` per build. Open every `evidence/*.3mf` in Bambu Studio.
- Diff-level numbers live on the score sheet: LOC, dependency count, follow-ups used, cost.
- Keep your own notes in `LOG.md` at the root of the experiment repo, one section per branch.
  Record surprises: a step that needed CAD knowledge, a warning that named an internal, a file
  the slicer had to repair.

## Log template

```
## fable
Harness / model:
Round 0 sent:            ended:
Follow-up 1 sent:        ended:
...
Cost:
Notes:
```
