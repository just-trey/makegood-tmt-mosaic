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

    const size = await page.$eval('#asm-buildparam-size', (e) => e.textContent || '');
    console.log(`  readout: ${size}`);
    if (!/Actual size [\d.]+ × [\d.]+ mm/.test(size)) {
      console.log('   !! no footprint readout — the size control alone does not describe the part');
      failed++;
    }

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
  // The four things the maintainer hit while driving it.
  {
    const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
    await page.goto(`http://localhost:${PORT}/?kind=hubcap`);
    await page.waitForFunction(
      () => (document.querySelector('#stat-tris')?.textContent || '') !== '0 tris',
      null,
      { timeout: 90_000 },
    );
    const warns = () => page.evaluate(() => window.__mosaic.warnings());
    const has = async (frag) => (await warns()).some((w) => w.includes(frag));

    console.log('\n=== an opaque image is its own rectangle');
    await page.setInputFiles('#svg-input', 'stubs/mario.webp');
    await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
    await settle(page, 'artwork');
    await page.check('#p-asm-silhouette');
    await settle(page, 'silhouette');
    if (!(await has('no transparent background'))) {
      console.log('   !! no warning for an image with no transparency');
      failed++;
    } else console.log('  warned, as it should');

    console.log('\n=== Fill is withheld while cutting to shape');
    const modeOpts = await page.$$eval('#artwork-list .artwork-mode option', (o) =>
      o.map((x) => x.value),
    );
    console.log(`  modes offered: ${modeOpts.join(', ') || '(no mode control)'}`);
    if (modeOpts.includes('fill')) {
      console.log('   !! Fill still offered');
      failed++;
    }

    console.log('\n=== a second design is refused');
    await page.setInputFiles('#svg-input', 'stubs/mario.png');
    await page.waitForFunction(
      () => document.querySelectorAll('#artwork-list .artwork-row').length >= 2,
      null,
      { timeout: 120_000 },
    );
    await settle(page, 'second artwork');
    if (!(await has('can only follow one design'))) {
      console.log('   !! a second design was allowed');
      failed++;
    } else console.log('  refused, as it should');

    console.log('\n=== removing the artwork puts the hubcap back');
    const cut = await page.$eval('#stat-tris', (e) => e.textContent);
    await page.evaluate(() => {
      document
        .querySelectorAll(
          '#artwork-list .artwork-row .artwork-remove, #artwork-list .artwork-row [data-act="remove"]',
        )
        .forEach((b) => b.click());
    });
    await settle(page, 'removed');
    const bare = await page.$eval('#stat-tris', (e) => e.textContent);
    console.log(`  tris ${cut} -> ${bare}`);
    if (cut === bare) {
      console.log('   !! the part did not go back to a circle');
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
