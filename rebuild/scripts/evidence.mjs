// Drives the built app through EVAL.md's scenarios in headless Chromium and saves what came out
// under evidence/: the exported 3MFs, a screenshot per scenario, and RESULTS.md with timings and
// the warnings the tool showed. Run: npm run evidence (builds first).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'evidence');
const ART = path.join(ROOT, 'reference', 'artwork');
mkdirSync(OUT, { recursive: true });
const PORT = 4179;

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const exe = process.env.CHROME_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

const results = [];
const ready = (t = 300000) => page.waitForFunction(() => document.querySelector('#status .status-text')?.textContent === 'Ready', null, { timeout: t });
const settle = async () => { await page.waitForTimeout(400); await ready(); };
const warnings = () => page.$$eval('#warnings .warning', (els) => els.map((e) => e.textContent));
const setNumber = async (sel, v) => { await page.fill(sel, String(v)); await page.press(sel, 'Enter'); await page.$eval(sel, (e) => e.blur()); };
const load = async (file) => { await page.setInputFiles('#sec-design input[type=file]', path.join(ART, file)); await settle(); };
const exportTo = async (name) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#btn-export')]);
  await dl.saveAs(path.join(OUT, name));
  return name;
};
const fresh = async () => {
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready();
};
const summary = () => page.$eval('.summary', (e) => e.textContent).catch(() => '');

async function scenario(id, title, fn) {
  const t0 = Date.now();
  let status = 'pass', note = '';
  try {
    note = (await fn()) ?? '';
  } catch (e) {
    status = 'fail';
    note = String(e && e.message ? e.message : e).slice(0, 300);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  await page.screenshot({ path: path.join(OUT, `${id}.png`) }).catch(() => {});
  results.push({ id, title, status, secs, note, warnings: status === 'fail' ? [] : await warnings().catch(() => []) });
  console.log(id, status, secs + 's', note);
}

await scenario('S1', 'Two-color SVG on the wheel', async () => {
  await fresh();
  await load('cow.svg');
  await setNumber('#fit-scale-n', 230);
  await settle();
  const file = await exportTo('S1-wheel-cow-x1c.3mf');
  return `${file} · ${await summary()}`;
});

await scenario('S2', 'Traced logo on a hubcap, cut to silhouette', async () => {
  await fresh();
  await page.selectOption('#part-kind', 'hubcap');
  await settle();
  await setNumber('#hubcap-mm', 180);
  await settle();
  await load('makegood-logo.png');
  await setNumber('#fit-scale-n', 160);
  await settle();
  await page.check('#hubcap-cut');
  await settle();
  await page.selectOption('#automerge', 'strong');
  await settle();
  await page.selectOption('#printer', 'snapmaker-u1');
  await settle();
  // Still over four? Merge the smallest slots by hand into the next one, as a volunteer would.
  for (let guard = 0; guard < 4; guard++) {
    const slots = await page.$$eval('#sec-colors .slot', (els) => els.length - 1);
    if (slots + 1 <= 4) break;
    await page.$eval('#sec-colors .slot:last-of-type select', (sel) => { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
  }
  const file = await exportTo('S2-hubcap-logo-silhouette-u1.3mf');
  return `${file} · ${await summary()}`;
});

await scenario('S3', 'Repeating fill on the footrest', async () => {
  await fresh();
  await page.selectOption('#part-kind', 'footrest');
  await settle();
  await load('zebra.svg');
  await page.check('.design.active input[type=radio] >> nth=1');
  await settle();
  await setNumber('#fit-scale-n', 67);
  await settle();
  const file = await exportTo('S3-footrest-zebra-fill-x1c.3mf');
  return `${file} · 40 mm tiles (zebra is 60 mm at 67%) · ${await summary()}`;
});

await scenario('S4', 'Depth guards', async () => {
  await fresh();
  await load('cow.svg');
  await setNumber('#depth', 0);
  await settle();
  const w0 = await warnings();
  await setNumber('#depth', 60);
  await settle();
  const w60 = await warnings();
  writeFileSync(path.join(OUT, 'S4-depth-guards.json'), JSON.stringify({ depth0: w0, depth60: w60 }, null, 2));
  const ok0 = w0.some((w) => /0 cuts nothing/.test(w));
  const ok60 = w60.some((w) => /shallower|too thin/.test(w));
  if (!ok0 || !ok60) throw new Error(`guard text missing: 0→${ok0} 60→${ok60}`);
  await exportTo('S4-wheel-cow-depth60-x1c.3mf');
  return 'both guards fired; see S4-depth-guards.json';
});

await scenario('S5', 'Unsupported SVG content', async () => {
  await fresh();
  await load('gradient.svg');
  const rowWarn = await page.$$eval('.design .warn', (els) => els.map((e) => e.textContent));
  if (!rowWarn.some((w) => /gradient/.test(w))) throw new Error('no gradient warning shown');
  const file = await exportTo('S5-wheel-gradient-x1c.3mf');
  return `${file} · ${rowWarn.join(' | ')}`;
});

await scenario('S6', 'Design across a chair join', async () => {
  await fresh();
  await page.selectOption('#part-kind', 'chair');
  await settle();
  await page.selectOption('#part-surface', 'left');
  await settle();
  const [tpl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-template')]);
  await tpl.saveAs(path.join(OUT, 'S6-chair-left-template.svg'));
  await load('tiger.svg');
  await setNumber('#fit-scale-n', 300);
  await settle();
  const file = await exportTo('S6-chair-left-tiger-x1c.3mf');
  return `${file} · ${await summary()}`;
});

await scenario('S7', 'Photograph down to four slots (synthetic photo: the kit ships none)', async () => {
  await fresh();
  // No photograph in the reference set, so a photo-like JPEG (soft gradients plus noise) is made here.
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(320, 220, 20, 320, 240, 360);
    grad.addColorStop(0, '#f2c9a0'); grad.addColorStop(0.5, '#7a4b2a'); grad.addColorStop(1, '#1d2b3a');
    g.fillStyle = grad; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#2b6cb0'; g.beginPath(); g.ellipse(200, 300, 120, 70, 0.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e2e8f0'; g.beginPath(); g.arc(430, 160, 70, 0, Math.PI * 2); g.fill();
    const img = g.getImageData(0, 0, 640, 480);
    for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 40; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.85);
  });
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  const tmp = path.join(OUT, 'S7-synthetic-photo.jpg');
  writeFileSync(tmp, buf);
  await page.setInputFiles('#sec-design input[type=file]', tmp);
  await settle();
  await page.fill('.design.active input[id^=colors-]', '3');
  await page.dispatchEvent('.design.active input[id^=colors-]', 'change');
  await settle();
  const file = await exportTo('S7-wheel-photo-3colors-x1c.3mf');
  const info = await page.$eval('.design.active .note:last-of-type', (e) => e.textContent).catch(() => '');
  return `${file} · ${info} · ${await summary()}`;
});

await scenario('S8', 'Session restore', async () => {
  await fresh();
  await load('cow.svg');
  await setNumber('#fit-x', 30);
  await setNumber('#fit-rot-n', 25);
  await settle();
  await page.waitForTimeout(1200);
  await page.reload();
  await ready();
  await page.click('#btn-restore');
  await settle();
  const x = await page.$eval('#fit-x', (e) => e.value);
  const rot = await page.$eval('#fit-rot-n', (e) => e.value);
  const name = await page.$eval('.design .name', (e) => e.textContent);
  if (x !== '30' || rot !== '25' || !/cow/.test(name)) throw new Error(`restored x=${x} rot=${rot} name=${name}`);
  return `restored cow.svg at x=30, rotation=25 after reload`;
});

await browser.close();
server.kill();

const lines = ['# Evidence run', '', `Generated by \`npm run evidence\` on ${new Date().toISOString()}. Headless Chromium, software GL.`, '', '| Scenario | Result | Seconds | Output |', '| --- | --- | --- | --- |'];
for (const r of results) lines.push(`| ${r.id} ${r.title} | ${r.status} | ${r.secs} | ${r.note.replace(/\|/g, '/')} |`);
lines.push('', '## Warnings shown per scenario', '');
for (const r of results) {
  lines.push(`### ${r.id}`, '');
  if (r.warnings.length === 0) lines.push('- (none)');
  for (const w of r.warnings) lines.push(`- ${w}`);
  lines.push('');
}
if (errors.length) lines.push('## Page errors', '', ...errors.map((e) => `- ${e}`), '');
writeFileSync(path.join(OUT, 'RESULTS.md'), lines.join('\n'));
console.log('wrote', path.join(OUT, 'RESULTS.md'));
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
