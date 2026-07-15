// End-to-end smoke test: serves dist/ with vite preview, drives the app in headless
// Chromium, and exercises assembly auto-load -> sample SVG -> CSG build -> 3MF export,
// then flat (disc) mode -> rebuild -> STL zip export.
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '.';
mkdirSync(OUT, { recursive: true });
const PORT = 4173;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('preview server never came up');
}

const server = spawn(`npx vite preview --port ${PORT} --strictPort`, {
  shell: true,
  stdio: 'ignore',
});

const errors = [];
// Third-party analytics beacons report to a cross-origin endpoint bound to the production
// hostname, so on localhost they CORS-fail by design — that's expected here and unrelated to
// the app, so filter their console/network noise out of the smoke assertion.
const IGNORE_HOSTS = ['cloudflareinsights.com'];
const isIgnored = (text, url) =>
  IGNORE_HOSTS.some((h) => (text && text.includes(h)) || (url && url.includes(h)));
let browser;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (isIgnored(m.text(), m.location()?.url)) return;
    errors.push('[console] ' + m.text());
  });
  page.on('pageerror', (e) => {
    if (isIgnored(e.message)) return;
    errors.push('[pageerror] ' + e.message);
  });

  console.log('1. loading app (assembly mode auto-load)…');
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#stat-tris')?.textContent || '';
      return t !== '' && t !== '0 tris';
    },
    { timeout: 90_000 },
  );
  console.log('   wheel loaded:', await page.textContent('#stat-tris'));
  await sleep(1500); // let the first frame render
  await page.screenshot({ path: path.join(OUT, '1-assembly-loaded.png') });

  console.log('2. loading sample artwork (triggers Manifold CSG build)…');
  await page.click('#btn-sample');
  await page.waitForSelector('#color-list .color-row', { timeout: 240_000 });
  await page.waitForFunction(() => !document.querySelector('#btn-export')?.disabled, {
    timeout: 240_000,
  });
  console.log('   colors:', await page.textContent('#stat-colors'));
  console.log('   slots:', await page.textContent('#slot-count'));
  await sleep(1000);
  await page.screenshot({ path: path.join(OUT, '2-assembly-artwork.png') });

  console.log('3. base color picker…');
  await page.click('.base-swatch:nth-child(4)'); // pick "Red"
  await page.waitForFunction(() => !document.querySelector('#btn-export')?.disabled, {
    timeout: 240_000,
  });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '3-base-color.png') });

  console.log('4. exporting assembly 3MF…');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 240_000 }),
    page.click('#btn-export'),
  ]);
  const f3mf = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(f3mf);
  console.log('   saved', dl.suggestedFilename(), statSync(f3mf).size, 'bytes');

  console.log('5. switching to disc (flat) mode…');
  await page.selectOption('#shape-kind', 'disc');
  await page.waitForFunction(() => !document.querySelector('#btn-export-stl')?.disabled, {
    timeout: 60_000,
  });
  const rows = await page.locator('#color-list .color-row').count();
  console.log(
    '   flat rebuild done, color rows:',
    rows,
    '| tris:',
    await page.textContent('#stat-tris'),
  );
  await sleep(800);
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
  await bgRow.locator('.depth-input').fill('2.5');
  await bgRow.locator('.depth-input').dispatchEvent('change');
  await sleep(1200);
  console.log('   background depth set to 2.5 (mesh should recess deeper)');
  await page.screenshot({ path: path.join(OUT, '5-bg-depth.png') });

  console.log('7. exporting flat 3MF + STL zip…');
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.click('#btn-export'),
  ]);
  const fplate = path.join(OUT, 'flat-' + dl2.suggestedFilename());
  await dl2.saveAs(fplate);
  console.log('   saved', dl2.suggestedFilename(), statSync(fplate).size, 'bytes');
  const [dl3] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.click('#btn-export-stl'),
  ]);
  const fzip = path.join(OUT, dl3.suggestedFilename());
  await dl3.saveAs(fzip);
  console.log('   saved', dl3.suggestedFilename(), statSync(fzip).size, 'bytes');

  console.log(
    '\nRESULT:',
    errors.length ? 'CONSOLE/PAGE ERRORS FOUND' : 'clean — no console or page errors',
  );
  errors.forEach((e) => console.log('  ', e.slice(0, 300)));
  process.exitCode = errors.length ? 1 : 0;
} catch (e) {
  console.error('SMOKE FAIL:', e.message);
  errors.forEach((er) => console.log('  ', er.slice(0, 300)));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  process.exit(process.exitCode ?? 0);
}
