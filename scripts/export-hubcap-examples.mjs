// Produce hubcap exports for the human pass that fixes the prime tower.
//
// The hubcap disc is GENERATED at whatever diameter the user picks, so unlike every other part it
// can never carry a baked plate pose: a pose is verified against one exact mesh, and this one is
// built to vary (see 'generated-part' in src/export/placement.ts). What a human can still settle is
// where the tower goes as a function of size, which is what these files are for — open each, drag
// the tower into place, and note the position against the diameter.
//
// It drives the real app rather than calling build3MFCombined directly, on purpose: the point is to
// verify what a user actually gets, generated geometry and all, not what the exporter does alone.
//
// Usage:
//   npm run build && MOSAIC_GPU=1 node scripts/export-hubcap-examples.mjs [outDir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {
  startPreview,
  launchBrowser,
  newPage,
  settle,
  settledAfterRebuild as settledExportable,
} from './lib/harness.mjs';

const OUT = process.argv[2] || 'stubs/hubcap-exports';
mkdirSync(OUT, { recursive: true });
const PORT = 4174;

const TARGETS = [
  { printerId: 'bambu-x1c', label: 'x1c', bed: [256, 256] },
  { printerId: 'snapmaker-u1', label: 'snapmaker', bed: [270, 270] },
  { printerId: 'bambu-h2d', label: 'h2d', bed: [350, 320] },
];
// the reference size, one well under it, and one at the 256 bed's limit
const DIAMETERS = [220.75, 180, 250];

/** Three broad bands — enough filaments that a tower is actually printed and sized realistically. */
const TEST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="0" y="0" width="60" height="20" fill="#c1272d"/>
  <rect x="0" y="20" width="60" height="20" fill="#f5d020"/>
  <rect x="0" y="40" width="60" height="20" fill="#1e5fa8"/>
</svg>`;

/**
 * Largest square prime tower that tucks into a plate corner clear of a centred disc. The app's own
 * suggestTowerPos probes a part's BOUNDING BOX, which for a circle always reports every corner
 * occupied; this reports what a round part actually leaves, which is the number the human pass
 * needs. Printed alongside the warning rather than replacing it.
 */
const cornerTower = (bedW, bedD, diameter) =>
  (Math.hypot(bedW / 2, bedD / 2) - diameter / 2) / Math.SQRT2;

function plateSize(printableArea) {
  const xs = printableArea.map((p) => Number(p.split('x')[0]));
  const ys = printableArea.map((p) => Number(p.split('x')[1]));
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/** Read back what was written: parts per plate, filament count, and the tower position. */
async function summarise(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const cfg = await zip.file('Metadata/model_settings.config').async('string');
  const name = {};
  const extruders = {};
  for (const m of cfg.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    name[m[1]] = m[2].match(/<metadata key="name" value="([^"]*)"/)?.[1] ?? '?';
    extruders[m[1]] = new Set(
      [...m[2].matchAll(/<metadata key="extruder" value="(\d+)"\/>/g)].map((e) => e[1]),
    );
  }
  const plates = [...cfg.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((p) =>
    [...p[1].matchAll(/key="object_id" value="(\d+)"/g)].map((o) => o[1]),
  );
  const proj = JSON.parse(await zip.file('Metadata/project_settings.config').async('string'));
  const [bedW, bedD] = plateSize(proj.printable_area);
  return {
    bedW,
    bedD,
    plates: plates.map((ids, pi) => ({
      parts: ids.map((id) => name[id]),
      filaments: new Set(ids.flatMap((id) => [...extruders[id]])).size,
      tower: { x: Number(proj.wipe_tower_x?.[pi]), y: Number(proj.wipe_tower_y?.[pi]) },
    })),
  };
}

const svgPath = path.join(OUT, 'hubcap-artwork.svg');
writeFileSync(svgPath, TEST_SVG);

let browser;
let failed = 0;
const preview = await startPreview({ port: PORT });
try {
  browser = await launchBrowser();

  for (const { printerId, label, bed } of TARGETS) {
    for (const diameter of DIAMETERS) {
      if (diameter > Math.min(...bed)) {
        console.log(
          `\n=== ${label} / ${diameter}mm — skipped, wider than the ${bed.join('x')} bed`,
        );
        continue;
      }
      const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
      console.log(`\n=== ${label} (${bed.join('x')}) / ${diameter}mm ===`);
      await page.goto(`http://localhost:${PORT}/?kind=hubcap`);
      await page.waitForFunction(
        () => {
          const t = document.querySelector('#stat-tris')?.textContent || '';
          return t !== '' && t !== '0 tris';
        },
        null,
        { timeout: 90_000 },
      );

      const kind = await page.$eval('#shape-kind', (s) => s.value);
      if (kind !== 'asm:hubcap') throw new Error(`?kind=hubcap did not select the hubcap: ${kind}`);

      await page.selectOption('#p-printer', printerId);
      // settle(), not settledAfterRebuild(): #btn-export stays disabled until a build produces
      // output, which needs artwork — so the export-button leg of that helper can't be met yet.
      await settle(page, 'printer switch');

      // the diameter control commits on `change`, not per keystroke
      await page.fill('#p-asm-buildparam', String(diameter));
      await page.dispatchEvent('#p-asm-buildparam', 'change');
      await settle(page, 'diameter change');
      const shown = Number(await page.inputValue('#p-asm-buildparam'));
      if (Math.abs(shown - diameter) > 0.01)
        throw new Error(`diameter clamped to ${shown}, expected ${diameter}`);

      // The design face must be the disc's TOP, not its (larger) underside. The option text
      // carries the patch normal, so this reads the actual detected face rather than assuming
      // preferFaceNormal took effect — which is the whole thing that could silently be wrong.
      const face = await page.$eval(
        '#assembly-part-list select[data-asm="patchIdx"]',
        (s) => s.selectedOptions[0]?.textContent ?? '',
      );
      console.log(`  design face: ${face.trim()}`);
      if (!/normal\s*0\.00,1\.00,0\.00/.test(face)) {
        console.log('   !! design face is not the +Y top face');
        failed++;
      }

      console.log('  loading 3-color artwork…');
      await page.setInputFiles('#svg-input', svgPath);
      await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
      await settledExportable(page);

      const file = path.join(OUT, `hubcap-${label}-${String(diameter).replace('.', '_')}mm.3mf`);
      const dl = page.waitForEvent('download', { timeout: 180_000 });
      await page.click('#btn-export');
      await (await dl).saveAs(file);

      const s = await summarise(file);
      console.log(`  bed read back: ${s.bedW}x${s.bedD}mm, ${s.plates.length} plate(s)`);
      for (const [i, p] of s.plates.entries()) {
        const fits = cornerTower(s.bedW, s.bedD, diameter);
        console.log(
          `   plate ${i + 1}: ${p.parts.join(', ')} — ${p.filaments} filament(s), ` +
            `tower at (${p.tower.x?.toFixed(1)}, ${p.tower.y?.toFixed(1)}); ` +
            `a corner fits a ${fits.toFixed(1)}mm square tower`,
        );
        if (!(p.tower.x >= 0 && p.tower.x <= s.bedW && p.tower.y >= 0 && p.tower.y <= s.bedD)) {
          console.log('   !! tower is off the bed');
          failed++;
        }
        // the tower must not have been parked on the plate centre, i.e. through the part
        if (Math.abs(p.tower.x - s.bedW / 2) < 1 && Math.abs(p.tower.y - s.bedD / 2) < 1) {
          console.log('   !! tower is at the plate centre — straight through the disc');
          failed++;
        }
      }

      const warnings = await page.evaluate(() => window.__mosaic.warnings());
      warnings.forEach((w) => console.log(`   note: ${w}`));
      if (errors.length) {
        errors.forEach((e) => console.log(`   !! console error: ${e}`));
        failed += errors.length;
      }
      await page.close();
    }
  }
} finally {
  await browser?.close();
  preview.stop();
}

console.log(failed ? `\nRESULT: ${failed} problem(s)` : '\nRESULT: clean');
process.exit(failed ? 1 : 0);
