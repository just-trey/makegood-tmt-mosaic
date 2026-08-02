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

WSL2 has no display, so headless is the only option here — don't try to launch
non-headless. `chromium-headless-shell` is already installed (see memory
`wsl-dev-environment.md` if you're checking); don't re-run
`npx playwright install`.

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
