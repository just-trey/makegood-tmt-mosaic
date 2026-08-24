// The paint-order boolean pass, timed in a real browser against the real module.
//
//   node scripts/bench-regions-browser.mjs [svg...] [--repeat=N] [--port=N]
//
// Why this exists alongside two other benches. `bench-regions.ts` prices the pass accurately but
// in Node, and docs/tech-debt.md's figures were taken in Chrome. `bench-flat-rebuild.mjs` runs in
// Chrome but times a whole rebuild, which is too noisy to resolve anything under about 2x. This
// one imports `src/geometry/regions.ts` straight into the page off a Vite dev server and times
// only `computeNetRegionsByColor`, so the engine, the JIT and the numbers are all the browser's.
//
// It starts its own dev server on a port of its own. The one on 5173 belongs to whoever is
// working; do not reuse it.
//
// Dev server, not `vite preview`, on purpose: preview serves a bundle with no module graph to
// import from, and the point here is to reach one module rather than the whole app.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : dflt;
};
const REPEATS = flag('repeat', 5);
const PORT = flag('port', 5199);
const svgs = argv.filter((a) => !a.startsWith('--'));
const FILES = svgs.length
  ? svgs
  : [
      'stubs/temp/Sunny MLP 2.svg',
      'stubs/temp/snoopy.svg',
      'stubs/temp/pappa.svg',
      'stubs/temp/smurfette.svg',
      'stubs/dino ring.svg',
      'public/patterns/dalmatian.svg',
    ];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const server = spawn(
  'node_modules/.bin/vite',
  ['--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: REPO, stdio: 'ignore', detached: true },
);
let browser;
const stop = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
};

try {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error(`dev server never answered on ${PORT}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  browser = await launchBrowser();
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`  page error: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);

  console.log(`\ncomputeNetRegionsByColor in the browser (median of ${REPEATS})\n`);
  for (const rel of FILES) {
    const out = await page.evaluate(
      async ({ rel, repeats }) => {
        const { parseSVGDocument } = await import('/src/svg/parse.ts');
        const { computeNetRegionsByColor, planarArea } = await import('/src/geometry/regions.ts');
        const text = await (
          await fetch('/' + rel.split('/').map(encodeURIComponent).join('/'))
        ).text();
        const runs = [];
        let colors = 0;
        let area = 0;
        for (let r = 0; r < repeats; r++) {
          // Re-parse every run. The pass memoizes on the shapes array's identity, so reusing one
          // parse would time a cache hit from the second run on.
          const parsed = parseSVGDocument(text);
          const t0 = performance.now();
          const res = await computeNetRegionsByColor(parsed.shapes, () => {});
          runs.push(performance.now() - t0);
          const entries = Object.entries(res.byColor);
          colors = entries.length;
          area = entries.reduce((s, [, f]) => s + planarArea(f), 0);
        }
        return { runs, colors, area };
      },
      { rel, repeats: REPEATS },
    );
    console.log(
      `  ${path.basename(rel).padEnd(24)} ${median(out.runs).toFixed(0).padStart(6)}ms   ` +
        `${out.colors} colors   total area ${out.area.toFixed(3)}\n` +
        `    runs: ${out.runs.map((r) => r.toFixed(0)).join(' ')}`,
    );
  }
  console.log('');
} finally {
  // Both in the finally: with only the server here, one bad file left a Chromium process running.
  await browser?.close();
  stop();
}
