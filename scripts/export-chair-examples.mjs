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
// The artwork is 3-color diagonal stripes as a Sticker on all zones (the chair withholds Fill, so
// there is no mode to set). Three is the number that matters: body + 3 = 4 filaments, which is an
// A1's AMS Lite and a U1's four toolheads, and it puts every one of them on every zoned part so no
// plate's tower is sized for fewer swaps than it will really see.
//
// Usage:
//   npm run build && node scripts/export-chair-examples.mjs [outDir]
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { startPreview, launchBrowser, newPage, afterRebuild } from './lib/harness.mjs';

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
 * Diagonal 3-color stripes, sized in mm so a zone maps it 1:1 (an SVG with no mm size is auto-fit
 * to the whole zone instead, and each stripe then spans a quarter of a zone: the storage boxes saw
 * one or two colors). 30mm stripes cross every zone, the 44mm-wide fenders and the storage boxes
 * on the flanks included; a horizontal stripe can miss a narrow part entirely.
 */
const STRIPE_COLORS = ['#c1272d', '#f5d020', '#1e5fa8'];
const SIZE_MM = 700; // bigger than the largest zone (642 x 509), which centers the SVG on its chart
const STRIPE_MM = 30;

/** The part of SIZE_MM's square where lo <= x + y <= hi, as an SVG polygon. */
function stripe(lo, hi, fill) {
  let poly = [
    [0, 0],
    [SIZE_MM, 0],
    [SIZE_MM, SIZE_MM],
    [0, SIZE_MM],
  ];
  const keep = (f) => {
    poly = poly.flatMap((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const [fp, fq] = [f(p), f(q)];
      const cut =
        fp >= 0 !== fq >= 0
          ? [[p[0] + (fp / (fp - fq)) * (q[0] - p[0]), p[1] + (fp / (fp - fq)) * (q[1] - p[1])]]
          : [];
      return fp >= 0 ? [p, ...cut] : cut;
    });
  };
  keep(([x, y]) => x + y - lo);
  keep(([x, y]) => hi - (x + y));
  return poly.length > 2
    ? `<polygon points="${poly.map((p) => p.join(',')).join(' ')}" fill="${fill}"/>`
    : '';
}

const TEST_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE_MM}mm" height="${SIZE_MM}mm" viewBox="0 0 ${SIZE_MM} ${SIZE_MM}">` +
  Array.from({ length: Math.ceil((2 * SIZE_MM) / STRIPE_MM) }, (_, k) =>
    stripe(k * STRIPE_MM, (k + 1) * STRIPE_MM, STRIPE_COLORS[k % 3]),
  ).join('') +
  '</svg>';

/**
 * wipe_tower_x/y is the tower's front-left corner (both reference files put one at x = 15 on a
 * 256mm bed). Only the corner is checked: the chair export writes no prime_tower_width, so there
 * is no footprint to test, and the human pass is the real gate.
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
      // ?kind= rather than a selectOption below: it lands on the chair without building the wheel
      // first, which is minutes of CSG this script has no use for. The chair is offered in the Part
      // dropdown now, so selecting it would also work — just slower.
      await page.goto(`http://localhost:${PORT}/?kind=chair-body`);
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

      console.log('  waiting for the chair…');
      await allPartsLoaded();

      console.log(`  variant: ${variant}`);
      await page.check(`input[name="asm-variant"][value="${variant}"]`);
      // the caster pair swaps to the other variant's meshes; wait for them back before any artwork
      await allPartsLoaded();

      console.log('  loading the 3-color test artwork (all zones)…');
      await afterRebuild(page, async () => {
        await page.setInputFiles('#svg-input', svgPath);
        await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
      });
      // A freshly loaded design binds to the FIRST zone, not all of them, so it has to be moved to
      // "All zones" (the empty-valued option) explicitly. Leaving the default sends every part
      // outside that one zone out body-colored, which reads as a successful export right up until
      // you open it and find ten single-filament plates with no tower to place.
      await afterRebuild(page, async () => {
        await page.selectOption('#artwork-list .artwork-row .artwork-zone', '');
      });

      const zone = await page.$eval(
        '#artwork-list .artwork-row .artwork-zone',
        (el) => /** @type {HTMLSelectElement} */ (el).value,
      );
      if (zone !== '') throw new Error(`artwork did not bind to all zones: zone=${zone}`);
      const colors = await page.textContent('#stat-colors');
      console.log(`  zone=all, colors detected: ${colors}`);

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
      // The caster mounts and the seat pan are in no design zone, so their plates are legitimately
      // body-only. Every other plate must carry body + all three colors, or its tower is sized
      // for fewer swaps than a real print sees.
      const zoneless = (n) => n.startsWith('Caster') || n === 'Seat center';
      const short = summary.plates.filter((p) => p.filaments < 4 && !p.parts.every(zoneless));
      if (short.length) {
        console.log(
          `  FAILED: ${short.length} plate(s) carry fewer than 4 filaments — artwork didn't reach`,
        );
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
