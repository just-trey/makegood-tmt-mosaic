// Check the build worker's part cache on the real chair: an edit to one zone's design re-cuts only
// the parts carrying that zone, and what the replayed parts put on the page and in the file is
// exactly what cutting them again does.
//
//   npm run build && MOSAIC_GPU=1 node scripts/check-part-cache.mjs
//
// Each scene edits one design, exports, then forces every part to be cut again (Depth away and back,
// which is in every part's key) and exports again. The two files and the two warning lists must be
// identical, so a replay that drops or reorders a warning, or hands back a stale mesh, fails here
// however right the viewport looks. Scenes carry the cross-part warnings a replay must reproduce:
// an overlap said by the first part carrying both designs, and torn-sheet pills one part dismisses
// and another raises.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startPreview, launchBrowser, newPage, afterRebuild } from './lib/harness.mjs';

const PORT = 4199;
const T = { rebuildTimeoutMs: 900_000 };
const DINO = readFileSync('stubs/dino ring.svg');

// Which parts carry each zone, from the bake, by the names the part list shows.
const sidecar = JSON.parse(readFileSync('public/stl/chair-body-zones.json', 'utf8'));
const nameOf = Object.fromEntries(
  [
    ...readFileSync('src/assembly/kinds.ts', 'utf8').matchAll(
      /name: '([^']+)',\s*libraryPartId: '([^']+)'/g,
    ),
  ].map(([, name, id]) => [id, name]),
);
const partsOn = (zoneId) =>
  sidecar.zones
    .find((z) => z.id === zoneId)
    .charts.map((c) => nameOf[c.libraryPartId])
    .sort();

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed++;
};
const reuse = (page) => page.evaluate(() => window.__mosaic.buildReuse());
const warnings = (page) => page.evaluate(() => window.__mosaic.warnings());
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

async function exported(page) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 900_000 }),
    page.click('#btn-export'),
  ]);
  const chunks = [];
  for await (const c of await dl.createReadStream()) chunks.push(c);
  return { bytes: Buffer.concat(chunks), warnings: await warnings(page) };
}

async function chair(browser) {
  const { page, errors } = await newPage(browser, { viewport: { width: 1440, height: 900 } });
  await page.goto(`http://localhost:${PORT}/?kind=chair-body`);
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
      return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
    },
    null,
    { timeout: 300_000 },
  );
  await page.evaluate(() => window.__mosaic.whenIdle());
  return { page, errors };
}

async function addDino(page, rows, zone) {
  await afterRebuild(
    page,
    async () => {
      await page.setInputFiles('#svg-input', {
        name: 'dino ring.svg',
        mimeType: 'image/svg+xml',
        buffer: DINO,
      });
      await page.waitForFunction(
        (n) => document.querySelectorAll('#artwork-list .artwork-row').length >= n,
        rows,
        { timeout: 120_000 },
      );
    },
    T,
  );
  const sel = page
    .locator('#artwork-list .artwork-row')
    .nth(rows - 1)
    .locator('.artwork-zone');
  if ((await sel.inputValue()) !== zone) await afterRebuild(page, () => sel.selectOption(zone), T);
}

const setNumber = (page, id, v) =>
  afterRebuild(
    page,
    async () => {
      await page.fill(id, String(v));
      await page.dispatchEvent(id, 'change');
    },
    T,
  );

/** Edit the active design, export, re-cut everything, export again, and compare. */
async function editAndCompare(page, scene, { zone, scale, mustSay }) {
  const all = (await page.$$eval('#assembly-part-list .asm-sum-row', (r) => r.length)) || 0;
  await setNumber(page, '#p-scale-num', scale);
  const r = await reuse(page);
  const want = partsOn(zone);
  console.log(`  cut: ${r.cut.join(', ')}`);
  console.log(`  reused: ${r.reused.length} parts`);
  check(
    JSON.stringify([...r.cut].sort()) === JSON.stringify(want),
    `${scene}: the edit re-cut exactly the parts carrying "${zone}" (${want.join(', ')})`,
  );
  check(
    r.reused.length + r.cut.length === all && r.reused.length > 0,
    `${scene}: every other part was replayed (${r.reused.length} of ${all})`,
  );
  const cached = await exported(page);
  for (const m of mustSay)
    check(
      cached.warnings.some((w) => m.test(w)),
      `${scene}: the scene says what it is meant to exercise (${m})`,
    );

  const depth = await page.inputValue('#p-depth');
  await setNumber(page, '#p-depth', (Number(depth) + 0.05).toFixed(2));
  await setNumber(page, '#p-depth', depth);
  const fresh = await reuse(page);
  check(fresh.reused.length === 0, `${scene}: Depth away and back re-cut every part`);
  const recut = await exported(page);

  console.log(`  3MF replayed ${sha(cached.bytes)} (${cached.bytes.length} B)`);
  console.log(`  3MF re-cut   ${sha(recut.bytes)} (${recut.bytes.length} B)`);
  check(
    Buffer.compare(cached.bytes, recut.bytes) === 0,
    `${scene}: 3MF byte-identical to a re-cut`,
  );
  const same = JSON.stringify(cached.warnings) === JSON.stringify(recut.warnings);
  check(same, `${scene}: warnings identical to a re-cut, in order (${cached.warnings.length})`);
  if (!same) {
    console.log('    replayed:', cached.warnings);
    console.log('    re-cut:  ', recut.warnings);
  }
}

const server = await startPreview({ port: PORT });
let browser;
try {
  browser = await launchBrowser();
  {
    console.log('(a) two designs overlapping on Back, one on Right; Right rescaled');
    const { page, errors } = await chair(browser);
    await addDino(page, 1, 'back');
    await addDino(page, 2, 'back');
    await addDino(page, 3, 'right');
    await editAndCompare(page, '(a)', {
      zone: 'right',
      scale: 120,
      mustSay: [/Two placements of "dino ring\.svg" overlap/],
    });
    check(errors.length === 0, `(a): no page errors${errors.length ? `: ${errors}` : ''}`);
    await page.close();
  }
  {
    console.log(
      '(b) a whole-chair design at 250% (torn sheets), one on Left fender; fender rescaled',
    );
    const { page, errors } = await chair(browser);
    const whole = await page.evaluate(() => window.__mosaic.WHOLE_CHAIR_ZONE);
    await addDino(page, 1, whole);
    await setNumber(page, '#p-scale-num', 250);
    await addDino(page, 2, 'wing-left');
    await editAndCompare(page, '(b)', {
      zone: 'wing-left',
      scale: 130,
      mustSay: [/where the two sheets do not join/],
    });
    check(errors.length === 0, `(b): no page errors${errors.length ? `: ${errors}` : ''}`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.stop();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
