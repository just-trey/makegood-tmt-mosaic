---
name: run-app
description: Launch the app for manual or headless verification: dev server for interactive use, or a headless Playwright page for screenshots/driving it from a script. Use before claiming a UI or geometry change works, or when a reviewer skill needs to observe real app behavior.
model: sonnet
---

# Run the app

## Interactive

```bash
npm run dev
```

Vite picks the first free port from 5173 and prints the URL. **Don't assume
5173; read the printed line.** `?kind=` opens a given assembly kind directly
(`?kind=chair-body`, `?kind=footrest`) instead of the wheel.

**The dev server cannot go stale.** It transforms modules per request and
hot-reloads, so a long-running one still serves current source days later. A dev
server you didn't start is somebody's working session: leave it alone, and don't
cite its age as evidence of anything.

Everything below about staleness concerns `vite preview`, a different program
serving a different directory. Don't call that one "the preview server" too.

## Headless, for screenshots or a driven check

On a headless Linux or WSL2 box there is no display, so headless is the only
option. If Playwright isn't set up, run `npx playwright install
chromium-headless-shell` once (already done on the maintainer's box; see memory
`wsl-dev-environment.md`).

**Driven runs default to software rendering, which is slow.** Headless Chromium
falls back to SwiftShader at roughly 300ms/frame, which caps
`requestAnimationFrame` near 2.5fps and stretches anything frame-paced. Driving
the chair end-to-end was measured at **~104s** software against **~12s** on
hardware.

`MOSAIC_GPU=1` opts into the hardware path:

```bash
npm run build && MOSAIC_GPU=1 node scripts/export-chair-examples.mjs
```

**The `npm run build &&` is not optional.** See "Stale builds" below. Every
driven script needs it; only `npm run smoke` builds on your behalf.

`launchBrowser()` in [harness.mjs](../../../scripts/lib/harness.mjs) reads the
flag and adds the ANGLE and `GALLIUM_DRIVER=d3d12` flags that select the GPU, so
it applies to any script built on the harness, which is all of them.

**Whether it helps depends on the machine, and the flag tells you which you
have.** Those flags are specific to WSL2's d3d12 passthrough (`/dev/dxg` plus
Mesa in `/usr/lib/wsl/lib`); elsewhere there may be nothing to select. Asking
for hardware and not getting it is a deliberate hard error, not a silent slow
run: the harness reads the GL renderer string once per browser and refuses to
continue if it names SwiftShader or llvmpipe. So trying it is self-verifying.
Either it prints `GPU: ANGLE (…)`, or it stops and tells you it fell back.

**Omitting the flag is always correct.** Everything works software-rendered,
just slower, and that is the path CI takes since its Playwright container has no
GPU. Leave it off if you are unsure, if the error above fires, or if you are
reproducing CI. Background in [tech-debt.md](../../../docs/tech-debt.md).

**Don't invent the launch and wait-for-server shape.** Copy it from
[export-chair-examples.mjs](../../../scripts/export-chair-examples.mjs), which
drives the real app end to end (load a part, bind artwork, export) and is the
maintained reference.

Read its `settled()` helper before writing a new wait condition. **`#btn-export`
staying enabled is not a signal that a rebuild finished**: it stays enabled from
the _previous_ build while the next is scheduled and running. Wait for the
`#loading-overlay` curtain to rise and fall instead.

The browser plumbing (`startPreview`, `launchBrowser`, `newPage`) is factored
out in [harness.mjs](../../../scripts/lib/harness.mjs); reuse it rather than
re-deriving a Playwright launch. It also filters the `cloudflareinsights.com`
CORS noise that appears on localhost, so console-error assertions built on it
need no special case.

## Stale builds, the failure this repo keeps hitting

`vite preview` serves `dist/` as a static snapshot and never rebuilds. Edit a
file, re-run a driven check without building, and the run drives the _previous_
build: the app loads, the check passes, the screenshots look right, and every
number describes code no longer on disk.

**This needs no leftover process.** A freshly spawned, correctly started preview
serves stale bytes just as happily, which is why "kill the old server and retry"
doesn't fix it.

`startPreview()` refuses to start when anything under `src/`, `public/`,
`index.html` or `vite.config.ts` is newer than `dist/index.html`, and names what
was stale. Run `npm run build`. Don't reach for `allowStaleDist: true` unless
you specifically mean to drive the older build.

## Ports, don't conflate them

- **4173**: `npm run preview` and `startPreview()`'s default, serving the
  production build with `--strictPort`. It refuses to start if the port is taken
  rather than silently picking another, because a leftover preview would
  otherwise answer with a stale build.
- **4174**: `export-chair-examples.mjs` runs its own preview here, so it can run
  alongside an interactive preview on 4173.

Writing a new driven check? Prefer 4174 or another free port over 4173, unless
you specifically want to reuse a running preview (`startPreview({ reuse: true })`).
