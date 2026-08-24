// End-to-end smoke test: serves dist/ with vite preview, drives the app in headless
// Chromium, and exercises assembly auto-load -> sample SVG -> CSG build -> 3MF export,
// then a PNG through the raster path.
import { mkdirSync, statSync } from 'node:fs';
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

  // The flat-plate modes are no longer reachable from the Part dropdown (docs/tech-debt.md), so
  // four steps here — switch to disc, override the background recess depth, export a flat 3MF,
  // export the per-color STL zip — drove UI that no longer exists. `tests/flat.test.ts` and
  // `tests/depth.test.ts` still cover that geometry. "Recess bg too" went with them rather than
  // moving to the assembly part: `recessBg` is read only inside flat.ts, so the Background row it
  // waits for is never produced on a real part (see docs/tech-debt.md).

  console.log('5. loading a PNG as artwork (browser decode + quantize + trace)…');
  // The sample SVG from step 2 comes off first. Designs stack rather than replace, so leaving it
  // loaded puts its colours in the same list, and the assertion below — every traced colour
  // reached the list — would be comparing the tracer's palette against both designs' rows. The
  // old flow got this for free from a step that switched part shape in between.
  // Not wrapped in afterRebuild: removing the only design leaves nothing to build, so the rebuild
  // counter never moves and the wrapper waits out its whole timeout. The row going is the signal.
  await page.click('#artwork-list .artwork-row .artwork-remove');
  await page.waitForFunction(
    () => document.querySelectorAll('#artwork-list .artwork-row').length === 0,
    null,
    { timeout: 60_000 },
  );
  await settle(page, 'artwork cleared');
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
  // Count the artwork's own rows rather than reading either summary number. Neither equals the
  // tracer's palette, and
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
  await page.screenshot({ path: path.join(OUT, '4-raster-artwork.png') });

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
