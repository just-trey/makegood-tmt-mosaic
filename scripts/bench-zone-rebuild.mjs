// What one zone costs against all five, on the sticker path (docs/findings/2026-08-08-zone-rebuild-cost.md).
//
// Usage: npm run build && MOSAIC_GPU=1 node scripts/bench-zone-rebuild.mjs [outFile]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  startPreview,
  launchBrowser,
  newPage,
  glRenderer,
  useGpu,
  afterRebuild,
} from './lib/harness.mjs';

const OUT = process.argv[2] || 'stubs/zone-rebuild-cost.json';
mkdirSync(path.dirname(OUT), { recursive: true });
const PORT = 4186;
const REPEATS = 3;
/**
 * Two design sizes, because the first run showed the answer depends on them far more than on the
 * zone count: an auto-fit sticker covers a fraction of a chair zone and cuts a small pocket, while
 * one scaled up to cover the surface cuts a pocket the size of the zone. Reporting only the first
 * would understate a five-zone rebuild by 5x, and the 19.5s figure in tech-debt is the second.
 */
const SCALES = [100, 400];

/**
 * A plain three-colour sticker, the shape of what a volunteer actually brings: a few broad flat
 * regions, no absolute size, so it auto-fits the way a dropped file does. Deliberately NOT the
 * full-bleed test card the occlusion check uses — that one is sized to cover a whole zone and
 * would measure the worst case rather than the ordinary one.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="0" y="0" width="60" height="20" fill="#c1272d"/>
  <rect x="0" y="20" width="60" height="20" fill="#f5d020"/>
  <rect x="0" y="40" width="60" height="20" fill="#1e5fa8"/>
</svg>`;

const svgPath = path.join(path.dirname(OUT), 'bench-sticker.svg');
writeFileSync(svgPath, SVG);

async function timeRebuild(page, apply) {
  const t0 = Date.now();
  await apply();
  const overlay = (visible) =>
    page.waitForFunction(
      (want) => (document.querySelector('#loading-overlay')?.style.display === 'flex') === want,
      visible,
      { timeout: visible ? 30_000 : 1_800_000 },
    );
  await overlay(true).catch(() => {});
  await overlay(false);
  await page.evaluate(() => window.__mosaic.whenIdle());
  return (Date.now() - t0) / 1000;
}

let browser;
const preview = await startPreview({ port: PORT });
try {
  browser = await launchBrowser();
  const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 1000 } });
  const renderer = await glRenderer(page);
  console.log(`renderer: ${renderer}${useGpu() ? '' : '   (MOSAIC_GPU not set)'}`);

  await page.goto(`http://localhost:${PORT}/?kind=chair-body`);
  await page.waitForFunction(() => !!window.__mosaic);
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
      return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
    },
    null,
    { timeout: 300_000 },
  );
  await page.evaluate(() => window.__mosaic.whenIdle());

  await page.setInputFiles('#svg-input', svgPath);
  await page.waitForSelector('#artwork-list .artwork-row', { timeout: 180_000 });
  await page.evaluate(() => window.__mosaic.whenIdle());

  const zones = await page.$$eval('#artwork-list .artwork-row .artwork-zone option', (os) =>
    os.map((o) => ({ value: o.value, label: o.textContent })),
  );
  const single = zones.filter((z) => z.value !== '');
  console.log(`zones: ${single.map((z) => z.value).join(', ')}`);

  const runs = [];
  const tris = async () => page.textContent('#stat-tris');
  for (const scale of SCALES) {
    // Bind to one zone before rescaling, so the scale change itself is not timed as an all-zones
    // rebuild and does not land in the numbers below.
    await timeRebuild(page, () =>
      page.selectOption('#artwork-list .artwork-row .artwork-zone', single[0].value),
    );
    await timeRebuild(page, async () => {
      await page.fill('#p-scale-num', String(scale));
      await page.dispatchEvent('#p-scale-num', 'change');
    });
    console.log(`\n--- design scale ${scale}% ---`);
    for (let r = 0; r < REPEATS; r++) {
      for (const z of [...single, { value: '', label: 'All zones' }]) {
        const secs = await timeRebuild(page, () =>
          page.selectOption('#artwork-list .artwork-row .artwork-zone', z.value),
        );
        const t = await tris();
        runs.push({ scale, pass: r, zone: z.value || 'all', secs, tris: t });
        console.log(`  [${r}] ${(z.value || 'all').padEnd(6)} ${secs.toFixed(1)}s   ${t}`);
      }
    }
  }

  // One design per zone, then only the last one rescaled: the edit a volunteer makes most. Timed
  // with afterRebuild, not the curtain: a rebuild that reuses most parts can finish before the
  // curtain would show, and timeRebuild would then sit out its 30s wait.
  const edits = [];
  {
    const { page: p2, errors: errors2 } = await newPage(browser, {
      viewport: { width: 1440, height: 1000 },
    });
    await p2.goto(`http://localhost:${PORT}/?kind=chair-body`);
    await p2.waitForFunction(() => !!window.__mosaic);
    await p2.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
        return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
      },
      null,
      { timeout: 300_000 },
    );
    await p2.evaluate(() => window.__mosaic.whenIdle());
    const rows = p2.locator('#artwork-list .artwork-row');
    for (let i = 0; i < single.length; i++) {
      await afterRebuild(p2, async () => {
        // A buffer, not the path: the input already holding that path fires no second change.
        await p2.setInputFiles('#svg-input', {
          name: `sticker-${i}.svg`,
          mimeType: 'image/svg+xml',
          buffer: Buffer.from(SVG),
        });
        await p2.waitForFunction(
          (n) => document.querySelectorAll('#artwork-list .artwork-row').length >= n,
          i + 1,
          { timeout: 180_000 },
        );
      });
      const sel = rows.nth(i).locator('.artwork-zone');
      if ((await sel.inputValue()) !== single[i].value)
        await afterRebuild(p2, () => sel.selectOption(single[i].value));
    }
    const bound = await p2.$$eval('#artwork-list .artwork-row .artwork-zone', (s) =>
      s.map((x) => x.value),
    );
    console.log(`\n--- one design per zone (${bound.join(', ')}), last one rescaled ---`);
    for (let r = 0; r < REPEATS; r++) {
      const scale = 105 + 5 * r;
      const t0 = Date.now();
      await afterRebuild(p2, async () => {
        await p2.fill('#p-scale-num', String(scale));
        await p2.dispatchEvent('#p-scale-num', 'change');
      });
      const secs = (Date.now() - t0) / 1000;
      const t = await p2.textContent('#stat-tris');
      edits.push({ pass: r, zone: bound[bound.length - 1], scale, secs, tris: t });
      console.log(`  [${r}] scale ${scale}%  ${secs.toFixed(1)}s   ${t}`);
    }
    errors2.forEach((e) => console.log('ERROR (one design per zone)', e));
    await p2.close();
  }

  const warnings = await page.evaluate(() => window.__mosaic.warnings());
  writeFileSync(
    OUT,
    JSON.stringify({ renderer, repeats: REPEATS, runs, edits, warnings }, null, 1),
  );
  console.log(`\nwrote ${OUT}`);
  errors.forEach((e) => console.log('ERROR', e));
} finally {
  if (browser) await browser.close();
  preview.stop();
}
