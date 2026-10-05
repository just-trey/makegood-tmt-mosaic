// Check that the rebuild runs off the page's thread, on the real app: the page stays responsive,
// Cancel is immediate, and a worker that can't load or dies degrades instead of wedging.
//
//   npm run build && MOSAIC_GPU=1 node scripts/check-rebuild-worker.mjs
//
// Falsifying by design: a build that cuts on the page fails (a), (b) and (d). Measured on main at
// 5c7f898 (before the worker): 720-784ms longest gap, 410-532ms Cancel, nothing to orbit.
//
// (a) Chair, all zones at 400% (~10s). Longest gap between animation frames while the build computes,
//     timed by performance.now() since every rAF callback in a frame shares its start time. The
//     readout's last change splits computing from drawing the result. Then an orbit drag mid-rebuild
//     must move the view.
// (b) Cancel clicked from outside the page, as a person would, 200/450/700ms into the cut phase. An
//     in-page click only fires between tasks, so it never lands inside a long engine call.
// (c) Worker chunk answering 404: the build must still complete, on the page, with no crash pill.
// (d) A worker that loads and then dies: the named warning, curtain down, last scene kept, Export
//     off; the next rebuild starts a fresh worker and cuts.
import { readFileSync } from 'node:fs';
import { startPreview, launchBrowser, newPage, afterRebuild, settle } from './lib/harness.mjs';

// Software rendering caps rAF near 2.5fps (GPU_ARGS in lib/harness.mjs): every gap reads ~400ms.
if (process.env.MOSAIC_GPU !== '1')
  throw new Error('set MOSAIC_GPU=1: rAF-paced timing is meaningless software-rendered');

const PORT = 4198;
const GAP_LIMIT_MS = 100;
const CANCEL_LIMIT_MS = 500;
const WORKER_CHUNK = /\/assets\/buildWorker-[^/]*\.js$/;
const CRASH_PILL = 'The browser stopped partway through cutting the design';
const BANDS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="0" y="0" width="60" height="20" fill="#c1272d"/>
  <rect x="0" y="20" width="60" height="20" fill="#f5d020"/>
  <rect x="0" y="40" width="60" height="20" fill="#1e5fa8"/>
</svg>`;
const SNOOPY = { name: 'snoopy.svg', mimeType: 'image/svg+xml' };

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed++;
};
const curtain = (page, up, timeout) =>
  page.waitForFunction(
    (want) => (document.querySelector('#loading-overlay')?.style.display === 'flex') === want,
    up,
    { timeout },
  );
const setScale = async (page, v) => {
  await page.fill('#p-scale-num', String(v));
  await page.dispatchEvent('#p-scale-num', 'change');
};
const tris = (page) => page.textContent('#stat-tris');
const warnings = (page) => page.evaluate(() => window.__mosaic.warnings());
// The page's own reports of a worker failing are the point of (c) and (d), not errors.
const unexpected = (errors) =>
  errors.filter((e) => !/build worker|buildWorker-|Failed to load resource/.test(e));

async function bareWheel(browser) {
  const { page, errors } = await newPage(browser);
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(
    () => !['', '0 tris'].includes(document.querySelector('#stat-tris')?.textContent || ''),
    null,
    { timeout: 120_000 },
  );
  return { page, errors, bare: await tris(page) };
}

async function responsiveness(page) {
  console.log('(a) main thread during a chair rebuild');
  await page.evaluate(() => {
    const r = (window.__gap = { ticks: [], splitAt: null, upAt: null, downAt: null, text: '' });
    const tick = () => {
      const t = performance.now();
      r.ticks.push(t);
      const up = document.querySelector('#loading-overlay')?.style.display === 'flex';
      if (up && r.upAt === null) r.upAt = t;
      const text = document.querySelector('#loading-text')?.textContent || '';
      if (up && text !== r.text) [r.text, r.splitAt] = [text, t];
      if (!up && r.upAt !== null && r.downAt === null) r.downAt = t;
      if (r.downAt === null || t < r.downAt + 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await setScale(page, 390);
  await curtain(page, true, 30_000);
  await page.waitForFunction(
    () => window.__gap.downAt && performance.now() > window.__gap.downAt + 1600,
    null,
    { timeout: 1_800_000 },
  );
  const g = await page.evaluate(() => {
    const r = window.__gap;
    let computing = 0;
    let after = 0;
    const long = [];
    for (let i = 1; i < r.ticks.length; i++) {
      const [t, d] = [r.ticks[i], r.ticks[i] - r.ticks[i - 1]];
      if (t <= r.upAt) continue;
      if (d > 50) long.push(`${(r.ticks[i - 1] - r.upAt).toFixed(0)}+${d.toFixed(0)}`);
      if (t <= r.splitAt) computing = Math.max(computing, d);
      else after = Math.max(after, d);
    }
    return { computing, after, long, ms: r.downAt - r.upAt, computeMs: r.splitAt - r.upAt };
  });
  console.log(
    `  rebuild ${(g.ms / 1000).toFixed(2)}s, computing ${(g.computeMs / 1000).toFixed(2)}s; ` +
      `longest gap computing ${g.computing.toFixed(0)}ms, drawing and after ${g.after.toFixed(0)}ms`,
  );
  console.log(
    `  gaps over 50ms, start+length in ms from curtain up: ${g.long.join(' ') || 'none'}`,
  );
  check(g.computing < GAP_LIMIT_MS, `longest gap while computing under ${GAP_LIMIT_MS}ms`);

  // Its own rebuild, so the screenshots don't land in the gaps above; the curtain is hidden for
  // the capture only, so its readout can't be what differs. Dragged from empty grid at the corner,
  // clear of the design gizmo, which swallows a drag that starts on it.
  await setScale(page, 395);
  await curtain(page, true, 30_000);
  await page.waitForTimeout(1500);
  const clip = await page.locator('#canvas-host canvas').boundingBox();
  const style = '#loading-overlay { visibility: hidden !important; }';
  const extentBefore = await page.evaluate(() => window.__mosaic.modelNdcExtent());
  const before = await page.screenshot({ clip, style });
  const [x0, y0] = [clip.x + clip.width * 0.88, clip.y + clip.height * 0.88];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 - i * 25, y0 - i * 4);
  await page.mouse.up();
  const after = await page.screenshot({ clip, style });
  const building = await page.evaluate(
    () => document.querySelector('#loading-overlay')?.style.display === 'flex',
  );
  await curtain(page, false, 1_800_000);
  await settle(page, 'orbit rebuild', 1_800_000, { quiet: true });
  check(
    building && !!extentBefore && Buffer.compare(before, after) !== 0,
    'a model is on screen mid-rebuild, and an orbit drag moves it',
  );
}

async function cancelling(page, before) {
  console.log('(b) Cancel in the cut phase');
  const ms = [];
  let btn = null;
  for (const [i, delay] of [200, 450, 700].entries()) {
    await setScale(page, 380 - i * 10);
    await curtain(page, true, 30_000);
    btn ??= await page.locator('#loading-cancel').boundingBox();
    await page.waitForFunction(
      () =>
        Number(/(\d+)%/.exec(document.querySelector('#loading-text')?.textContent)?.[1] ?? 0) >= 42,
      null,
      { timeout: 1_800_000, polling: 20 },
    );
    await page.waitForTimeout(delay);
    const readout = await page.evaluate(() => {
      const run = (window.__cancel = {});
      const down = () => {
        if (document.querySelector('#loading-overlay')?.style.display === 'none')
          run.doneEpoch = performance.timeOrigin + performance.now();
        else requestAnimationFrame(down);
      };
      requestAnimationFrame(down);
      return document.querySelector('#loading-text')?.textContent;
    });
    const clicked = Date.now();
    await page.mouse.click(btn.x + btn.width / 2, btn.y + btn.height / 2);
    await page.waitForFunction(() => window.__cancel.doneEpoch, null, { timeout: 1_800_000 });
    ms.push((await page.evaluate(() => window.__cancel.doneEpoch)) - clicked);
    await settle(page, 'cancel', 1_800_000, { quiet: true });
    console.log(
      `  ${delay}ms past 42% ("${readout}"): curtain gone ${ms.at(-1).toFixed(0)}ms after the click`,
    );
  }
  check(
    ms.every((m) => m < CANCEL_LIMIT_MS),
    `every Cancel under ${CANCEL_LIMIT_MS}ms`,
  );
  await afterRebuild(page, () => setScale(page, 400), { rebuildTimeoutMs: 1_800_000 });
  check((await tris(page)) === before, `the rebuild after them cuts as before (${before})`);
}

async function neverLoads(browser) {
  console.log('(c) worker chunk 404');
  const { page, errors, bare } = await bareWheel(browser);
  await page.route(WORKER_CHUNK, (r) => r.fulfill({ status: 404, body: 'gone' }));
  await afterRebuild(
    page,
    () =>
      page.setInputFiles('#svg-input', {
        ...SNOOPY,
        buffer: readFileSync('stubs/temp/snoopy.svg'),
      }),
    { rebuildTimeoutMs: 300_000 },
  );
  const cut = await tris(page);
  check(
    cut !== bare && !(await warnings(page)).some((w) => w.startsWith(CRASH_PILL)),
    `cut on the page (${cut}), no crash pill`,
  );
  await afterRebuild(page, () => setScale(page, 90), { rebuildTimeoutMs: 300_000 });
  check((await tris(page)) !== cut, 'and keeps cutting on the page');
  check(!unexpected(errors).length, `no other errors ${unexpected(errors).join(' | ')}`);
  await page.close();
}

async function diesMidBuild(browser) {
  console.log('(d) worker dies after loading');
  const { page, errors, bare } = await bareWheel(browser);
  const dies =
    "self.postMessage({ type: 'ready' }, []);" +
    "self.onmessage = () => { throw new Error('forced worker death'); };";
  await page.route(WORKER_CHUNK, (r) =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: dies }),
  );
  await page.setInputFiles('#svg-input', {
    ...SNOOPY,
    buffer: readFileSync('stubs/temp/snoopy.svg'),
  });
  await page
    .waitForFunction(
      (pill) => window.__mosaic.warnings().some((w) => w.startsWith(pill)),
      CRASH_PILL,
      {
        timeout: 120_000,
      },
    )
    .catch(() => {});
  await settle(page, 'crash', 120_000, { quiet: true });
  check(
    (await warnings(page)).some((w) => w.startsWith(CRASH_PILL)),
    'the named warning shows',
  );
  check(
    !(await page.$eval('#loading-overlay', (e) => e.style.display === 'flex')),
    'the curtain is down',
  );
  check((await tris(page)) === bare, 'the last scene stays (the bare part, here)');
  check(await page.$eval('#btn-export', (b) => b.disabled), 'Export is off');
  await page.unroute(WORKER_CHUNK);
  await afterRebuild(page, () => setScale(page, 90), { rebuildTimeoutMs: 300_000 });
  const w = await warnings(page);
  check(
    (await tris(page)) !== bare && !w.some((m) => m.startsWith(CRASH_PILL)),
    'the next rebuild respawns, cuts, and clears it',
  );
  check(!unexpected(errors).length, `no other errors ${unexpected(errors).join(' | ')}`);
  await page.close();
}

const server = await startPreview({ port: PORT });
let browser;
try {
  browser = await launchBrowser();
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
  await settle(page, 'chair loaded', 300_000, { quiet: true });
  await page.setInputFiles('#svg-input', {
    name: 'bands.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(BANDS),
  });
  await page.waitForSelector('#artwork-list .artwork-row', { timeout: 180_000 });
  await settle(page, 'artwork', 300_000, { quiet: true });
  await page.selectOption('#artwork-list .artwork-row .artwork-zone', '');
  await settle(page, 'all zones', 900_000, { quiet: true });
  await setScale(page, 400);
  await settle(page, '400%', 900_000, { quiet: true });
  const full = await tris(page);
  console.log(`chair, all zones at 400%: ${full}, workers: ${page.workers().length}`);
  // Past the autosave the last rebuild armed (persist.ts, 1s), which would land in the gaps.
  await page.waitForTimeout(1500);
  await responsiveness(page);
  await cancelling(page, full);
  check(!errors.length, `no console errors ${errors.join(' | ')}`);
  await page.close();
  await neverLoads(browser);
  await diesMidBuild(browser);
} finally {
  await browser?.close();
  server.stop();
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
