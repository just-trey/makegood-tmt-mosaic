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
import { startPreview, launchBrowser, newPage, settle, afterRebuild } from './lib/harness.mjs';

const OUT = process.argv[2] || 'stubs/hubcap-exports';
mkdirSync(OUT, { recursive: true });
const PORT = 4174;

const TARGETS = [
  { printerId: 'bambu-x1c', label: 'x1c', bed: [256, 256] },
  { printerId: 'snapmaker-u1', label: 'snapmaker', bed: [270, 270] },
  { printerId: 'bambu-h2d', label: 'h2d', bed: [350, 320] },
];
// The size the app loads with, one well under it, and one above the verified 220mm so the
// unverified fallback gets exercised. 240 rather than 250: the diameter is capped at the plate
// less PLATE_EDGE_MARGIN_MM on each side, so 250 no longer survives on a 256mm bed.
const DIAMETERS = [220, 180, 240];
/** Matches the app's own ceiling, so the skip below agrees with what the control will allow. */
const PLATE_EDGE_MARGIN_MM = 5;

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

/**
 * The plate arrangements a human verified in the slicer, straight off the reference projects
 * (stubs/mosaic-hubcap.3mf, stubs/mosaic-hubcap-snap.3mf) — Snapmaker converted from its own plate
 * origin of (0.5, 1). Written out here rather than imported from src/, so this checks the app's
 * output against the references and not against the same constants that produced it.
 */
const VERIFIED = {
  '256x256': { part: { x: 141.192, y: 142.3629 }, tower: { x: 16.8181, y: 31.8954 }, width: '35' },
  '270x270': { part: { x: 149.5842, y: 148.0757 }, tower: { x: 27.5488, y: 27.8477 }, width: '30' },
};
/** Above this the arrangement wasn't verified and the export should fall back to computing one. */
const VERIFIED_DIAMETER = 220;

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
  const model = await zip.file('3D/3dmodel.model').async('string');
  const items = [...model.matchAll(/<item[^>]*transform="([^"]+)"/g)].map((m) => {
    const t = m[1].split(/\s+/).map(Number);
    return { x: t[9], y: t[10] };
  });
  return {
    bedW,
    bedD,
    items,
    towerWidth: proj.prime_tower_width,
    overrides: proj.different_settings_to_system?.[0] ?? '',
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
      if (diameter > Math.min(...bed) - 2 * PLATE_EDGE_MARGIN_MM) {
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

      // The control must not report itself invalid. `min` is the step base, so any fixed step
      // puts the valid values on a grid offset by a measured constant and the default diameter
      // falls between two of them — silently :invalid on load.
      const valid = await page.$eval('#p-asm-buildparam', (i) => i.checkValidity());
      if (!valid) {
        console.log('   !! diameter field reports :invalid');
        failed++;
      }

      // The 1:1 template must be rebuilt for the size now set. It is only true-to-size for the
      // diameter it was generated at, and it used to be re-issued on kind switch alone — so
      // changing the size handed out the previous size's drawing, at 1:1, with no sign of it.
      const tplW = await page.$eval('#asm-template-link', async (a) => {
        const svg = await (await fetch(a.href)).text();
        return Number(/width="([\d.]+)mm"/.exec(svg)?.[1] ?? NaN);
      });
      const expectW = diameter - 2; // the flat design face: the disc less its 1mm chamfer all round
      if (Math.abs(tplW - expectW) > 0.05) {
        console.log(
          `   !! template is ${tplW}mm wide, expected ${expectW}mm for a ${diameter}mm disc`,
        );
        failed++;
      } else {
        console.log(`  template: ${tplW}mm design face (disc ${diameter}mm less the chamfer)`);
      }

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
      await afterRebuild(page, async () => {
        await page.setInputFiles('#svg-input', svgPath);
        await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
      });

      const file = path.join(OUT, `hubcap-${label}-${String(diameter).replace('.', '_')}mm.3mf`);
      const dl = page.waitForEvent('download', { timeout: 180_000 });
      await page.click('#btn-export');
      await (await dl).saveAs(file);

      const s = await summarise(file);
      console.log(`  bed read back: ${s.bedW}x${s.bedD}mm, ${s.plates.length} plate(s)`);

      // Did the export reproduce the arrangement a human verified in the slicer, or fall back?
      const bedKey = `${s.bedW}x${s.bedD}`;
      const v = VERIFIED[bedKey];
      const shouldUseVerified = !!v && diameter <= VERIFIED_DIAMETER;
      const at = s.items[0];
      const t0 = s.plates[0]?.tower;
      // A plate whose every corner is blocked writes no wipe_tower key at all now, rather than
      // pinning a position the exporter knows collides — so an absent tower is a real outcome and
      // has to come with the warning that explains it.
      const noTower = !Number.isFinite(t0?.x);
      if (noTower) {
        // The no-position arm specifically. The message has two, chosen by whether the export
        // wrote a tower position for any plate, and `noTower` here means it did not — so matching
        // the "move the tower" arm made this permanently false and failed the run on exactly the
        // unverified-bed path it exists to check.
        const warned = (await page.evaluate(() => window.__mosaic.warnings())).some((w) =>
          w.includes('No tower position was saved'),
        );
        console.log(`  no tower position written (every corner blocked), warned: ${warned}`);
        if (!warned) {
          console.log('   !! no tower position and no warning either');
          failed++;
        }
      }
      if (shouldUseVerified) {
        if (noTower) {
          console.log('   !! a verified plate must carry its verified tower');
          failed++;
        }
        const off = Math.hypot(at.x - v.part.x, at.y - v.part.y);
        const toff = Math.hypot(t0.x - v.tower.x, t0.y - v.tower.y);
        console.log(
          `  VERIFIED plate: part (${at.x.toFixed(3)}, ${at.y.toFixed(3)}), ` +
            `tower (${t0.x.toFixed(3)}, ${t0.y.toFixed(3)}), width ${s.towerWidth}`,
        );
        if (off > 0.01 || toff > 0.01) {
          console.log(
            `   !! off the verified arrangement by ${off.toFixed(3)}mm / ${toff.toFixed(3)}mm`,
          );
          failed++;
        }
        if (s.towerWidth !== v.width) {
          console.log(`   !! prime_tower_width is ${s.towerWidth}, verified at ${v.width}`);
          failed++;
        }
        // written but not declared an override, the slicer can reconcile it away on resave
        if (!s.overrides.split(';').includes('prime_tower_width')) {
          console.log(`   !! prime_tower_width not in different_settings_to_system`);
          failed++;
        }
        // the whole point: the tower's nearest corner must clear the disc
        const near = { x: v.tower.x + Number(v.width), y: v.tower.y + Number(v.width) };
        const gap = Math.hypot(v.part.x - near.x, v.part.y - near.y) - diameter / 2;
        console.log(`  tower clears the disc by ${gap.toFixed(1)}mm`);
        if (gap < 1) {
          console.log(`   !! tower overlaps the disc`);
          failed++;
        }
      } else {
        // no verified arrangement for this bed/size — must centre and say so
        const centred = Math.hypot(at.x - s.bedW / 2, at.y - s.bedD / 2);
        console.log(
          `  computed plate (nothing verified here): part (${at.x.toFixed(3)}, ${at.y.toFixed(3)})` +
            `, tower ${noTower ? 'not written' : `(${t0.x.toFixed(3)}, ${t0.y.toFixed(3)})`}`,
        );
        if (centred > 0.5) {
          console.log(`   !! expected the part centred, it is ${centred.toFixed(2)}mm off`);
          failed++;
        }
        // when a tower IS written on an unverified plate, it must still be a usable corner
        if (!noTower && (t0.x < 20 || t0.y < 20)) {
          console.log(`   !! tower at (${t0.x}, ${t0.y}) is against the bed edge`);
          failed++;
        }
      }
      for (const [i, p] of s.plates.entries()) {
        const fits = cornerTower(s.bedW, s.bedD, diameter);
        console.log(
          `   plate ${i + 1}: ${p.parts.join(', ')} — ${p.filaments} filament(s), ` +
            `tower at (${p.tower.x?.toFixed(1)}, ${p.tower.y?.toFixed(1)}); ` +
            `a corner fits a ${fits.toFixed(1)}mm square tower`,
        );
        if (
          Number.isFinite(p.tower.x) &&
          !(p.tower.x >= 0 && p.tower.x <= s.bedW && p.tower.y >= 0 && p.tower.y <= s.bedD)
        ) {
          console.log('   !! tower is off the bed');
          failed++;
        }
        // the tower must not have been parked on the plate centre, i.e. through the part
        if (
          Number.isFinite(p.tower.x) &&
          Math.abs(p.tower.x - s.bedW / 2) < 1 &&
          Math.abs(p.tower.y - s.bedD / 2) < 1
        ) {
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
