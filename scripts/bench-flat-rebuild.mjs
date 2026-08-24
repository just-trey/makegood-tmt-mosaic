// How long a flat rebuild of a dense SVG really takes, in the browser, on the built app.
//
//   npm run build && MOSAIC_GPU=1 node scripts/bench-flat-rebuild.mjs [svg...] [--repeat=N]
//
// The node benches (scripts/bench-regions.ts) price the boolean pass in isolation. This one exists
// because docs/tech-debt.md quotes a *whole rebuild* figure taken in the app, and the two are not
// the same number: a rebuild also parses, fits, extrudes, meshes and paints. Quoting a node
// measurement as the rebuild cost is the mistake this script is here to prevent.
//
// **Read the `runs:` line before quoting the median.** This measurement is noisy in a way that has
// nothing to do with the code under it: one five-run pass on an unchanged build produced 4.80,
// 5.00, 8.14, 8.20, 8.00 for the same file. A single before/after pair here can show a speedup or
// a regression on identical code, so a change under about 2x is not resolvable by this script and
// should be measured with `bench-regions.ts` instead.
//
// What it does resolve, and what it is kept for, is whether the build is still *correct*: triangle
// count, colour count, the warning list, and a screenshot. A boolean pass that got faster and
// dropped a region looks identical in a timing table and obvious on screen.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { startPreview, launchPage, afterRebuild, shot } from './lib/harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4174;
const DEFAULT_SVGS = [
  'stubs/temp/Sunny MLP 2.svg',
  'stubs/temp/snoopy.svg',
  'stubs/dino ring.svg',
  'public/patterns/dalmatian.svg',
];

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const repeatArg = process.argv.slice(2).find((a) => a.startsWith('--repeat='));
// One run says nothing here. The same build measured snoopy at 1.89s and 3.03s, so a single
// before/after pair can show a speedup or a regression on the same code. Median of REPEATS.
const REPEATS = repeatArg ? Number(repeatArg.split('=')[1]) : 5;
const outDir = path.join(REPO, '.bench-flat-rebuild');
const svgs = args.length ? args : DEFAULT_SVGS;
mkdirSync(outDir, { recursive: true });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const server = await startPreview({ port: PORT });
const { browser, page } = await launchPage({ port: PORT });

try {
  console.log(`\nFlat rebuild, wall clock in the browser (median of ${REPEATS})\n`);
  for (const rel of svgs) {
    const name = path.basename(rel);
    const buffer = readFileSync(path.join(REPO, rel));
    const runs = [];
    let rows = [];
    let tris = '';
    let warnings = [];
    for (let r = 0; r < REPEATS; r++) {
      // A fresh page per run: computeNetRegionsByColor memoizes on the parsed shapes, so a second
      // load in the same page would time a cache hit and read as an enormous speedup.
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForSelector('#svg-input', { state: 'attached' });

      const t0 = Date.now();
      await afterRebuild(
        page,
        () => page.setInputFiles('#svg-input', { name, mimeType: 'image/svg+xml', buffer }),
        { rebuildTimeoutMs: 600_000 },
      );
      runs.push((Date.now() - t0) / 1000);

      // Read what the build produced, not just how long it took. `window.__mosaic.warnings` is the
      // list itself; the pills in #warnings are a render of it, and reading those would make a
      // rendering change look like a geometry change.
      rows = await page.$$eval('#color-list .color-row:not(.is-base) .hex', (ns) =>
        ns.map((n) => n.textContent),
      );
      tris = await page.textContent('#stat-tris');
      warnings = await page.evaluate(() => window.__mosaic?.warnings?.() ?? []);
    }
    console.log(
      `  ${name.padEnd(24)} ${median(runs).toFixed(2)}s   ${rows.length} colors   ${tris}\n` +
        `    runs: ${runs.map((r) => r.toFixed(2)).join(' ')}` +
        (warnings.length ? `\n    warnings: ${warnings.join(' | ')}` : ''),
    );
    await shot(page, outDir, name.replace(/\W+/g, '-') + '.png');
  }
  console.log(`\n  screenshots in ${outDir}\n`);
} finally {
  await browser.close();
  server.stop();
}
