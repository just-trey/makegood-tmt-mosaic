// Drive the real app: cut a hubcap to a doughnut silhouette and check the artwork on the HOLE's
// inner rim is cut the disc's full thickness, the way the outline's rim already is.
//
// The design face of a holed silhouette is a polygon with holes, and a hole's rim is as much of
// the part's outer wall as the outline is. When the face carried only its outline, a color that
// touched a hole and nothing else came out a 1mm recess: 2mm of base color left standing on the
// hole's wall, which is the exact defect the edge-cut-through rule exists to remove.
//
// Usage: npm run build && MOSAIC_GPU=1 node scripts/check-inner-rim.mjs [outDir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {
  startPreview,
  launchBrowser,
  newPage,
  settle,
  afterRebuild,
  shot,
} from './lib/harness.mjs';

const OUT = process.argv[2] || 'stubs/inner-rim';
mkdirSync(OUT, { recursive: true });
const PORT = 4176;

/** The disc's thickness, so a color that reaches an edge cuts exactly this deep. */
const THROUGH_MM = 3;
/** What an interior color cuts instead: the app's default recess depth. */
const RECESS_MM = 1;

// A doughnut: a red disc with an off-centre hole, placed clear of the mounting clips so the part
// stays one piece. Red touches the outline and was already cut through, so it is the control. Blue
// is a ring hugging the hole and touching nothing else, which is the case under test.
const ART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <path fill="#c1272d" fill-rule="evenodd" d="M100,5 a95,95 0 1,0 0.1,0 z M145,75 a25,25 0 1,0 0.1,0 z"/>
  <path fill="#1e5fa8" fill-rule="evenodd" d="M145,62 a38,38 0 1,0 0.1,0 z M145,75 a25,25 0 1,0 0.1,0 z"/>
</svg>`;
const svgPath = path.join(OUT, 'doughnut.svg');
writeFileSync(svgPath, ART);

/**
 * Every mesh in the exported 3MF and its extent on each axis, in mm. The part is exported lying on
 * the plate, so an inlay's thickness is its Y extent and reading it is how "cut through" is told
 * from "recessed" without trusting the app's own warning.
 */
async function objectExtents(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const model = await zip.file('3D/3dmodel.model').async('string');
  const cfg = await zip.file('Metadata/model_settings.config').async('string');
  // A `<part id>` in the settings is the `<object id>` carrying that mesh, so this is how the
  // body is told from the inlays by name rather than by guessing at a size.
  const names = Object.fromEntries(
    [...cfg.matchAll(/<part id="(\d+)"[^>]*>\s*<metadata key="name" value="([^"]*)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  const out = [];
  for (const om of model.matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const ax = ['x', 'y', 'z'].map((k) =>
      [...om[2].matchAll(new RegExp(`<vertex[^>]*\\b${k}="([-\\d.eE]+)"`, 'g'))].map((v) =>
        Number(v[1]),
      ),
    );
    if (!ax[0].length) continue;
    out.push({
      id: om[1],
      name: names[om[1]] ?? '?',
      spans: ax.map((v) => Math.max(...v) - Math.min(...v)),
    });
  }
  return out;
}

let failed = 0;
const preview = await startPreview({ port: PORT });
let browser;
try {
  browser = await launchBrowser();
  const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
  await page.goto(`http://localhost:${PORT}/?kind=hubcap`);
  await page.waitForFunction(
    () => (document.querySelector('#stat-tris')?.textContent || '') !== '0 tris',
    null,
    { timeout: 90_000 },
  );
  await afterRebuild(page, async () => {
    await page.setInputFiles('#svg-input', svgPath);
    await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
  });
  await page.check('#p-asm-silhouette');
  await settle(page, 'silhouette on');
  await shot(page, OUT, 'doughnut.png');

  // The notice names every color the rule fired on, so it is a second, independent reading of the
  // same thing the geometry below measures.
  const warnings = await page.evaluate(() => window.__mosaic.warnings());
  warnings.forEach((w) => console.log(`  warn: ${w}`));
  if (!warnings.some((w) => w.includes('#1e5fa8') && w.includes("reach the part's outer edge"))) {
    console.log('   !! the color on the hole’s rim was not reported as reaching an outer edge');
    failed++;
  }

  const file = path.join(OUT, 'doughnut.3mf');
  const dl = page.waitForEvent('download', { timeout: 180_000 });
  await page.click('#btn-export');
  await (await dl).saveAs(file);

  const objects = await objectExtents(file);
  objects.forEach((o) =>
    console.log(`  "${o.name}": ${o.spans.map((v) => v.toFixed(3)).join(' x ')} mm`),
  );
  // Two inlays, both cut the disc's full thickness: the one on the outline and the one on the
  // hole. Anything at the recess depth is the old behavior, so name that case rather than only
  // failing the equality.
  const inlays = objects.filter((o) => o.name !== 'Body');
  if (inlays.length !== 2) {
    console.log(`   !! expected 2 inlays beside the body, got ${inlays.length}`);
    failed++;
  }
  for (const o of inlays) {
    const t = o.spans[1];
    if (Math.abs(t - THROUGH_MM) < 0.01) continue;
    const why =
      Math.abs(t - RECESS_MM) < 0.01
        ? 'cut as an interior recess — the hole’s rim is not being read as an edge'
        : 'neither the through-cut nor the recess depth';
    console.log(`   !! "${o.name}" is ${t.toFixed(3)}mm thick: ${why}`);
    failed++;
  }
  errors.forEach((e) => {
    console.log(`   !! console: ${e}`);
    failed++;
  });
} finally {
  await browser?.close();
  await preview?.stop?.();
}
console.log(failed ? `\n${failed} problem(s)` : '\nall good');
process.exit(failed ? 1 : 0);
