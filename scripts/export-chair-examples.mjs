// Produce 4-filament chair exports for the human pass that fixes the prime tower.
//
// The chair's plate placement is now baked (src/export/chairPlacement.ts), but the prime/wipe tower
// is not: the reference project it came from is a 1-2 filament print, so its tower was never
// positioned against real multi-color geometry and 10 of its 12 plates carry the untouched preset
// default. There is no way to work the position out from here -- it depends on what the slicer
// actually lays down -- so this script builds the files somebody can open, drag each plate's tower
// into place, and save back. Those saved files are what a follow-up bakes primeTowerDelta from.
//
// It drives the real app rather than calling build3MFCombined directly, on purpose: the point is to
// verify what users will actually get, geometry and all, not what the exporter does in isolation.
//
// The artwork is a plain 3-color tile in Fill mode across all zones. Three is the number that
// matters: body + 3 = 4 filaments, which is an A1's AMS Lite and a U1's four toolheads, and it puts
// every one of them on every zoned part so no plate's tower is sized for fewer swaps than it will
// really see.
//
// Usage:
//   npm run build && node scripts/export-chair-examples.mjs [outDir]
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {
  startPreview,
  launchBrowser,
  newPage,
  settledAfterRebuild as settled,
} from './lib/harness.mjs';

const OUT = process.argv[2] || 'stubs';
mkdirSync(OUT, { recursive: true });
const PORT = 4174;

// printer id -> the filename people will recognise it by
const TARGETS = [
  { printerId: 'bambu-x1c', label: 'a1' },
  { printerId: 'snapmaker-u1', label: 'snapmaker' },
];
const VARIANTS = ['standard', 'kit'];

/**
 * A 3-color tile. Deliberately blocky: broad flat regions survive the conformal warp onto every
 * zone at any scale, so each part reliably ends up carrying all three colors. A detailed motif
 * would leave the smaller parts single-color and understate their tower.
 */
const TEST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="0" y="0" width="60" height="20" fill="#c1272d"/>
  <rect x="0" y="20" width="60" height="20" fill="#f5d020"/>
  <rect x="0" y="40" width="60" height="20" fill="#1e5fa8"/>
</svg>`;

/**
 * Whether wipe_tower_x/y names the tower's center or its origin corner is not pinned down here,
 * and the difference is the tower's whole width — so this checks only that the position is on the
 * bed, not that a particular footprint clears the edge. A tighter test would have to assume one
 * reading, and assuming "center" flags positions a human placed and verified in the slicer (both
 * reference files put a tower at exactly x = 15 on a 256mm bed). The human pass is the real gate;
 * this catches a delta that transferred somewhere impossible.
 */
const onBed = (v, bed) => v >= 0 && v <= bed;

/**
 * Bed size as the span of printable_area's corners, per axis. Both axes matter: the beds shipped
 * today are square, so an X-only reading looks right, but the H2D's 350x320 would accept a tower
 * 20mm off the back of the plate. Bambu Studio also rewrites the area to its own profile on save
 * (the Snapmaker U1's is 0.5x1..270.5x271), which is why this is a span and not the top-right
 * corner.
 */
function plateSize(printableArea) {
  const xs = printableArea.map((p) => Number(p.split('x')[0]));
  const ys = printableArea.map((p) => Number(p.split('x')[1]));
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/**
 * Read back what was actually written: per plate, which parts are on it and how many filaments
 * they use between them. A plate down to one filament gets no prime tower, so there is nothing to
 * position on it — which is the whole reason these files exist. Reporting it here turns "the design
 * only reached one zone" from something you discover after opening four 27MB files in a slicer into
 * a line of output.
 */
async function summarisePlates(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const model = await zip.file('3D/3dmodel.model').async('string');
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
      // the parent object's own extruder=1 is bookkeeping, not a filament the plate prints
      filaments: new Set(ids.flatMap((id) => [...extruders[id]])).size,
      tower: { x: Number(proj.wipe_tower_x[pi]), y: Number(proj.wipe_tower_y[pi]) },
    })),
    items: [...model.matchAll(/<item /g)].length,
  };
}

const svgPath = path.join(OUT, 'chair-example-artwork.svg');
writeFileSync(svgPath, TEST_SVG);

let browser;
const preview = await startPreview({ port: PORT });
try {
  browser = await launchBrowser();

  for (const { printerId, label } of TARGETS) {
    for (const variant of VARIANTS) {
      const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });

      console.log(`\n=== ${label} / ${variant} ===`);
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForFunction(
        () => {
          const t = document.querySelector('#stat-tris')?.textContent || '';
          return t !== '' && t !== '0 tris';
        },
        null,
        { timeout: 90_000 },
      );

      // every chair piece has to be in the scene before artwork can be bound to a zone
      const allPartsLoaded = () =>
        page.waitForFunction(
          () => {
            const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
            return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
          },
          null,
          { timeout: 180_000 },
        );

      console.log('  selecting the chair…');
      await page.selectOption('#shape-kind', 'asm:chair-body');
      await allPartsLoaded();

      console.log(`  variant: ${variant}`);
      await page.check(`input[name="asm-variant"][value="${variant}"]`);
      // the caster pair swaps to the other variant's meshes; wait for them back before any artwork
      await allPartsLoaded();

      console.log('  loading the 3-color test artwork (all zones, fill)…');
      await page.setInputFiles('#svg-input', svgPath);
      await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
      await settled(page);
      // A freshly loaded design binds to the FIRST zone, not all of them, so it has to be moved to
      // "All zones" (the empty-valued option) explicitly. Leaving the default sends every part
      // outside that one zone out body-colored, which reads as a successful export right up until
      // you open it and find ten single-filament plates with no tower to place.
      await page.selectOption('#artwork-list .artwork-row .artwork-zone', '');
      await page.selectOption('#artwork-list .artwork-row .artwork-mode', 'fill');
      await settled(page);

      const bound = await page.$eval('#artwork-list .artwork-row', (r) => ({
        zone: r.querySelector('.artwork-zone')?.value,
        mode: r.querySelector('.artwork-mode')?.value,
      }));
      if (bound.zone !== '' || bound.mode !== 'fill')
        throw new Error(`artwork did not bind: zone=${bound.zone} mode=${bound.mode}`);
      const colors = await page.textContent('#stat-colors');
      console.log(`  zone=all mode=fill, colors detected: ${colors}`);

      console.log(`  printer: ${printerId}`);
      await page.selectOption('#p-printer', printerId);

      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 600_000 }),
        page.click('#btn-export'),
      ]);
      const out = path.join(OUT, `chair-example-${label}-${variant}.3mf`);
      await dl.saveAs(out);
      console.log(`  saved ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);

      const summary = await summarisePlates(out);
      const offBed = [];
      summary.plates.forEach((p, i) => {
        const flag = p.filaments < 2 ? '  <- single filament, no tower' : '';
        const t = p.tower;
        // A tower whose footprint doesn't fit inside the bed can't be printed where it's asked
        // for. Only meaningful on a plate that has a tower at all.
        const fits = onBed(t.x, summary.bedW) && onBed(t.y, summary.bedD);
        if (p.filaments >= 2 && !fits) offBed.push(i + 1);
        console.log(
          `    plate ${String(i + 1).padStart(2)}: ${String(p.filaments)} filament(s)  ` +
            `tower (${t.x.toFixed(1)}, ${t.y.toFixed(1)})${p.filaments >= 2 && !fits ? ' !!' : '  '} ` +
            `${p.parts.join(' + ')}${flag}`,
        );
      });
      // The caster mounts carry no design zones, so their plate is legitimately body-only. Any
      // other single-filament plate means the artwork didn't reach it.
      const bare = summary.plates.filter(
        (p) => p.filaments < 2 && !p.parts.every((n) => n.startsWith('Caster')),
      );
      if (bare.length) {
        console.log(`  FAILED: ${bare.length} plate(s) came out body-only — artwork didn't reach`);
        process.exitCode = 1;
      }
      if (offBed.length) {
        console.log(
          `  FAILED: plate(s) ${offBed.join(', ')} put the tower off the ` +
            `${summary.bedW}x${summary.bedD}mm bed — ` +
            `the verified delta doesn't transfer to this bed size`,
        );
        process.exitCode = 1;
      }

      const warnings = await page.$$eval('#warnings div', (ns) => ns.map((n) => n.textContent));
      warnings.forEach((w) => console.log(`  ! ${w}`));
      errors.forEach((e) => console.log(`  ERROR ${e}`));
      await page.close();
    }
  }
  console.log('\ndone.');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.stop();
  process.exit(process.exitCode ?? 0);
}
