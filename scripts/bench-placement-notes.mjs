// What stating the placement notes before Export costs on a real chair build, and what it states.
//
// Two costs: after a rebuild (every array is new, so layoutPlates walks every body vertex), read
// from window.__mosaic.placementRefreshMs; and a printer switch's whole change handler, timed in
// the page, where the footprints are re-used. Run against a build without the pre-export notes for
// the A/B on the second (the first reads n/a there). Then prints the placement pills standing per
// printer before any export, and after one, to see what a user sees.
//
// Usage: npm run build && MOSAIC_GPU=1 node scripts/bench-placement-notes.mjs [repeats]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPreview, launchBrowser, newPage, afterRebuild } from './lib/harness.mjs';

const REPEATS = Number.parseInt(process.argv[2] ?? '7', 10);
const PORT = 4187;
const T = { rebuildTimeoutMs: 900_000 };
const PRINTERS = ['bambu-h2d', 'snapmaker-u1', 'bambu-x1c'];
// Each placement message ends with one of PLACEMENT_WARNING_SUFFIXES (src/ui/exportPanel.ts);
// these are the words common to them, enough to pick the pills out of the warnings strip.
const PLACEMENT = /in your slicer|before printing|verified position/;

// Three colors on every zone, as scripts/export-chair-examples.mjs: every plate then prints a tower.
const SIZE_MM = 700;
const STRIPE_MM = 30;
const COLORS = ['#c1272d', '#f5d020', '#1e5fa8'];
const SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE_MM}mm" height="${SIZE_MM}mm" viewBox="0 0 ${SIZE_MM} ${SIZE_MM}">` +
  Array.from({ length: SIZE_MM / STRIPE_MM }, (_, k) => {
    const y = k * STRIPE_MM;
    return `<rect x="0" y="${y}" width="${SIZE_MM}" height="${STRIPE_MM}" fill="${COLORS[k % 3]}"/>`;
  }).join('') +
  '</svg>';
const dir = 'stubs/bench-placement-notes';
mkdirSync(dir, { recursive: true });
const svgPath = path.join(dir, 'stripes.svg');
writeFileSync(svgPath, SVG);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stats = (xs) =>
  `median ${median(xs).toFixed(1)}ms  min ${Math.min(...xs).toFixed(1)}  max ${Math.max(...xs).toFixed(1)}`;

let browser;
const preview = await startPreview({ port: PORT });
try {
  browser = await launchBrowser();
  const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
  await page.goto(`http://localhost:${PORT}/?kind=chair-body`);
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
      return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
    },
    null,
    { timeout: 180_000 },
  );
  await afterRebuild(
    page,
    async () => {
      await page.setInputFiles('#svg-input', svgPath);
      await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
    },
    T,
  );
  await afterRebuild(
    page,
    () => page.selectOption('#artwork-list .artwork-row .artwork-zone', ''),
    T,
  );
  const tris = await page.textContent('#stat-tris');
  console.log(`chair, 3 colors on all zones, ${tris}`);

  const refreshMs = () => page.evaluate(() => window.__mosaic.placementRefreshMs?.() ?? null);
  // A depth nudge and back: each is a full rebuild whose arrays are all new.
  const depth = await page.inputValue('#p-depth');
  const afterRebuilds = [];
  const rebuildWall = [];
  for (let r = 0; r < Math.min(REPEATS, 3); r++)
    for (const v of [(Number(depth) + 0.05).toFixed(2), depth]) {
      const t0 = Date.now();
      await afterRebuild(
        page,
        async () => {
          await page.fill('#p-depth', v);
          await page.dispatchEvent('#p-depth', 'change');
        },
        T,
      );
      rebuildWall.push(Date.now() - t0);
      const ms = await refreshMs();
      if (ms != null) afterRebuilds.push(ms);
    }
  console.log(
    `depth edit to settled rebuild, ${rebuildWall.length} rebuilds: ${stats(rebuildWall)}`,
  );
  console.log(
    `placement notes after a rebuild: ` +
      (afterRebuilds.length ? stats(afterRebuilds) : 'n/a (this build has no pre-export notes)'),
  );

  const times = Object.fromEntries(PRINTERS.map((p) => [p, []]));
  for (let r = 0; r < REPEATS; r++)
    for (const id of PRINTERS)
      times[id].push(
        await page.evaluate((printerId) => {
          const sel = document.querySelector('#p-printer');
          sel.value = printerId;
          const t0 = performance.now();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return performance.now() - t0;
        }, id),
      );
  console.log(`printer change handler, ${REPEATS} runs per printer:`);
  for (const id of PRINTERS) console.log(`  ${id.padEnd(13)} ${stats(times[id])}`);

  const pills = () =>
    page.$$eval('#warnings .warn-text', (ns) =>
      ns.map((n) => n.textContent.trim()).filter(Boolean),
    );
  const placementPills = async () => (await pills()).filter((t) => PLACEMENT.test(t));
  for (const id of PRINTERS) {
    await page.selectOption('#p-printer', id);
    const before = await placementPills();
    console.log(`\n${id}: ${before.length} placement pill(s) before Export`);
    before.forEach((t) => console.log(`  - ${t}`));
  }
  await page.selectOption('#p-printer', 'bambu-h2d');
  const before = await placementPills();
  await Promise.all([
    page.waitForEvent('download', { timeout: 600_000 }),
    page.click('#btn-export'),
  ]);
  const after = await placementPills();
  const dupes = after.length - new Set(after).size;
  console.log(
    `\nbambu-h2d after Export: ${after.length} placement pill(s) (before: ${before.length}), ` +
      `${dupes} duplicate(s)`,
  );
  after.forEach((t) => console.log(`  - ${t}`));
  if (dupes) process.exitCode = 1;
  errors.forEach((e) => console.log(`ERROR ${e}`));
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.stop();
  process.exit(process.exitCode ?? 0);
}
