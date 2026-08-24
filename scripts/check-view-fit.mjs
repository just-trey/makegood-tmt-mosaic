// Does the initial camera fit actually contain the model?
//
// Asserts window.__mosaic.modelNdcExtent() — the model's bounding box projected into normalized
// device coords. |x| or |y| over 1 means it is drawn outside the canvas. Reading border pixels
// instead would prove nothing: the scene's 800mm grid reaches every edge regardless.
//
// Usage: npm run build && MOSAIC_GPU=1 node <this> [outDir]
import { mkdirSync } from 'node:fs';
import { startPreview, launchBrowser, newPage, settle, shot } from './lib/harness.mjs';

const OUT = process.argv[2] || 'stubs/view-fit';
mkdirSync(OUT, { recursive: true });
const PORT = 4174;

const KINDS = [
  { id: 'chair-body', parts: 13 },
  { id: 'wheel', parts: 3 },
  { id: 'footrest', parts: 1 },
];
const VIEWPORTS = [
  { label: 'landscape', width: 1600, height: 1100 },
  // 900 is the narrowest the app renders at all — styles.css hides #app below it — so this is
  // the lowest canvas aspect the horizontal half of the fit can ever be asked to handle.
  { label: 'portrait', width: 900, height: 1200 },
];

const preview = await startPreview({ port: PORT });
const browser = await launchBrowser();
const rows = [];
let failed = 0;

try {
  for (const vp of VIEWPORTS) {
    for (const kind of KINDS) {
      const { page, errors } = await newPage(browser, {
        viewport: { width: vp.width, height: vp.height },
      });
      // ?kind= rather than selectOption: a kind withheld from the Part dropdown has no option to
      // select, and main.ts honours the parameter for those too. It also skips building the
      // default part first, which is the whole reason the parameter exists.
      await page.goto(`http://localhost:${PORT}/?kind=${kind.id}`);
      await page.waitForFunction(
        () => {
          const t = document.querySelector('#stat-tris')?.textContent || '';
          return t !== '' && t !== '0 tris';
        },
        null,
        { timeout: 90_000 },
      );
      // Every part in the scene before the extent is read — the whole point of the second half of
      // this fix is that the fit must survive parts arriving one at a time.
      //
      // The count is exact, and the select's value is checked with it: a kind-switch that silently
      // didn't happen (the confirm-dialog bug this PR also fixes in the harness) leaves the PREVIOUS
      // kind loaded, and `>= n` waves that through whenever the previous kind had more parts —
      // chair-body's 13 rows satisfy the wheel's 3, and the run then measures the chair twice while
      // its table says "wheel".
      await page.waitForFunction(
        ({ n, id }) => {
          const sel = document.querySelector('#shape-kind');
          if (!sel || sel.value !== `asm:${id}`) return false;
          const r = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
          return r.length === n && r.every((x) => x.textContent.startsWith('✓'));
        },
        { n: kind.parts, id: kind.id },
        { timeout: 180_000 },
      );
      // settle() rather than whenIdle() raw: it wraps the same hook in a timeout, so a build that
      // never settles fails saying so instead of hanging here until the job is killed.
      await settle(page, `${kind.id} / ${vp.label}`);

      const ndc = await page.evaluate(() => window.__mosaic.modelNdcExtent());
      const fits = ndc && ndc.x <= 1 && ndc.y <= 1;
      // Fitted but tiny is the opposite failure — the regression to watch for on the parts that
      // were already fine.
      const fill = ndc ? Math.max(ndc.x, ndc.y) : 0;
      if (!fits) failed++;
      rows.push({
        view: vp.label,
        kind: kind.id,
        x: ndc ? ndc.x.toFixed(3) : 'null',
        y: ndc ? ndc.y.toFixed(3) : 'null',
        fill: fill.toFixed(3),
        verdict: fits ? 'fits' : 'OVERFLOWS',
      });
      await shot(page, OUT, `${kind.id}-${vp.label}.png`);
      // Counted, not just printed — smoke.mjs already treats a console/page error as a failed run,
      // and a page that threw on the way to its framing has not shown that the framing is right.
      if (errors.length) {
        failed++;
        console.log(`  errors on ${kind.id} / ${vp.label}: ${errors.join(', ')}`);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  preview.stop?.();
}

console.table(rows);
console.log(failed ? `\n${failed} failed (overflowing, or errored)` : '\nall fit, no errors');
process.exit(failed ? 1 : 0);
