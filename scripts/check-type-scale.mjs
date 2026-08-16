// Acceptance script for the type-and-spacing-tokens branch (DECISIONS-NEEDED.md,
// chore/type-and-spacing-tokens commits). A stray hardcoded size survives every visual review —
// nobody can see 1px in a screenshot — so this is a grep, not a screenshot.
//
// Four checks:
//   1. Zero `font-size:` with a literal px value, outside the token declaration blocks.
//   2. Zero `padding:`/`margin:`/`gap:` with a literal px value, same exemption. Border widths
//      are not spacing and are out of scope for this check.
//   3. Every element whose rule reads var(--text-meta) resolves to a mono font-family — and the
//      inverse, the check that would have caught the Arial bug: zero elements anywhere resolve
//      to a font-family outside {Inter, Outfit, IBM Plex Mono}.
//   4. Across every driven state: the union of distinct computed font-sizes (excluding five named
//      icon-glyph selectors) equals exactly {11px, 12px, 16px, 20px}, and each individual state's
//      set is a subset of that union. Equality per-state is wrong on purpose — the ≤899px state
//      renders only #narrow-notice's h1/p, so its own set is {12, 20} and can never equal the
//      union; union-vs-subset is what actually separates fiction (declared, nothing renders it)
//      from drift (something renders off-scale).
//
// Usage:
//   npm run build && MOSAIC_GPU=1 node scripts/check-type-scale.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreview, launchBrowser } from './lib/harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4176;
const VIEWPORT = { width: 1440, height: 960 };

// ---------------------------------------------------------------------------------------------
// Checks 1 & 2: literal px in the policed source, outside token declarations.
// ---------------------------------------------------------------------------------------------

// A file is policed if it asserts what the app's UI looks like. It is exempt if it asserts what
// a *brand's own* look is — a different subject with a different scale, where a display size is
// the point rather than a mistake. That rule decides new files without another conversation; the
// four paths below are today's instances of it, each carrying the same rule as a comment at its
// own top.
const EXEMPT = new Set([
  'design-system/guidelines/brand-mark.html',
  'design-system/guidelines/brand-makegood-dark.html',
  'design-system/guidelines/brand-makegood-site.html',
  'design-system/guidelines/brand-3dmobility.html',
  // reference-only palettes for other projects, not Mosaic's own token vocabulary
  'design-system/tokens/colors-3dmobility.css',
  'design-system/tokens/colors-makegood.css',
]);

// Whole-file token *declarations* — the canonical px values live here on purpose and are not a
// usage site. src/styles.css carries its :root block inline with real usage below it, so only
// that block is stripped, not the whole file.
const WHOLE_FILE_DECLARATIONS = new Set([
  'design-system/tokens/typography.css',
  'design-system/tokens/spacing.css',
]);

function stripRootBlock(text) {
  const start = text.indexOf(':root');
  if (start === -1) return text;
  const braceStart = text.indexOf('{', start);
  if (braceStart === -1) return text;
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(0, start) + text.slice(i + 1);
    }
  }
  return text;
}

function listFiles() {
  const files = [
    'src/styles.css',
    'index.html',
    'design-system/tokens/typography.css',
    'design-system/tokens/spacing.css',
    'design-system/ui_kits/mosaic/preview.html',
  ];
  const walk = (dir, exts) => {
    for (const entry of readdirSync(path.join(REPO, dir))) {
      const rel = path.join(dir, entry);
      const abs = path.join(REPO, rel);
      const st = statSync(abs);
      if (st.isDirectory()) walk(rel, exts);
      else if (exts.some((e) => entry.endsWith(e))) files.push(rel);
    }
  };
  walk('src', ['.ts']);
  walk('design-system/components', ['.prompt.md']);
  for (const f of [
    'type-scale.html',
    'spacing-radius.html',
    'colors-text.html',
    'colors-surfaces.html',
    'colors-accent.html',
    'type-mono.html',
  ]) {
    files.push(`design-system/guidelines/${f}`);
  }
  return [...new Set(files)];
}

// font-size: allowed only as var(...), em/rem (the five named icon glyphs), or 0/unitless.
const FONT_SIZE_PX_RE = /font-size\s*[:=]\s*['"]?[0-9.]+px/g;
// padding/margin/gap: allowed only as var(...), 0, or auto. A literal 1px on a *border* property
// is a width, not spacing, and is deliberately not policed here — the property regex only matches
// padding/margin/gap/row-gap/column-gap, so a border declaration never enters this check to begin
// with; no extra carve-out needed.
//
// The leading (?<![\w-]) is load-bearing: without it "margin" also matches inside
// "scroll-margin-top" (a position property, out of scope per the plan) and "gap" inside nothing
// today but could tomorrow — a plain \b lets that through, since '-' counts as a word boundary.
const SPACING_PX_RE =
  /(?<![\w-])(padding|margin|gap|row-gap|column-gap)(-[a-z]+)?\s*[:=]\s*['"]?[^;"'\n]*[0-9.]+px/g;

function checkLiteralPx() {
  const findings = [];
  for (const rel of listFiles()) {
    if (EXEMPT.has(rel)) continue;
    let text = readFileSync(path.join(REPO, rel), 'utf8');
    if (WHOLE_FILE_DECLARATIONS.has(rel)) continue; // the declaration itself, not a usage site
    if (rel === 'src/styles.css') text = stripRootBlock(text);

    for (const m of text.matchAll(FONT_SIZE_PX_RE)) {
      findings.push({ file: rel, check: 'font-size', snippet: m[0] });
    }
    for (const m of text.matchAll(SPACING_PX_RE)) {
      findings.push({ file: rel, check: 'padding/margin/gap', snippet: m[0] });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Checks 3 & 4: computed style in the running app.
// ---------------------------------------------------------------------------------------------

// The five glyph-as-icon selectors sized in em against their inherited context (DECISIONS-NEEDED.md
// #1) — deliberately off the 5-step scale. A sixth appearing anywhere else is a real finding.
const ICON_GLYPH_SELECTORS = [
  'details.sec > summary::before',
  '.member-x',
  '.warn-dismiss',
  '.color-row .depth-reset',
  '.close-btn',
];
const ALLOWED_SIZES = new Set(['11px', '12px', '16px', '20px']);
const ALLOWED_FAMILIES = ['Inter', 'Outfit', 'IBM Plex Mono'];

async function fontSizeCensus(page, excludeSelectors) {
  return page.evaluate((excl) => {
    const excluded = new Set();
    for (const sel of excl) {
      // ::before isn't a real element to querySelectorAll — approximate by matching its host.
      const hostSel = sel.replace(/::before$/, '');
      document.querySelectorAll(hostSel).forEach((el) => excluded.add(el));
    }
    const sizes = new Set();
    for (const el of document.querySelectorAll('body *')) {
      if (excluded.has(el)) continue;
      const cs = getComputedStyle(el);
      const fs = cs.fontSize;
      if (!fs || fs === '0px') continue;
      // Skip elements with no rendered text and no ::before/::after content — a huge share of
      // #app is pure layout <div>s whose font-size is inherited noise, not a real rendered size.
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
      );
      const before = getComputedStyle(el, '::before').content;
      if (!hasText && (!before || before === 'none' || before === '""')) continue;
      sizes.add(fs);
    }
    return [...sizes];
  }, excludeSelectors);
}

async function fontFamilyCheck(page) {
  return page.evaluate((allowed) => {
    const offScale = [];
    for (const el of document.querySelectorAll('body *')) {
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
      );
      if (!hasText) continue;
      const family = getComputedStyle(el).fontFamily;
      const first = family.split(',')[0].replace(/['"]/g, '').trim();
      if (!allowed.includes(first)) {
        offScale.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: el.className && typeof el.className === 'string' ? el.className : null,
          family,
        });
      }
    }
    return offScale;
  }, ALLOWED_FAMILIES);
}

async function metaResolvesMono(page) {
  // var(--text-meta) usage sites, collected from src/styles.css itself — the computed style
  // can't report which custom property produced a value, so the selector list has to come from
  // the source, then get its family checked live.
  const css = readFileSync(path.join(REPO, 'src/styles.css'), 'utf8');
  const selectors = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(ruleRe)) {
    if (/var\(--text-meta\)/.test(m[2])) {
      for (const sel of m[1].split(',')) selectors.push(sel.trim());
    }
  }
  const results = await page.evaluate((sels) => {
    // --text-meta itself, read once, so a violation means the token actually won the cascade for
    // that element's font-size — not merely that some rule mentioning it also matches the
    // selector. `.shape-picker select` matches the bare `select { ... var(--text-meta) ... }`
    // rule too, but a more specific rule overrides *both* its size and family back to sans/body;
    // checking family alone against every matching selector flagged that as a false violation.
    const metaPx = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-meta')
      .trim();
    const out = [];
    for (const sel of sels) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue; // pseudo-selectors (::before) aren't queryable directly
      }
      for (const el of els) {
        const cs = getComputedStyle(el);
        if (cs.fontSize !== metaPx) continue; // --text-meta didn't actually win here
        if (!/IBM Plex Mono/.test(cs.fontFamily)) {
          out.push({ selector: sel, family: cs.fontFamily });
        }
      }
    }
    return out;
  }, selectors);
  return { selectorsChecked: selectors, violations: results };
}

async function main() {
  const literalFindings = checkLiteralPx();

  const preview = await startPreview({ port: PORT });
  let browser;
  const states = {};
  const errors = [];
  try {
    browser = await launchBrowser();
    // Raw browser.newPage(), not harness's newPage() wrapper: that wrapper auto-accepts the
    // themed confirm dialog (clicks #confirm-ok the instant it sees `open` flip true), which is
    // exactly right for scripts that just need to get past it but means this check could never
    // observe the dialog's own font-size in its open state — it would already be closed again by
    // the time this script looked. Confirmed live: `d.open` read false with the confirm message
    // already populated, i.e. after an auto-accept this script never asked for.
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => !!window.__mosaic);
    await page.evaluate(() => window.__mosaic.whenIdle());

    states['first paint'] = await fontSizeCensus(page, ICON_GLYPH_SELECTORS);

    // help dialog
    await page.click('#btn-help');
    await page.waitForFunction(() => document.querySelector('#help-dialog')?.open === true);
    states['help dialog open'] = await fontSizeCensus(page, ICON_GLYPH_SELECTORS);
    await page.click('#btn-help-close');
    await page.waitForFunction(() => document.querySelector('#help-dialog')?.open === false);

    // artwork loaded -> colors detected, warning pill. Includes one near-duplicate red pair
    // (deltaE small enough to fall under the "Strong" auto-merge threshold, 18) alongside five
    // well-separated colors, so the same artwork can also drive the merged-color-group state
    // below without a second page load.
    const SEVEN_COLOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 70">
  <rect x="0" y="0" width="60" height="10" fill="#c1272d"/>
  <rect x="0" y="10" width="60" height="10" fill="#c93038"/>
  <rect x="0" y="20" width="60" height="10" fill="#f5d020"/>
  <rect x="0" y="30" width="60" height="10" fill="#1e5fa8"/>
  <rect x="0" y="40" width="60" height="10" fill="#2e9e4f"/>
  <rect x="0" y="50" width="60" height="10" fill="#8e44ad"/>
  <rect x="0" y="60" width="60" height="10" fill="#e67e22"/>
</svg>`;
    await page.setInputFiles('#svg-input', {
      name: 'seven-color.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(SEVEN_COLOR_SVG),
    });
    await page.evaluate(() => window.__mosaic.whenIdle());
    await page.waitForSelector('#color-list .color-row');
    states['artwork loaded'] = await fontSizeCensus(page, ICON_GLYPH_SELECTORS);

    // warning pill (the multi-unit info pill is already up from the load above)
    await page.waitForSelector('.warn-pill');
    states['warning pill visible'] = await fontSizeCensus(page, ICON_GLYPH_SELECTORS);

    const metaCheck = await metaResolvesMono(page);
    const familyCheck = await fontFamilyCheck(page);

    // confirm dialog: switching shape kind with artwork loaded
    const currentKind = await page.$eval('#shape-kind', (s) => s.value);
    const kindOptions = await page.$$eval('#shape-kind option', (os) =>
      os.map((o) => o.value).filter((v) => v),
    );
    const otherKind = kindOptions.find((v) => v !== currentKind);
    let confirmReached = false;
    if (otherKind) {
      await page.selectOption('#shape-kind', otherKind);
      await page
        .waitForFunction(() => document.querySelector('#confirm-dialog')?.open === true, null, {
          timeout: 5000,
        })
        .catch(() => {});
      confirmReached = await page.$eval('#confirm-dialog', (d) => d.open).catch(() => false);
      if (confirmReached) {
        states['confirm dialog open'] = await fontSizeCensus(page, ICON_GLYPH_SELECTORS);
        await page.click('#confirm-cancel');
        await page.waitForFunction(() => document.querySelector('#confirm-dialog')?.open === false);
      }
    }

    // merged color group -> .member-x. Manual drag-to-merge isn't reliably scriptable (native
    // HTML5 drag), so this drives auto-merge instead — a range input, which needs its value set
    // and an 'input' event dispatched directly; page.fill() only targets text-like inputs.
    let mergedReached = false;
    try {
      await page.$eval('#p-automerge', (el) => {
        el.value = '3'; // "Strong", threshold 18 — clears the near-duplicate red pair's deltaE
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.evaluate(() => window.__mosaic.whenIdle());
      mergedReached = (await page.$$('.member-swatch')).length > 0;
      if (mergedReached) {
        states['merged color group'] = await fontSizeCensus(page, ICON_GLYPH_SELECTORS);
      }
    } catch {
      mergedReached = false;
    }

    // narrow viewport, <=899px — #narrow-notice replaces #app entirely
    await page.setViewportSize({ width: 800, height: 700 });
    await page.waitForTimeout(200);
    states['narrow ≤899px'] = await fontSizeCensus(page, ICON_GLYPH_SELECTORS);
    await page.setViewportSize(VIEWPORT);

    // ---- Report ---------------------------------------------------------------------------
    console.log('=== check-type-scale ===\n');

    console.log(`States driven: ${Object.keys(states).join(', ')}`);
    console.log(`  confirm dialog: ${confirmReached ? 'reached' : 'NOT reached'}`);
    console.log(
      `  merged color group (.member-swatch): ${mergedReached ? 'reached' : 'NOT reached — not driven this run'}`,
    );
    console.log();

    let ok = true;

    console.log(`1/2. Literal px in policed source: ${literalFindings.length} found`);
    for (const f of literalFindings.slice(0, 40)) {
      console.log(`     ${f.file} — ${f.check}: ${f.snippet}`);
    }
    if (literalFindings.length) ok = false;

    console.log(
      `\n3.   var(--text-meta) sites resolving to mono: ${metaCheck.selectorsChecked.length} selectors checked, ${metaCheck.violations.length} violations`,
    );
    for (const v of metaCheck.violations) console.log(`     ${v.selector} -> ${v.family}`);
    if (metaCheck.violations.length) ok = false;

    console.log(`     Elements off {Inter, Outfit, IBM Plex Mono}: ${familyCheck.length}`);
    for (const v of familyCheck.slice(0, 20)) {
      console.log(
        `     <${v.tag}${v.id ? '#' + v.id : ''}${v.cls ? '.' + v.cls.replace(/\s+/g, '.') : ''}> -> ${v.family}`,
      );
    }
    if (familyCheck.length) ok = false;

    console.log('\n4.   Distinct computed font-size per state (icon-glyph selectors excluded):');
    const union = new Set();
    for (const [name, sizes] of Object.entries(states)) {
      console.log(`     ${name}: {${sizes.sort().join(', ')}}`);
      for (const s of sizes) union.add(s);
    }
    const unionSorted = [...union].sort();
    console.log(`     union: {${unionSorted.join(', ')}}`);
    const unionOk =
      unionSorted.length === ALLOWED_SIZES.size && unionSorted.every((s) => ALLOWED_SIZES.has(s));
    if (!unionOk) {
      console.log(`     FAIL: union != {${[...ALLOWED_SIZES].join(', ')}}`);
      ok = false;
    }
    for (const [name, sizes] of Object.entries(states)) {
      const subsetOk = sizes.every((s) => ALLOWED_SIZES.has(s));
      if (!subsetOk) {
        console.log(`     FAIL: "${name}" has a size outside {${[...ALLOWED_SIZES].join(', ')}}`);
        ok = false;
      }
    }

    if (errors.length) {
      console.log(`\nConsole/page errors during the run: ${errors.length}`);
      for (const e of errors) console.log(`     ${e}`);
      ok = false;
    }

    console.log(`\n${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
  } finally {
    await browser?.close();
    await preview.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
