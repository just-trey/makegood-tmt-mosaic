// Live check for the px-only SVG sizing fix: an Affinity re-export of our own footrest template
// must land on the footrest face, not at 75% of it.
//
// Written to falsify. It measures the inlay geometry in the exported 3MF, which is what actually
// prints, rather than asserting that some warning mentions the face — a check that passes happily
// while the artwork is a quarter too small.
//
// The artwork in every case is the template's own face outline, so a correct placement fills the
// 266 x 185mm design face. The regression put it at 199.8 x 138.9mm.
//
// The px fixtures are generated here from the shipped template rather than read from `stubs/`,
// which is gitignored: a check whose inputs only exist on one machine is not a check.
//
// Usage: npm run build && MOSAIC_GPU=1 node scripts/check-px-only-svg.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { startPreview, launchBrowser, newPage, afterRebuild, shot } from './lib/harness.mjs';

const PORT = 4176;
const OUT = process.argv[2] || 'stubs/px-only-svg';
mkdirSync(OUT, { recursive: true });

const TEMPLATE = 'public/templates/footrest-template.svg';
const PT_PER_MM = 72 / 25.4; // 2.834646, the matrix Affinity writes at 72dpi

/**
 * Rewrite the shipped 266x185mm template the way Affinity re-exports it: mm coordinates wrapped in
 * a 72dpi matrix, the size restated in px, and the viewBox either dropped (its default) or rewritten
 * to match the px box ("Set viewBox" ticked). Both readings used to land at ~75%.
 *
 * The px numbers are rounded up to whole pixels, as Affinity does, which is why the artwork comes
 * back 265.65mm and not a flat 266: 266mm is 754.02px and the sheet is written as 755.
 */
function affinityExport(withViewBox) {
  const src = readFileSync(TEMPLATE, 'utf8');
  const body = src.slice(src.indexOf('>', src.indexOf('<svg')) + 1, src.lastIndexOf('</svg>'));
  const w = Math.ceil(266 * PT_PER_MM);
  const h = Math.ceil(185 * PT_PER_MM);
  const vb = withViewBox ? ` viewBox="0 0 ${w} ${h}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}px" height="${h}px"${vb}>` +
    `<g transform="matrix(${PT_PER_MM},0,0,${PT_PER_MM},0,0)">${body}</g></svg>`
  );
}

function generated(name, svgText) {
  const p = path.join(OUT, `${name}.svg`);
  writeFileSync(p, svgText);
  return p;
}

const CASES = [
  {
    name: 'affinity-px',
    file: generated('affinity-px', affinityExport(false)),
    // no viewBox, width="755px" at the document's 72dpi. The sheet is 755x525px for 754.02x524.41
    // of content, so fitting it to the face lands 0.13% shy: ~265.6 x 184.8mm.
    expect: { w: 265.65, h: 184.76, tol: 0.2, notice: true },
  },
  {
    name: 'shipped-template',
    file: TEMPLATE,
    // declares width="266mm": a real measurement, so it must NOT take the new branch
    expect: { w: 266.0, h: 185.0, tol: 0.2, notice: false },
  },
  {
    name: 'affinity-px-viewbox',
    file: generated('affinity-px-viewbox', affinityExport(true)),
    // the same export with "Set viewBox" ticked: width="755px" AND viewBox="0 0 755 525".
    // 755px over 755 units cancels to the 96dpi constant, so this was silently 199.5mm too.
    expect: { w: 265.65, h: 184.76, tol: 0.2, notice: true },
  },
  {
    name: 'viewbox-no-size',
    // the pre-existing fallback: no declared size at all, but a viewBox. Meet-fits to the shorter
    // axis of the 266x185 face, so a square design comes out 185 x 185mm. Unchanged by this fix,
    // and here to prove it.
    file: generated(
      'viewbox-no-size',
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 60 60">' +
        '<rect x="0" y="0" width="60" height="20" fill="#c1272d"/>' +
        '<rect x="0" y="20" width="60" height="20" fill="#f5d020"/>' +
        '<rect x="0" y="40" width="60" height="20" fill="#1e5fa8"/></svg>',
    ),
    expect: { w: 185.0, h: 185.0, tol: 0.2, notice: true },
  },
];

/**
 * The design's real extent in the export: the union of every inlay's X/Z, in mm.
 *
 * X and Z, not X and Y: the footrest lies face-up, so 3MF Y is the recess axis and every inlay
 * measures 1.00mm on it whatever the placement. Reading Y here reports the recess depth and
 * passes at any scale.
 *
 * Names come from the config's `<part>` entries, not its `<object>` entry. The export nests the
 * inlays as component objects under one named object, so an object-level lookup finds only
 * "Footrest" and measures the body's own outline instead of the artwork.
 */
async function inlayExtentMM(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const model = await zip.file('3D/3dmodel.model').async('string');
  const cfg = await zip.file('Metadata/model_settings.config').async('string');

  const name = {};
  for (const m of cfg.matchAll(/<part id="(\d+)"[\s\S]*?<metadata key="name" value="([^"]*)"/g))
    name[m[1]] = m[2];

  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  const measured = [];
  for (const o of model.matchAll(/<object id="(\d+)"[\s\S]*?<\/object>/g)) {
    const nm = name[o[1]];
    if (!nm || nm === 'Body') continue;
    measured.push(nm);
    for (const v of o[0].matchAll(/<vertex x="([-\d.eE]+)" y="([-\d.eE]+)" z="([-\d.eE]+)"/g)) {
      const x = Number(v[1]),
        z = Number(v[3]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!measured.length) throw new Error('no inlay objects in the export');
  return { w: maxX - minX, h: maxZ - minZ, names: measured };
}

let browser;
const preview = await startPreview({ port: PORT });
let failed = 0;
try {
  browser = await launchBrowser();

  for (const c of CASES) {
    const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
    console.log(`\n=== ${c.name} (${c.file}) ===`);
    await page.goto(`http://localhost:${PORT}/?kind=footrest`);
    await page.waitForFunction(
      () => {
        const t = document.querySelector('#stat-tris')?.textContent || '';
        return t !== '' && t !== '0 tris';
      },
      null,
      { timeout: 90_000 },
    );
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
        return rows.length >= 1 && rows.every((r) => r.textContent.startsWith('✓'));
      },
      null,
      { timeout: 180_000 },
    );

    await afterRebuild(page, async () => {
      await page.setInputFiles('#svg-input', path.resolve(c.file));
      await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
    });

    const warnings = await page.evaluate(() => window.__mosaic.warnings());
    const sawNotice = warnings.some((w) => /no size in millimeters/i.test(w));
    await shot(page, OUT, `${c.name}.png`);

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 600_000 }),
      page.click('#btn-export'),
    ]);
    const out = path.join(OUT, `${c.name}.3mf`);
    await dl.saveAs(out);
    const ext = await inlayExtentMM(out);

    console.log(`  inlay extent: ${ext.w.toFixed(2)} x ${ext.h.toFixed(2)}mm`);
    console.log(`  inlays measured: ${ext.names.join(', ')}`);
    console.log(`  size notice shown: ${sawNotice}`);
    if (warnings.length) console.log('  warnings:', warnings);
    if (errors.length) console.log('  console errors:', errors);

    const ok =
      Math.abs(ext.w - c.expect.w) <= c.expect.tol &&
      Math.abs(ext.h - c.expect.h) <= c.expect.tol &&
      sawNotice === c.expect.notice;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} (expected ~${c.expect.w} x ${c.expect.h}mm ` +
        `+-${c.expect.tol}, notice=${c.expect.notice})`,
    );
    if (!ok) failed++;
    await page.close();
  }
} finally {
  await browser?.close();
  await preview?.stop?.();
}
console.log(failed ? `\n${failed} case(s) FAILED` : '\nall cases passed');
process.exit(failed ? 1 : 0);
