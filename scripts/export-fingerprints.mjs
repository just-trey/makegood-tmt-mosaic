// Drives the built app (dist/) through one wheel export and one chair export and prints each
// file's sha256. The 3MF writer stores entries uncompressed with a fixed date, so two builds that
// cut the same geometry produce the same bytes: run this against the build before a change and
// against the build after it, and `cmp` the files. That is the "exports are byte-identical" claim
// made concrete; #214 measured it with a throwaway script and the next geometry change needed it
// again.
//
// The chair gets a 3-colour SVG with no mm size bound to all zones in Sticker mode (Fill is not
// offered on the chair), so it exercises the auto-fit path, every zone chart, and the baked plate
// placement. The wheel gets the built-in sample artwork.
//
//   npm run build && MOSAIC_GPU=1 node scripts/export-fingerprints.mjs [outDir=stubs/fingerprints]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPreview, launchBrowser, newPage, afterRebuild, settle } from './lib/harness.mjs';

const OUT = path.resolve(process.argv[2] || 'stubs/fingerprints');
mkdirSync(OUT, { recursive: true });
const PORT = 4175;

const TEST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="0" y="0" width="60" height="20" fill="#c1272d"/>
  <rect x="0" y="20" width="60" height="20" fill="#f5d020"/>
  <rect x="0" y="40" width="60" height="20" fill="#1e5fa8"/>
</svg>`;
const svgPath = path.join(OUT, 'artwork.svg');
writeFileSync(svgPath, TEST_SVG);

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const waitTris = (page) =>
  page.waitForFunction(
    () => {
      const t = document.querySelector('#stat-tris')?.textContent || '';
      return t !== '' && t !== '0 tris';
    },
    null,
    { timeout: 90_000 },
  );
async function exportTo(page, file) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 600_000 }),
    page.click('#btn-export'),
  ]);
  await dl.saveAs(file);
  console.log(`${path.basename(file)} sha256=${sha(file)}`);
}

let browser;
const preview = await startPreview({ port: PORT });
try {
  browser = await launchBrowser();

  {
    const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
    console.log('=== wheel (default kind, sample artwork) ===');
    await page.goto(`http://localhost:${PORT}/`);
    await waitTris(page);
    await settle(page, 'initial assembly load');
    await afterRebuild(
      page,
      async () => {
        await page.click('#btn-sample');
        await page.waitForSelector('#color-list .color-row', { timeout: 240_000 });
      },
      { rebuildTimeoutMs: 240_000 },
    );
    await exportTo(page, path.join(OUT, 'wheel.3mf'));
    errors.forEach((e) => console.log(`  ERROR ${e}`));
    await page.close();
  }

  {
    const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
    console.log('=== chair-body (standard, 3-colour sticker on all zones, bambu-x1c) ===');
    await page.goto(`http://localhost:${PORT}/?kind=chair-body`);
    await waitTris(page);
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
        return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
      },
      null,
      { timeout: 180_000 },
    );
    await afterRebuild(page, async () => {
      await page.setInputFiles('#svg-input', svgPath);
      await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
    });
    // A fresh design binds to the first zone; the empty option is "All zones".
    await afterRebuild(page, async () => {
      await page.selectOption('#artwork-list .artwork-row .artwork-zone', '');
    });
    await page.selectOption('#p-printer', 'bambu-x1c');
    await exportTo(page, path.join(OUT, 'chair.3mf'));
    const warnings = await page.$$eval('#warnings div', (ns) => ns.map((n) => n.textContent));
    warnings.forEach((w) => console.log(`  ! ${w}`));
    errors.forEach((e) => console.log(`  ERROR ${e}`));
    await page.close();
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.stop();
  process.exit(process.exitCode ?? 0);
}
