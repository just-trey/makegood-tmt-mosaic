# Audit: success signals derived from something adjacent to the property asserted

**Report only — nothing here is fixed.** Walked 2026-08-08 at commit `c2d7767`, against
[tech-debt.md](../tech-debt.md)'s "The things that check the code get audited less than the code
they check", which records five instances of one shape and states that no systematic audit has
been done.

The shape: **a success signal derived from something adjacent to the property being asserted,
where the ambiguous case is indistinguishable from a real pass at the point of use.** Not "the
check is weak" — weak checks announce themselves. These announce a pass.

Surface walked: every file in `scripts/` and `scripts/lib/`, `.github/workflows/`, `.husky/`, the
five gates in `package.json`, the coverage floors in `vite.config.ts`, and the `gh`-based waits in
`.claude/skills/`. Where a finding could be driven, it was; each one below says which.

Findings are ordered by how much rests on them, not by how surprising they are. Two are confirmed
by measurement, five by reading, and four things that looked like instances turned out not to be —
those are at the bottom, because "I checked and it holds" is the part of an audit that is
otherwise invisible.

---

## 1. CONFIRMED — smoke's "export button is enabled" wait returns before the rebuild it follows

[scripts/smoke.mjs](../../scripts/smoke.mjs), four sites: lines 67, 77, 94, 150.

```js
await page.waitForFunction(() => !document.querySelector('#btn-export')?.disabled, { … });
```

- **Property asserted:** `#btn-export.disabled === false`.
- **Property intended:** the rebuild started by the click on the previous line has finished.
- **How they diverge:** `setExportEnabled` ([src/app/rebuild.ts:87](../../src/app/rebuild.ts#L87))
  is called with `false` only on the no-artwork path and with `true` after a successful build. It
  is never called at the _start_ of a rebuild. So once anything has been built, the button is
  enabled and stays enabled through every later rebuild, and this wait returns immediately.

This is the same defect tech-debt records as **already fixed** — "`#btn-export` staying enabled
read as 'the rebuild finished' when it was still enabled from the previous build". The fix was
`settledAfterRebuild()` in the harness. Three of smoke's four sites were never converted to it,
and smoke is the only browser check CI runs.

**Driven, this build, `MOSAIC_GPU=1`:** at smoke's step 3 (click a base swatch, then this wait) —

```
export button disabled at click : false
smoke's wait returned after     : 36 ms
the rebuild then took another   : 444 ms
=> the wait covered 8% of the work it names
```

What currently saves it is the `await sleep(800)` on the next line, which is longer than 444 ms
today. That is a fixed sleep standing in for a bound nobody has established — see finding 3.

Closing it: `settledAfterRebuild(page)` at all four sites. It exists, it is the documented fix for
exactly this, and it is imported nowhere in `smoke.mjs`.

---

## 2. CONFIRMED — `settledAfterRebuild()` cannot tell "the rebuild finished" from "no rebuild ever started"

[scripts/lib/harness.mjs:306](../../scripts/lib/harness.mjs#L306).

```js
// If the curtain has already been and gone we're past it; don't hang waiting to see it rise.
await overlay(true).catch(() => {});
await overlay(false);
```

- **Property asserted:** the loading curtain is currently down.
- **Property intended:** the action just taken ran a rebuild, and that rebuild is complete.
- **How they diverge:** the `.catch(() => {})` absorbs the 30-second timeout on "the curtain came
  up". It is there for the real case where the rebuild finished before the script looked — but it
  cannot distinguish that from the action having scheduled no rebuild at all, which is the case
  where every assertion afterwards is about the _previous_ state.

**Driven, this build:**

```
settledAfterRebuild() after doing NOTHING : returned in 30009 ms   (and reported success)
settledAfterRebuild() after a real change : returned in  1073 ms
```

So the failure mode is not a wrong answer arriving fast; it is a wrong answer arriving after
exactly 30 seconds of nothing, which reads as "that step was slow". I hit this while writing
`check-zone-occlusion.mjs` and mistook it for a slow rebuild for two runs.

Closing it: the app already exposes a rebuild count nobody is using — `whenIdle` in
[src/app/idle.ts](../../src/app/idle.ts) knows when work starts. A `rebuildsSoFar()` read before
and after would make "no rebuild happened" a distinct, immediate, loud result. Failing that, the
30-second absorb should at least return a flag the caller can assert on.

---

## 3. Every screenshot in smoke is taken after a fixed sleep, and no sleep is derived from anything

`sleep(1500)`, `sleep(1000)`, `sleep(800)` ×4, `sleep(1200)` — [smoke.mjs](../../scripts/smoke.mjs).

- **Property asserted:** N milliseconds passed.
- **Property intended:** the frame on screen reflects the state the step just produced.
- **How they diverge:** the render loop is on-demand (`invalidate()` in
  [viewport.ts](../../src/scene/viewport.ts)), so the right wait is one rAF after the scene is
  marked dirty. A sleep passes on a machine fast enough and fails on one that isn't, and CI runs on
  a software renderer at roughly 300 ms/frame where 800 ms is under three frames. The screenshots
  are artifacts a human reads, so a stale one is a wrong answer that no exit code carries.

`shot()` in the harness already documents that `page.screenshot()` drives a frame of its own and
needs no rAF wait — so these sleeps are standing in for finding 1's missing rebuild wait, not for
a rendering one. Fix finding 1 and they can go.

---

## 4. Nothing in CI looks inside the file the export produces

[smoke.mjs](../../scripts/smoke.mjs) steps 4 and 7 download three files and print
`statSync(f).size`. There is no assertion on any of them — not a plate count, not an object count,
not even `size > 0`.

- **Property asserted:** a `download` event fired within the timeout.
- **Property intended:** the app produced a printable 3MF / STL set.
- **How they diverge:** an export that wrote one empty plate, or dropped every inlay, or lost the
  filament table, fires the same event and prints a smaller number into a log nobody diffs. CI's
  only end-to-end statement about the exported file is that one exists.

The repo already has the assertions this wants and keeps them out of CI:
`summarisePlates()` in [export-chair-examples.mjs](../../scripts/export-chair-examples.mjs) reads
plates, per-plate filament counts and tower positions out of a real file, and
`partObjectSummaries()` in [tests/lib/threemf.ts](../../tests/lib/threemf.ts) does the same for
unit tests. Closing this is calling one of them on the file smoke already has on disk.

---

## 5. smoke's opening wait says "wheel loaded" without checking which part loaded

[smoke.mjs:28](../../scripts/smoke.mjs#L28) — named as a starting point in tech-debt, confirmed here.

```js
await page.waitForFunction(() => { const t = …'#stat-tris'…; return t !== '' && t !== '0 tris'; });
console.log('   wheel loaded:', await page.textContent('#stat-tris'));
```

- **Property asserted:** some geometry exists.
- **Property intended:** the default part — the wheel — auto-loaded.
- **How they diverge:** any kind satisfies a non-zero triangle count. Change `ASSEMBLY_KINDS[0]`
  and smoke passes while its log says "wheel" and its screenshots show something else.

[check-view-fit.mjs:56](../../scripts/check-view-fit.mjs#L56) already solved this properly, and its
comment says why: it asserts `#shape-kind.value` **and** an exact part count, because `>= n` waves
through a kind-switch that silently didn't happen. That is the shape to copy.

---

## 6. `waitForServer()` accepts any HTTP 200 on the port as "our preview is up"

[harness.mjs:24](../../scripts/lib/harness.mjs#L24) — named as a starting point; assessed here.

- **Property asserted:** something on `localhost:PORT` answered `ok`.
- **Property intended:** the `vite preview` we just spawned, serving this repo's `dist/`, is up.
- **How they diverge:** anything listening satisfies it.

**Partly guarded already, and worth saying so:** `startPreview` refuses to start if the port is
already answering (unless `reuse`), so the window is between that pre-check and the wait —
narrow, and nothing has been observed hitting it. The reason to close it anyway is that this is
the one place a _stale build_ and a _foreign server_ look identical, and the repo has been bitten
by the stale-build half twice. Closing it is cheap and exact: fetch `/` and compare against
`dist/index.html` on disk, which turns "someone is listening" into "our bytes are being served".

---

## 7. `startPreview({ reuse: true })` trusts the caller about which build is listening

[harness.mjs:97](../../scripts/lib/harness.mjs#L97) — named as a starting point.

Its own doc comment says so: "Pass `reuse: true` only when the caller has independently verified
whatever is already listening is the build it wants." **No script in the repo passes it today**, so
this is a latent hazard rather than a live one — which is exactly when it will be reached for by
someone in a hurry. The `dist/index.html` comparison in finding 6 would make `reuse` safe by
construction and remove the caller's obligation entirely.

---

## 8. `newPage()`'s dialog auto-accept makes "no confirmation appeared" unobservable

[harness.mjs:229](../../scripts/lib/harness.mjs#L229). A `MutationObserver` clicks `#confirm-ok`
on any dialog that opens.

- **Property asserted (by a script that drives on past a confirm):** the action completed.
- **Property intended:** either no confirmation was needed, or one appeared and was accepted.
- **How they diverge:** the two are the same observation. A script cannot assert that a destructive
  action _did_ warn, and it cannot notice that one stopped warning.

This is the more careful half of an already-recorded instance — the auto-accept was added because
its absence let a script drive the wheel while its log said "chair". The residue is that it is
unconditional and silent. The 2026-08-08 `bloat` review cycle's finding A2 ("switching part shape
carries artwork across with no confirmation") had to be established by driving **without** the hook
installed, and said so; that is the right method and it is not available from any harness-based
script. Closing it: have `newPage` count the dialogs it accepted and expose the count.

---

## 9. Two checks assert on a user-facing warning string by literal match

- [check-hubcap-silhouette.mjs:57](../../scripts/check-hubcap-silhouette.mjs#L57) —
  `w.includes('doesn’t cover the hubcap’s mounting clips')`, typographic apostrophes and all.
- [check-csg-failure.mjs](../../scripts/check-csg-failure.mjs) — per-case `warn` fragments.

- **Property asserted:** a warning containing this substring exists.
- **Property intended:** the app refused / degraded for this reason.
- **How they diverge:** reword the message and the match goes false. In `check-csg-failure` that
  fails loudly ("degraded silently — no warning matching …"), which is correct. In
  `check-hubcap-silhouette` it fails loudly only for cases that _expect_ a refusal; a case
  expecting a silhouette would read a real refusal as a pass, and is caught only by the separate
  `before === after` triangle check.

Live in this run: the fill-refusal messages were reworded on another branch. Nothing in the repo
ties a warning string to the code that emits it, so a rewording is a silent change to what every
checker is matching on. Closing it: export the message builders (as
`fillRefusalMessage` now is) and have checkers call them rather than retype them.

---

## 10. `TILES_PER_CHAIR_ZONE = 143` stands in for live zone geometry

[tests/patterns-assets.test.ts:151](../../tests/patterns-assets.test.ts#L151). Already on record in
tech-debt with the reasoning for why it is frozen and the note that "if a real zone's tile count
ever grows enough to close that gap, this constant needs re-measuring by hand — nothing will flag
it automatically". Listed here only so the audit's list is the whole list: this is the same shape,
it is known, and the decision to accept it was made with the margin (2.6x) in hand.

---

## Checked and found sound

Recorded because an audit that only lists failures does not tell you what was looked at.

- **`assertFreshDist()`** ([harness.mjs:69](../../scripts/lib/harness.mjs#L69)) compares mtimes of
  `src/`, `public/`, `index.html` and `vite.config.ts` against `dist/index.html`. The obvious hole
  — switching git branches, which is what this run did a dozen times — does not open it: git sets
  the mtime of every file whose content it changes to the checkout time, so a branch switch makes
  the changed inputs newer than `dist/` and the guard fires. It does only stat `dist/index.html`
  rather than the hashed assets, but vite writes them in one pass and a failed `tsc --noEmit` stops
  `vite build` from running at all, so a half-written `dist/` is not reachable through `npm run
build`.
- **`assertGpuActive()`** reads the renderer string once per browser and hard-errors on
  SwiftShader/llvmpipe. Once-per-browser is right: the flag is a launch argument, so a second page
  cannot land on a different renderer.
- **`check-view-fit.mjs`'s load wait** asserts the select's value _and_ an exact part count, with a
  comment explaining that `>=` would wave through a kind switch that didn't happen. This is the one
  place in the repo that already does the thing this whole audit is about.
- **The pre-commit hook** refuses a commit on `main` by reading `git rev-parse --abbrev-ref HEAD`,
  which is the property itself, not a proxy for it.
- **The coverage floors** in [vite.config.ts](../../vite.config.ts) run with `autoUpdate: false`, so
  a drop cannot silently rewrite the threshold it breached.
- **`glRenderer()`** falls back through `webgl2` → `webgl` → the literal string `'no webgl'`, and
  `SOFTWARE_RENDERERS` is tested against that string too — so "no context at all" fails rather than
  passing the software check by not matching it.

---

## Added after the fact: the audit's own first pass

Two of the reports written the same day as this one were themselves instances, and both are in
here because they were caught rather than because they were avoided:

- **The seam-sliver hunt's first pass recorded only a warning count.** A check that cannot fail if
  nothing is being built. It was rerun recording triangle counts per configuration, plus a third
  pass forcing a real warning through `?csgfault` to prove the detector was live at all — see
  [seam-sliver-sighting.md](seam-sliver-sighting.md). Had it been reported as written, "22
  configurations, no sighting" would have been a sentence with nothing behind it.
- **The occlusion check's coverage guard compared ink at two design scales** and asserted the
  larger added nothing. "The ink stopped growing" and "nothing I did reached the app" are the same
  observation. It runs three scales now and fails if the smallest doesn't ink visibly less, which
  is the falsifiable half.

Neither was found by being careful. The first was found by writing the sentence "no warnings were
raised" and noticing it did not say what had been built; the second by writing this page.

## The one structural thing

Six of the ten findings are in `scripts/smoke.mjs` and `scripts/lib/harness.mjs`, and four of those
six are the _same_ missing idea: **there is no way to say "wait for the thing I just caused, and
fail if I caused nothing."** `settledAfterRebuild()` is the closest and finding 2 is why it isn't
it. Everything else in smoke — the enabled-button waits, the fixed sleeps — is a workaround for its
absence.

The app already counts its own work: `whenIdle` resolves when the rebuild queue drains. Exposing
the count alongside it, so a script can assert the count moved, would close findings 1, 2, 3 and
most of 5 with one change on the app side and one helper in the harness. That is the single highest
-value item on this page, and it is smaller than any individual fix listed above.
