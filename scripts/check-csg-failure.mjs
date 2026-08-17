// Force each assembly CSG failure branch against the REAL Manifold engine and check what the app
// actually exports afterwards.
//
// tests/assembly.test.ts already covers these branches, but only with Manifold.union/.difference/
// .intersection replaced by spies -- so what they prove is that the handler runs, not that the
// engine, the viewport and the exporter survive it. This drives the running app with
// ?csgfault=<point> (src/geometry/csgFault.ts), exports a real 3MF, and asserts the degradation
// that reaches the file.
//
// What stays untested either way is genuinely malformed mesh input: forcing a fault proves the
// handler, not that Manifold rejects any particular real mesh. See docs/tech-debt.md.
//
// Usage:
//   npm run build && node scripts/check-csg-failure.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPreview, launchBrowser, newPage, afterRebuild } from './lib/harness.mjs';
import { partSummaries } from './lib/threemf.mjs';

const OUT = process.argv[2] || 'stubs/csg-failure';
mkdirSync(OUT, { recursive: true });
const PORT = 4175;

// Two flat colors, so a fault that drops one color leaves an observable survivor.
const TEST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="5" y="5" width="50" height="22" fill="#c1272d"/>
  <rect x="5" y="33" width="50" height="22" fill="#1e5fa8"/>
</svg>`;

const total = (parts) => parts.reduce((n, s) => n + s.inlayCount, 0);
const tris = (parts) => parts.reduce((n, s) => n + s.bodyTris, 0);

/**
 * What each fault must do to the exported file.
 *
 * The baselines run first and calibrate the rest -- undamaged exports of the same artwork, one per
 * artwork count in use. Asserting against a measured baseline rather than against literals is what
 * makes "one color dropped" and "this body was left uncut" real measurements, and it proves the
 * harness can tell damaged from undamaged at all.
 *
 * `color-union` is the only case needing two artworks: it merges one color's prisms across zones,
 * so a single artwork leaves every color with one prism and Manifold.union is never reached. The
 * fault sits inside that branch, so with one artwork it simply never fires and the case would come
 * out identical to the baseline. It is also the only case armed with a `:1` limit, because that is
 * what makes the point observable: exactly one color is dropped and the survivors have to still
 * cut. Unlimited, it drops every color on every part and the result is indistinguishable from the
 * part-union case.
 *
 * `part-union` is the mirror image of that, and the reason its check is per-part rather than
 * whole-file: the part-wide merge only runs on a part carrying two or more colors, so on this
 * artwork only the Cap reaches it. A part the fault cannot touch has to come out byte-for-byte as
 * the baseline did, which is the stronger statement -- "the failure stayed inside the part it
 * happened on" -- and the assertion below makes it, instead of the weaker "everything went uncut"
 * that only held while the fault was armed ahead of the branch it stands for.
 *
 * The rest need one artwork only -- the test SVG has two colors, so the body cut and the per-color
 * inlay loop both run for real on every part.
 *
 * First full run (wheel, the two-color SVG above), all five branches confirmed degrading as
 * documented. Body triangle counts are the measurement worth keeping, because they are what
 * distinguishes the two outcomes that otherwise look identical in the file (one body, no inlays):
 *
 *   fault                       total inlays   body triangles
 *   none (baseline, 1 artwork)  4              45,214
 *   color-union:1 (2 artwork)   3 of 4         --
 *   part-union                  2 of 4         45,166  Cap uncut
 *   difference                  0              44,930  uncut
 *   body-mesh                   0              44,930  uncut
 *   intersection                0              45,214  still cut
 *
 * `intersection` matching the baseline exactly is the point: its pocket really is cut and only the
 * fill failed, which is the "prints as an empty recess" outcome in docs/troubleshooting.md. A
 * change collapsing it into the export-uncut path would show up here as 44,930 and nowhere else.
 */
const CASES = [
  {
    point: null,
    artworks: 1,
    expect: 'every part fully cut and inlaid — baseline for the single-artwork faults',
    check: (parts, base) => parts.every((s) => s.bodyCount === 1) && base.inlays > 0,
  },
  {
    point: null,
    artworks: 2,
    expect: 'every part fully cut and inlaid — baseline for color-union',
    check: (parts, base) => parts.every((s) => s.bodyCount === 1) && base.inlays > 0,
  },
  {
    point: 'color-union:1',
    artworks: 2,
    expect: 'exactly one color dropped; every other color on every part still cut',
    warn: /couldn't merge color/i,
    warnCount: 1,
    check: (parts, base) =>
      parts.every((s) => s.bodyCount === 1) && total(parts) === base.inlays - 1,
  },
  {
    point: 'part-union',
    artworks: 1,
    expect: 'multi-color parts exported uncut and inlay-less; single-color parts untouched',
    warn: /couldn't merge the recesses/i,
    check: (parts, base) =>
      // Vacuous unless some part actually merged two prisms — otherwise nothing was forced at all.
      parts.some((s) => base.part(s).inlayCount > 1) &&
      parts.every((s) => {
        const b = base.part(s);
        return b.inlayCount > 1
          ? s.bodyCount === 1 && s.inlayCount === 0 && s.bodyTris < b.bodyTris
          : s.inlayCount === b.inlayCount && s.bodyTris === b.bodyTris;
      }),
  },
  {
    point: 'difference',
    artworks: 1,
    expect: 'every part exported uncut and inlay-less (no overlapping pair)',
    warn: /couldn't cut the recesses/i,
    check: (parts, base) => total(parts) === 0 && tris(parts) < base.tris,
  },
  {
    point: 'body-mesh',
    artworks: 1,
    expect: 'same as difference, but the freed-handle path ran',
    warn: /couldn't cut the recesses/i,
    check: (parts, base) => total(parts) === 0 && tris(parts) < base.tris,
  },
  {
    // The one case that must NOT come out uncut: the pocket is already cut and only the fill
    // failed, so the body has to still carry every triangle the baseline's did.
    point: 'intersection',
    artworks: 1,
    expect: 'body still cut (recesses ship empty), no inlays',
    warn: /couldn't fit the inlay/i,
    check: (parts, base) => total(parts) === 0 && tris(parts) === base.tris,
  },
];

// Distinct filenames on purpose: re-selecting the same path on the same <input type="file"> fires
// no second change event, so a second artwork row never appears and the wait below hangs.
const svgPaths = [1, 2].map((n) => {
  const p = path.join(OUT, `csg-check-artwork-${n}.svg`);
  writeFileSync(p, TEST_SVG);
  return p;
});

let browser;
let failures = 0;
let pageErrors = 0;
const baselines = new Map();
const preview = await startPreview({ port: PORT });
try {
  browser = await launchBrowser();

  for (const c of CASES) {
    const { page, errors } = await newPage(browser);
    console.log(`\n=== ${c.point ? `?csgfault=${c.point}` : 'baseline (no fault)'} ===`);
    console.log(`  expecting: ${c.expect}`);

    await page.goto(`http://localhost:${PORT}/${c.point ? `?csgfault=${c.point}` : ''}`);
    await page.waitForFunction(
      () => {
        const t = document.querySelector('#stat-tris')?.textContent || '';
        return t !== '' && t !== '0 tris';
      },
      null,
      { timeout: 90_000 },
    );

    for (let i = 0; i < c.artworks; i++) {
      await afterRebuild(page, async () => {
        await page.setInputFiles('#svg-input', svgPaths[i]);
        await page.waitForFunction(
          (n) => document.querySelectorAll('#artwork-list .artwork-row').length >= n,
          i + 1,
          { timeout: 120_000 },
        );
      });
    }

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 600_000 }),
      page.click('#btn-export'),
    ]);
    const out = path.join(
      OUT,
      `csg-${(c.point ?? `baseline-${c.artworks}art`).replace(':', '-')}.3mf`,
    );
    await dl.saveAs(out);

    const summaries = await partSummaries(out);
    // Read the notice list itself, not the pills: the panel renders only the first 6 plus an
    // overflow pill (src/ui/warningsView.ts), and the intersection case already emits 5. A case
    // that warned past the cap would otherwise be reported as having degraded silently -- the
    // worse of the two bugs this script exists to catch.
    const all = await page.evaluate(() => window.__mosaic.warnings());
    const armedNotice = all.some((w) => /fault injection is armed/i.test(w));
    // The armed-fault notice is this script's own doing; only real degradation warnings count.
    const warnings = all.filter((w) => !/fault injection is armed/i.test(w));

    summaries.forEach((s) =>
      console.log(`    ${s.name}: body×${s.bodyCount}, inlay×${s.inlayCount}`),
    );
    console.log(`    total inlays: ${total(summaries)}, body triangles: ${tris(summaries)}`);
    warnings.forEach((w) => console.log(`  ! ${w}`));

    if (!c.point) {
      const byName = new Map(summaries.map((s) => [s.name, s]));
      baselines.set(c.artworks, {
        inlays: total(summaries),
        tris: tris(summaries),
        // A part missing from the baseline means the two runs exported different parts, which is
        // its own failure -- don't let it read as "this part is unchanged".
        part: (s) => {
          const b = byName.get(s.name);
          if (!b) throw new Error(`part "${s.name}" has no baseline — the exports disagree`);
          return b;
        },
      });
    }
    // Every check is relative to a measured baseline, so a case with no baseline for its artwork
    // count can't be judged at all. Say that, rather than substituting zeros and reporting a
    // geometry failure that is really a missing measurement.
    const baseline = baselines.get(c.artworks);

    // Checked at the end of the run, not at page load: the artwork load in between calls
    // clearWarnings(), so this is the state that matters -- an armed build has to still say so
    // once it is showing the damage, or nobody can tell it from a genuinely broken one.
    if (armedNotice !== !!c.point) {
      console.log(
        armedNotice
          ? '  FAILED: unarmed build claims a CSG fault is armed'
          : '  FAILED: armed build no longer says so — the notice did not survive the SVG load',
      );
      failures++;
    }

    // A check that throws (a part with no baseline) is this case failing, not the run collapsing.
    let checkErr = null;
    const checkOk =
      !!baseline &&
      (() => {
        try {
          return c.check(summaries, baseline);
        } catch (e) {
          checkErr = e.message;
          return false;
        }
      })();

    const matched = c.warn ? warnings.filter((w) => c.warn.test(w)) : [];
    if (!baseline) {
      console.log(`  FAILED: no baseline measured for ${c.artworks} artwork(s) — add that case`);
      failures++;
    } else if (!summaries.length) {
      console.log('  FAILED: nothing was exported at all');
      failures++;
    } else if (c.warn && !matched.length) {
      console.log(`  FAILED: degraded silently — no warning matching ${c.warn}`);
      failures++;
    } else if (c.warnCount !== undefined && matched.length !== c.warnCount) {
      console.log(`  FAILED: expected ${c.warnCount} matching warning(s), got ${matched.length}`);
      failures++;
    } else if (!checkOk) {
      console.log(
        `  FAILED: ${checkErr ?? 'exported file does not match the expected degradation'}`,
      );
      failures++;
    } else {
      console.log('  OK');
    }
    // Counted apart from the checks. A page error is a real failure, but rolling it into
    // "N check(s) FAILED" says a degradation assertion was wrong when it wasn't, and sends the
    // reader to the geometry instead of the console. This exact conflation cost a debugging pass:
    // a run reported "1 check(s) FAILED" with every case printing OK.
    errors.forEach((e) => {
      console.log(`  ERROR ${e}`);
      pageErrors++;
    });
    await page.close();
  }

  const parts = [];
  if (failures) parts.push(`${failures} check(s) FAILED`);
  if (pageErrors) parts.push(`${pageErrors} console/page error(s)`);
  console.log(parts.length ? `\n${parts.join(', ')}.` : '\nAll CSG failure branches OK.');
  if (failures || pageErrors) process.exitCode = 1;
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.stop();
  process.exit(process.exitCode ?? 0);
}
