// Drive the real app: load an image on the hubcap, tick "cut to artwork shape", and check the
// part actually becomes that shape — and says the right thing when it can't.
//
// Usage: npm run build && MOSAIC_GPU=1 npx vite-node scripts/check-hubcap-silhouette.mjs
//
// vite-node, not node: this imports the refusal message from src/ rather than retyping it (see
// REFUSAL below), and that is the whole point — a retyped copy goes stale the moment the message
// is reworded, and a stale copy reads as "the app did not refuse", which is a PASS for every case
// that expects a silhouette.
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
// The app's own string, imported rather than retyped. A substring copy cannot be made safe by
// counting matches: if the message is reworded, the cases that expect a refusal fail on the
// expect-vs-got comparison anyway, while every case expecting a silhouette quietly passes without
// the refusal ever being checked. Importing removes the staleness instead of trying to detect it.
const { HUBCAP_SILHOUETTE_MISSES_CLIPS: REFUSAL } = await import('../src/geometry/hubcap.ts');

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
    const refused = warnings.some((w) => w.includes(REFUSAL));
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

  // What the code review turned up: the part and the picture were placed by two different rules.
  {
    const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
    await page.goto(`http://localhost:${PORT}/?kind=hubcap`);
    await page.waitForFunction(
      () => (document.querySelector('#stat-tris')?.textContent || '') !== '0 tris',
      null,
      { timeout: 90_000 },
    );
    await page.setInputFiles('#svg-input', 'stubs/mario.png');
    await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
    await settle(page, 'artwork');
    await page.check('#p-asm-silhouette');
    await settle(page, 'silhouette');
    const has = async (frag) =>
      (await page.evaluate(() => window.__mosaic.warnings())).some((w) => w.includes(frag));

    console.log('\n=== the part stays on the wheel, however big the artwork is scaled');
    // Scale, not the diameter field: that one clamps to the printer bed (246mm on a 256 plate), so
    // it cannot reach the 280mm wheel on most machines. Scale can, and it is the control the gizmo
    // drives — dragging the artwork bigger is the way a user actually gets here.
    //
    // The panel's readout measures the BUILT mesh vertex by vertex, so it is the app's own answer
    // to "how big did this come out" rather than a restatement of the control.
    const across = async () => {
      const t = await page.$eval('#asm-buildparam-size', (e) => e.textContent || '');
      const m = /([\d.]+)mm across/.exec(t);
      return m ? Number(m[1]) : null;
    };
    const at100 = await across();
    await page.fill('#p-scale-num', '400');
    await page.dispatchEvent('#p-scale-num', 'change');
    await settle(page, 'scaled up');
    const big = await across();
    console.log(`  ${at100}mm across at 100% scale, ${big}mm at 400% (wheel allows 280)`);
    if (big === null) {
      console.log('   !! no footprint readout to check');
      failed++;
    } else if (big > 281) {
      console.log('   !! the part overhangs the wheel it mounts on');
      failed++;
    } else if (!(await has('too big for the wheel'))) {
      console.log('   !! capped silently — the size control just looks broken');
      failed++;
    } else console.log('  capped, and said so');
    await page.fill('#p-scale-num', '100');
    await page.dispatchEvent('#p-scale-num', 'change');
    await settle(page, 'back to 100%');

    console.log('\n=== the template is drawn to the shape, not to a disc');
    const tpl = await page.evaluate(async () => {
      const a = document.querySelector('#asm-template-link');
      if (!a?.href) return null;
      return await (await fetch(a.href)).text();
    });
    if (!tpl) {
      console.log('   !! no template link to check');
      failed++;
    } else if (tpl.includes('<circle') || !tpl.includes('<path')) {
      console.log('   !! the template is still a disc while the part is a silhouette');
      failed++;
    } else console.log('  a path, matching the part');

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
