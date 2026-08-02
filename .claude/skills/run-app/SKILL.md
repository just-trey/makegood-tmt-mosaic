---
name: run-app
description: Launch the app for manual or headless verification — dev server for interactive use, or a headless Playwright page for screenshots/driving it from a script. Use before claiming a UI or geometry change works, or when a reviewer skill needs to observe real app behavior.
model: sonnet
---

# Run the app

## Interactive

```bash
npm run dev
```

Vite, no pinned port — it picks the first free one starting at 5173 and prints
the URL it landed on. Don't assume 5173; read the printed line. `?kind=` opens
the app on a given assembly kind directly (`?kind=chair-body`, `?kind=footrest`)
instead of the wheel picker, useful when you already know what you're checking.

## Headless, for screenshots or a driven check

Drive it headless. On a headless Linux/WSL2 box there is no display, so it's
the only option — don't burn a cycle trying to launch headed there. If
Playwright isn't set up yet, `npx playwright install chromium-headless-shell`
once (on the maintainer's box it already is; see memory
`wsl-dev-environment.md`).

**Driven runs default to software rendering, which is slow.** Headless
Chromium falls back to SwiftShader — roughly 300ms/frame, which also caps
`requestAnimationFrame` near 2.5fps and stretches anything frame-paced. On a
WSL2 box with GPU passthrough, driving the chair end-to-end was measured at
**~104s** software versus **~12s** on hardware.

`MOSAIC_GPU=1` opts into the hardware path:

```bash
MOSAIC_GPU=1 node scripts/export-chair-examples.mjs
```

`launchBrowser()` in [scripts/lib/harness.mjs](../../../scripts/lib/harness.mjs)
reads it and adds the ANGLE + `GALLIUM_DRIVER=d3d12` flags that select the GPU,
so it applies to any script built on the harness — which is all of them.

**Whether it helps depends on the machine, and the flag tells you which you
have.** The selection flags are specific to WSL2's d3d12 passthrough
(`/dev/dxg` plus Mesa in `/usr/lib/wsl/lib`); on a different OS or a box
without passthrough there may be nothing to select. Asking for hardware and
not getting it is a deliberate hard error rather than a silent slow run: the
harness reads the GL renderer string once per browser and refuses to continue
if it names SwiftShader or llvmpipe. So trying it is safe and self-verifying —
either it runs and prints `GPU: ANGLE (…)`, or it stops immediately and tells
you it fell back.

**Omitting the flag is always correct.** Everything works software-rendered,
just slower — that is the path CI takes, since the Playwright container has no
GPU at all. Leave it off if you're unsure, if the error above fires, or if
you're specifically reproducing CI. Full background:
[docs/tech-debt.md](../../../docs/tech-debt.md).

Don't invent the launch/wait-for-server shape — copy it from
[scripts/export-chair-examples.mjs](../../../scripts/export-chair-examples.mjs),
which drives the real app end-to-end (load a part, bind artwork, export) and is
the maintained reference for this. Its wait-for-idle helper (`settled()`) is
itself worth reading before writing a new wait condition: `#btn-export` staying
enabled is not a signal that a rebuild has finished — it stays enabled from the
_previous_ build while the next one is scheduled and running. Wait for the
`#loading-overlay` rebuild curtain to rise and fall instead.

The underlying browser plumbing (`startPreview`, `launchBrowser`, `newPage`) is
factored out in
[scripts/lib/harness.mjs](../../../scripts/lib/harness.mjs) — reuse it rather
than re-deriving a Playwright launch. It also filters out the
`cloudflareinsights.com` CORS noise that shows up on localhost, so console-error
assertions built on it don't need to special-case that themselves.

**Ports, don't conflate them:**

- `npm run preview` (and `startPreview()`'s default) serves the production
  build on **4173** with `--strictPort` — it refuses to start if that port is
  already taken rather than silently picking another, on purpose: a leftover
  preview from an earlier run would otherwise answer requests with a stale
  build.
- `export-chair-examples.mjs` runs its own preview on **4174**, specifically so
  it can run alongside an interactive `npm run preview` on 4173 without
  colliding.

If you're writing a new driven check, prefer 4174 or another free port over
4173 unless you specifically want to reuse an already-running preview
(`startPreview({ reuse: true })`).
