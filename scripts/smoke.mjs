// End-to-end smoke test: serves dist/ with vite preview, drives the app in headless
// Chromium, and exercises assembly auto-load -> sample SVG -> CSG build -> 3MF export,
// then flat (disc) mode -> rebuild -> STL zip export, then a PNG through the raster path.
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import JSZip from 'jszip';
import path from 'node:path';
import { startPreview, launchPage, afterRebuild, settle } from './lib/harness.mjs';
import { partSummaries, plateSummary } from './lib/threemf.mjs';
import { encodePNG } from './lib/png.mjs';

const OUT = process.argv[2] || '.';
mkdirSync(OUT, { recursive: true });
const PORT = 4173;

let browser;
let errors = [];
const preview = await startPreview({ port: PORT });
try {
  const launched = await launchPage({ viewport: { width: 1440, height: 900 } });
  browser = launched.browser;
  const page = launched.page;
  errors = launched.errors;

  console.log('1. loading app (assembly mode auto-load)…');
  await page.goto(`http://localhost:${PORT}/`);
  // Both halves, per check-view-fit.mjs: a non-zero triangle count is satisfied by any kind, so
  // changing ASSEMBLY_KINDS[0] would leave this passing while the log says "wheel" and the
  // screenshots show something else.
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#stat-tris')?.textContent || '';
      return t !== '' && t !== '0 tris';
    },
    { timeout: 90_000 },
  );
  // #stat-tris goes non-zero on the assembly's FIRST loaded part, so it says "something arrived",
  // not "the wheel finished loading". settle() waits the app's own outstanding-work counter to
  // zero, which covers the remaining part fetches and the rebuild they trigger; without it the log
  // line and the screenshot below can both describe a half-loaded assembly.
  await settle(page, 'initial assembly load');
  const kind = await page.$eval('#shape-kind', (n) => n.value);
  if (kind !== 'asm:wheel') errors.push(`expected the wheel to auto-load, got kind "${kind}"`);
  console.log(`   ${kind} loaded:`, await page.textContent('#stat-tris'));
  await page.screenshot({ path: path.join(OUT, '1-assembly-loaded.png') });

  // The left panel is a fixed 340px, so a control row that doesn't fit is clipped at every window
  // size rather than only narrow ones — and what gets cut is the unit suffix at the end of the row,
  // the smallest and least noticeable part of it. Offset X/Y lost their "mm" this way. Checked
  // against the panel's own edge rather than by eye, since 2px of a "%" is easy to miss.
  const clipped = await page.evaluate(() => {
    const panel = document.querySelector('#left');
    const edge = panel.getBoundingClientRect().right - 14; // minus the panel's padding
    return [...document.querySelectorAll('#left .row')]
      .map((row) => {
        const hint = row.querySelector(':scope > .hint');
        if (!hint || !hint.textContent.trim()) return null;
        const past = +(hint.getBoundingClientRect().right - edge).toFixed(1);
        const cut = hint.scrollWidth > hint.clientWidth + 0.5;
        if (past <= 0 && !cut) return null;
        return `${row.querySelector('label')?.textContent?.trim() || '?'} "${hint.textContent.trim()}" (${past}px past the edge)`;
      })
      .filter(Boolean);
  });
  if (clipped.length) {
    errors.push(`clipped unit labels in the left panel: ${clipped.join('; ')}`);
    console.log(`   CLIPPED: ${clipped.join('; ')}`);
  } else {
    console.log('   left-panel unit labels all fit');
  }

  console.log('2. loading sample artwork (triggers Manifold CSG build)…');
  await afterRebuild(
    page,
    async () => {
      await page.click('#btn-sample');
      await page.waitForSelector('#color-list .color-row', { timeout: 240_000 });
    },
    { rebuildTimeoutMs: 240_000 },
  );
  console.log('   colors:', await page.textContent('#stat-colors'));
  console.log('   slots:', await page.textContent('#slot-count'));
  await page.screenshot({ path: path.join(OUT, '2-assembly-artwork.png') });

  console.log('3. base color picker…');
  await afterRebuild(page, () => page.click('.base-swatch:nth-child(4)'), {
    rebuildTimeoutMs: 240_000,
  }); // pick "Red"
  await page.screenshot({ path: path.join(OUT, '3-base-color.png') });

  console.log('4. exporting assembly 3MF…');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 240_000 }),
    page.click('#btn-export'),
  ]);
  const f3mf = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(f3mf);
  // Look inside it. A download event fires for an export that wrote one empty plate, dropped
  // every inlay, or lost the filament table, and `size` goes into a log nobody diffs.
  const asm = await partSummaries(f3mf);
  const plates = await plateSummary(f3mf);
  console.log(
    `   saved ${dl.suggestedFilename()} ${statSync(f3mf).size} bytes — ${asm.length} parts, ` +
      `${plates.plates.length} plate(s), ${plates.filaments} filaments`,
  );
  if (asm.length !== 3) errors.push(`assembly 3MF has ${asm.length} parts, expected the wheel's 3`);
  for (const p of asm) {
    if (p.bodyCount !== 1) errors.push(`"${p.name}" exported ${p.bodyCount} bodies, expected 1`);
    if (p.inlayCount < 1) errors.push(`"${p.name}" exported no inlays, so it prints uncoloured`);
    if (p.bodyTris < 1) errors.push(`"${p.name}" exported an empty body mesh`);
  }
  if (plates.filaments < 2)
    errors.push(`assembly 3MF maps ${plates.filaments} filament(s); a multicolor export needs 2+`);
  // The plate list is the half a part-level check cannot see: an export that wrote one empty
  // plate, or dropped a plate's objects, still ships three well-formed parts.
  if (!plates.plates.length) errors.push('assembly 3MF has no plates');
  plates.plates.forEach((pl, i) => {
    if (!pl.parts.length) errors.push(`assembly 3MF plate ${i + 1} is empty`);
  });
  if (plates.items !== asm.length)
    errors.push(`assembly 3MF has ${plates.items} build items for ${asm.length} parts`);

  console.log('5. switching to disc (flat) mode…');
  await afterRebuild(page, () => page.selectOption('#shape-kind', 'disc'), {
    rebuildTimeoutMs: 60_000,
  });
  const rows = await page.locator('#color-list .color-row').count();
  console.log(
    '   flat rebuild done, color rows:',
    rows,
    '| tris:',
    await page.textContent('#stat-tris'),
  );
  await page.screenshot({ path: path.join(OUT, '4-flat-disc.png') });

  console.log('6. overriding the background recess depth (flat mode)…');
  await page.check('#p-recess-bg');
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('#color-list .color-row .hex')];
      return rows.some((r) => r.textContent === 'Background');
    },
    { timeout: 60_000 },
  );
  const bgRow = page.locator('#color-list .color-row', { hasText: 'Background' });
  await afterRebuild(
    page,
    async () => {
      await bgRow.locator('.depth-input').fill('2.5');
      await bgRow.locator('.depth-input').dispatchEvent('change');
    },
    { rebuildTimeoutMs: 60_000 },
  );
  console.log('   background depth set to 2.5 (mesh should recess deeper)');
  await page.screenshot({ path: path.join(OUT, '5-bg-depth.png') });

  console.log('7. exporting flat 3MF + STL zip…');
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.click('#btn-export'),
  ]);
  const fplate = path.join(OUT, 'flat-' + dl2.suggestedFilename());
  await dl2.saveAs(fplate);
  const flat = await partSummaries(fplate);
  console.log(
    `   saved ${dl2.suggestedFilename()} ${statSync(fplate).size} bytes — ` +
      `${flat.length} object(s), ${flat[0]?.inlayCount ?? 0} inlays`,
  );
  if (flat.length !== 1) errors.push(`flat 3MF has ${flat.length} objects, expected 1`);
  if ((flat[0]?.inlayCount ?? 0) < 2)
    errors.push(
      `flat 3MF carries ${flat[0]?.inlayCount ?? 0} colour plugs, expected one per colour`,
    );
  const [dl3] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.click('#btn-export-stl'),
  ]);
  const fzip = path.join(OUT, dl3.suggestedFilename());
  await dl3.saveAs(fzip);
  const zipped = Object.keys((await JSZip.loadAsync(readFileSync(fzip))).files);
  console.log(
    `   saved ${dl3.suggestedFilename()} ${statSync(fzip).size} bytes — ${zipped.length} entries`,
  );
  if (!zipped.some((n) => /base\.stl$/i.test(n)))
    errors.push(`STL zip has no base.stl (entries: ${zipped.join(', ') || 'none'})`);
  const stls = zipped.filter((n) => /\.stl$/i.test(n)).length;
  if (stls < 3)
    errors.push(`STL zip has ${stls} .stl entries, expected base.stl plus one per colour`);

  console.log('8. loading a PNG as artwork (browser decode + quantize + trace)…');
  // Three flat bands, so the trace has an unambiguous answer to check against.
  const png = encodePNG(96, 96, (x) =>
    x < 32 ? [230, 60, 60, 255] : x < 64 ? [40, 130, 220, 255] : [250, 205, 80, 255],
  );
  await afterRebuild(
    page,
    async () => {
      await page.setInputFiles('#svg-input', {
        name: 'smoke-bands.png',
        mimeType: 'image/png',
        buffer: png,
      });
      await page.waitForSelector('.artwork-raster .raster-colors', { timeout: 120_000 });
    },
    { rebuildTimeoutMs: 240_000 },
  );
  const readout = await page.textContent('.artwork-raster .raster-readout');
  const traced = parseInt(readout, 10);
  if (!(traced >= 2)) errors.push(`PNG traced no usable palette (readout: ${readout})`);
  // Count the artwork's own rows rather than reading either summary number. Both of those count
  // the Background row this step has switched on, so neither equals the tracer's palette, and
  // inferring one from a summary string is what tied this check to a particular meaning of the
  // word "colors" (it broke when the slot line started counting the recess). The rows are the
  // property being asserted: every traced colour reached the list. They only appear once the
  // color list re-renders, which lands after the raster readout, so wait rather than reading the
  // previous design's.
  const artworkRows = () =>
    page.$$eval('#color-list .color-row:not(.is-base) .hex', (ns) =>
      ns.map((n) => n.textContent).filter((t) => t !== 'Background'),
    );
  await page
    .waitForFunction(
      (n) =>
        [...document.querySelectorAll('#color-list .color-row:not(.is-base) .hex')].filter(
          (e) => e.textContent !== 'Background',
        ).length === n,
      traced,
      { timeout: 120_000 },
    )
    .catch(() => {});
  const slotText = await page.textContent('#slot-count');
  const statColors = await page.textContent('#stat-colors');
  console.log('   traced:', readout, '| slots:', slotText, '| header:', statColors);
  const shown = (await artworkRows()).length;
  if (shown !== traced)
    errors.push(
      `traced ${traced} colors but the color list shows ${shown} artwork rows ("${slotText}")`,
    );
  await page.screenshot({ path: path.join(OUT, '6-raster-artwork.png') });

  // Nothing in this flow should need a confirmation, and the harness auto-accepts any that appear,
  // so without counting them "none was needed" and "one was silently clicked away" are the same
  // observation. If a step starts prompting, this is what notices.
  const confirms = await page.confirmsAccepted();
  if (confirms !== 0) errors.push(`${confirms} confirmation(s) were auto-accepted during the run`);

  console.log(
    '\nRESULT:',
    errors.length ? 'PROBLEMS FOUND' : 'clean — no console or page errors, no clipped labels',
  );
  errors.forEach((e) => console.log('  ', e.slice(0, 300)));
  process.exitCode = errors.length ? 1 : 0;
} catch (e) {
  console.error('SMOKE FAIL:', e.message);
  errors.forEach((er) => console.log('  ', er.slice(0, 300)));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.stop();
  process.exit(process.exitCode ?? 0);
}
