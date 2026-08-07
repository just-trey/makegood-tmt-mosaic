// Drive the real app: load an image on the hubcap, tick "cut to artwork shape", and check the
// part actually becomes that shape — and says the right thing when it can't.
//
// Usage: npm run build && MOSAIC_GPU=1 node scripts/check-hubcap-silhouette.mjs
import path from 'node:path';
import { startPreview, launchBrowser, newPage, settle } from './lib/harness.mjs';

const PORT = 4174;
const CASES = [
  { img: 'stubs/mario.png', size: 220, expect: 'silhouette', why: 'transparent PNG, solid middle' },
  {
    img: 'stubs/raster test/cartoon cahrater.svg.webp',
    size: 220,
    expect: 'silhouette',
    why: 'transparent WebP with a hole',
  },
  { img: 'stubs/mario.png', size: 60, expect: 'refused', why: 'too small to reach the clips' },
];

let failed = 0;
const preview = await startPreview({ port: PORT });
let browser;
try {
  browser = await launchBrowser();
  for (const c of CASES) {
    const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
    console.log(`\n=== ${path.basename(c.img)} @ ${c.size}mm — ${c.why}`);
    await page.goto(`http://localhost:${PORT}/?kind=hubcap`);
    await page.waitForFunction(
      () =>
        (document.querySelector('#stat-tris')?.textContent || '') !== '' &&
        document.querySelector('#stat-tris').textContent !== '0 tris',
      null,
      { timeout: 90_000 },
    );

    await page.fill('#p-asm-buildparam', String(c.size));
    await page.dispatchEvent('#p-asm-buildparam', 'change');
    await settle(page, 'size');

    await page.setInputFiles('#svg-input', c.img);
    await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
    await settle(page, 'artwork');

    const before = await page.$eval('#stat-tris', (e) => e.textContent);
    await page.check('#p-asm-silhouette');
    await settle(page, 'silhouette on');
    const after = await page.$eval('#stat-tris', (e) => e.textContent);

    const warnings = await page.evaluate(() => window.__mosaic.warnings());
    const refused = warnings.some((w) => w.includes('doesn’t cover the hubcap’s mounting clips'));
    const got = refused ? 'refused' : 'silhouette';
    console.log(`  tris ${before} -> ${after}   result: ${got}`);
    warnings
      .filter((w) => w.toLowerCase().includes('hubcap') || w.includes('shape'))
      .forEach((w) => console.log(`  note: ${w}`));

    if (got !== c.expect) {
      console.log(`   !! expected ${c.expect}`);
      failed++;
    }
    if (got === 'silhouette' && before === after) {
      console.log('   !! triangle count unchanged — the part did not follow the artwork');
      failed++;
    }
    if (errors.length) {
      errors.forEach((e) => console.log(`   !! console: ${e}`));
      failed += errors.length;
    }
    await page.close();
  }
} finally {
  await browser?.close();
  preview.stop();
}
console.log(failed ? `\nRESULT: ${failed} problem(s)` : '\nRESULT: clean');
process.exit(failed ? 1 : 0);
