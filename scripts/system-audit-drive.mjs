// Drive sequence for the `system` review-gauntlet lens (docs/system-audit.md).
//
// Loads the built app, walks it through every state the audit needs (initial load, artwork
// loaded, both AMS-slot warning tiers, help dialog open, confirm dialog open, hover/focus/
// disabled states), and dumps everything the report's tables are built from to a JSON file:
// resolved custom-property values, the distinct rendered values for each scale property, a
// census of var()-vs-literal declarations in the app's own stylesheet, and per-component
// snapshots (computed style + outerHTML) for the states above.
//
// Usage:
//   npm run build && MOSAIC_GPU=1 node scripts/system-audit-drive.mjs [outFile]
//
// Re-run this unchanged to regenerate the same measurements; a diff in its own content hash
// (recorded in the report header) means a later run walked a different sequence and its
// state-sensitive (†) rows are not comparable to this one's.
import { writeFileSync } from 'node:fs';
import { startPreview, launchBrowser, glRenderer, useGpu } from './lib/harness.mjs';

const OUT = process.argv[2] || 'system-audit-drive-output.json';
const PORT = 4174; // don't collide with an interactive `npm run preview` on 4173
const VIEWPORT = { width: 1440, height: 960 };

const DESIGN_TOKENS = {
  colors: [
    '--bg',
    '--panel',
    '--panel-2',
    '--viewport',
    '--line',
    '--text',
    '--text-dim',
    '--accent',
    '--accent-2',
    '--danger',
    '--on-accent',
    '--accent-wash',
    '--accent-glow',
    '--danger-wash',
    '--danger-border',
    '--danger-text',
  ],
  spacing: [
    '--space-1',
    '--space-2',
    '--space-3',
    '--space-4',
    '--space-5',
    '--space-6',
    '--space-7',
    '--space-8',
    '--space-9',
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--radius-xl',
    '--radius-2xl',
    '--border-width',
    '--transition-fast',
  ],
  typography: [
    '--font-heading',
    '--font-sans',
    '--font-mono',
    '--text-xs',
    '--text-sm',
    '--text-sm-plus',
    '--text-md',
    '--text-base',
    '--text-lg',
    '--weight-regular',
    '--weight-semibold',
    '--weight-bold',
    '--tracking-label',
    '--leading-tight',
    '--leading-normal',
  ],
};
// The app declares these under different names than the design-system token files use — see
// the report's Adoption section. Mapping resolved here so the same census script measures both
// vocabularies without hand-editing this file every run.
const APP_TOKEN_ALIASES = {
  '--font-heading': '--heading',
  '--font-sans': '--sans',
  '--font-mono': '--mono',
};

// A 6-flat-color SVG. 6 colors + 1 body = 7 slots needed: > 4 (bambu-x1c's per-unit) triggers
// the 'multi-unit' info pill on the default printer with no extra step, and > 4 (snapmaker-u1's
// max, which equals its per-unit) triggers the 'over-max' warn pill after switching printers —
// both AMS-slot warning tiers reachable off one piece of test artwork.
const SIX_COLOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="0" y="0" width="60" height="10" fill="#c1272d"/>
  <rect x="0" y="10" width="60" height="10" fill="#f5d020"/>
  <rect x="0" y="20" width="60" height="10" fill="#1e5fa8"/>
  <rect x="0" y="30" width="60" height="10" fill="#2e9e4f"/>
  <rect x="0" y="40" width="60" height="10" fill="#8e44ad"/>
  <rect x="0" y="50" width="60" height="10" fill="#e67e22"/>
</svg>`;

async function resolveTokens(page) {
  return page.evaluate(
    ({ tokens, aliases }) => {
      const cs = getComputedStyle(document.documentElement);
      const out = {};
      for (const group of Object.keys(tokens)) {
        out[group] = {};
        for (const name of tokens[group]) {
          const direct = cs.getPropertyValue(name).trim();
          const aliasName = aliases[name];
          const alias = aliasName ? cs.getPropertyValue(aliasName).trim() : '';
          out[group][name] = { direct, aliasName: aliasName || null, aliasValue: alias || null };
        }
      }
      return out;
    },
    { tokens: DESIGN_TOKENS, aliases: APP_TOKEN_ALIASES },
  );
}

/**
 * Census every declaration in the app's own stylesheet that governs a scale property: does it
 * reference a var() or a literal? Reads raw `cssText` per rule and splits on `;` rather than
 * querying individual longhands (`rule.style.getPropertyValue('background-color')`) — Chromium's
 * CSSOM does not populate a longhand's own getPropertyValue when it was only ever set through a
 * shorthand containing var() (`background: var(--panel)` leaves `background-color` querying as
 * '' even though the property is very much set), which silently undercounted every var()-backed
 * background/border here on the first pass.
 */
async function cssVarCensus(page) {
  return page.evaluate(() => {
    let varDecls = 0;
    let literalDecls = 0;
    const literalSamples = [];
    const SCALE_PROP_RE =
      /^(font-size|font-weight|border-radius|color|background|background-color|border|border-color|border-\w+)$/;
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin (Google Fonts) — nothing of ours to census
      }
      if (!sheet.href || !sheet.href.includes('/assets/')) continue; // only the app's own bundled CSS
      const walk = (ruleList) => {
        for (const rule of ruleList) {
          if (rule.style?.cssText) {
            for (const decl of rule.style.cssText.split(';')) {
              const idx = decl.indexOf(':');
              if (idx === -1) continue;
              const prop = decl.slice(0, idx).trim();
              const val = decl.slice(idx + 1).trim();
              if (!SCALE_PROP_RE.test(prop) || !val) continue;
              if (val.includes('var(')) varDecls++;
              else {
                literalDecls++;
                if (literalSamples.length < 60)
                  literalSamples.push(`${rule.selectorText} { ${prop}: ${val} }`);
              }
            }
          }
          if (rule.cssRules) walk(rule.cssRules);
        }
      };
      walk(rules);
    }
    return { varDecls, literalDecls, literalSamples };
  });
}

/** Distinct computed values actually rendered, per scale property, across every element. */
async function scaleCensus(page) {
  return page.evaluate(() => {
    const props = ['fontSize', 'fontWeight', 'borderRadius', 'color', 'backgroundColor'];
    const tally = {};
    for (const p of props) tally[p] = {};
    for (const el of document.querySelectorAll('#app *')) {
      const cs = getComputedStyle(el);
      for (const p of props) {
        const v = cs[p];
        if (!v || v === '0px' || v === 'rgba(0, 0, 0, 0)') continue;
        tally[p][v] = (tally[p][v] || 0) + 1;
      }
    }
    return tally;
  });
}

async function elementSnapshot(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const props = [
      'color',
      'backgroundColor',
      'borderColor',
      'borderWidth',
      'borderRadius',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'padding',
      'opacity',
      'cursor',
      'outlineStyle',
      'textTransform',
      'letterSpacing',
      'display',
    ];
    const style = {};
    for (const p of props) style[p] = cs[p];
    return { selector: sel, outerHTML: el.outerHTML.slice(0, 600), style };
  }, selector);
}

async function main() {
  const built = new Date().toISOString();
  console.log(`[system-audit-drive] build check-in: ${built}`);

  const preview = await startPreview({ port: PORT });
  let browser;
  const result = { meta: {}, states: {} };
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => !!window.__mosaic);
    await page.evaluate(() => window.__mosaic.whenIdle());

    result.meta.viewport = VIEWPORT;
    result.meta.devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
    result.meta.userAgent = await page.evaluate(() => navigator.userAgent);
    result.meta.gpu = useGpu() ? await glRenderer(page) : 'software (MOSAIC_GPU not set)';

    // ---- State 1: initial load, disc mode, no artwork ----------------------------------------
    result.states.initial = {
      tokens: await resolveTokens(page),
      scale: await scaleCensus(page),
      cssVars: await cssVarCensus(page),
      shapeKindOptions: await page.$$eval('#shape-kind option', (os) =>
        os.map((o) => o.textContent.trim()),
      ),
      panelTitles: await page.$$eval('#left > details.sec > summary', (s) =>
        s.map((x) => x.textContent.trim()),
      ),
      exportButtons: await page.$$eval('#btn-export, #btn-export-stl', (btns) =>
        btns.map((b) => ({
          id: b.id,
          text: b.textContent.trim(),
          classes: b.className,
          disabled: b.disabled,
        })),
      ),
      button: await elementSnapshot(page, '#btn-export'),
      buttonSecondary: await elementSnapshot(page, '#btn-export-stl'),
      buttonSmall: await elementSnapshot(page, '#btn-sample'),
      // #p-depth (Depth panel) rather than a Disc-only field like #p-diameter: the default
      // selected shape kind is an assembly part, so #p-diameter's wrapper is `display:none` —
      // its own computed `display` still reads as if visible (an ancestor's display:none doesn't
      // change a child's own property value), which silently breaks any interaction (focus,
      // hover) run against it. #p-depth is never shape-conditional.
      textInput: await elementSnapshot(page, '#p-depth'),
      select: await elementSnapshot(page, '#shape-kind'),
      checkbox: await elementSnapshot(page, '#p-recess-bg'),
      slider: await elementSnapshot(page, '#p-scale'),
      panel: await elementSnapshot(page, '#left > details.sec:first-of-type'),
      dropzone: await elementSnapshot(page, '#dropzone'),
      loadingOverlay: await elementSnapshot(page, '#loading-overlay'),
    };

    // hover: primary button, default button, dropzone. The app's own hover transition is 0.12s
    // (--transition-fast); a snapshot taken immediately after hover() lands mid-transition, so
    // wait past it before reading computed style, or every hover row misreports as "no change".
    const HOVER_SETTLE_MS = 200;
    await page.hover('#btn-sample');
    await page.waitForTimeout(HOVER_SETTLE_MS);
    result.states.initial.buttonSmallHover = await elementSnapshot(page, '#btn-sample');
    await page.hover('#dropzone');
    await page.waitForTimeout(HOVER_SETTLE_MS);
    result.states.initial.dropzoneHover = await elementSnapshot(page, '#dropzone');

    // drag-over: dispatch a real dragover event at #dropzone (native drag can't be scripted
    // headlessly the way a mouse can, but this exercises the app's own listener, not a class
    // toggle we invented)
    await page.evaluate(() => {
      const dt = new DataTransfer();
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      document.querySelector('#dropzone').dispatchEvent(ev);
    });
    await page.waitForTimeout(HOVER_SETTLE_MS); // #dropzone's own transition: 0.12s, same reason
    result.states.initial.dropzoneDragOver = await elementSnapshot(page, '#dropzone');
    // reset (dragleave)
    await page.evaluate(() => {
      const dt = new DataTransfer();
      document
        .querySelector('#dropzone')
        .dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
    });

    // focus — #p-depth (Depth panel), always visible regardless of shape kind
    await page.focus('#p-depth');
    result.states.initial.textInputFocus = await elementSnapshot(page, '#p-depth');
    await page.keyboard.press('Tab');

    // disabled: export buttons are disabled before any artwork is loaded
    result.states.initial.exportDisabledSnapshot = await elementSnapshot(page, '#btn-export');

    // ---- Help dialog open ----------------------------------------------------------------------
    await page.click('#btn-help');
    await page.waitForFunction(() => document.querySelector('#help-dialog')?.open === true);
    result.states.helpDialogOpen = {
      dialog: await elementSnapshot(page, '#help-dialog'),
      tocLink: await elementSnapshot(page, '.help-toc a'),
      heading: await elementSnapshot(page, '.help-head h2'),
      sectionHeading: await elementSnapshot(page, '.help-sec h3'),
      closeButton: await elementSnapshot(page, '#btn-help-close'),
      scale: await scaleCensus(page), // dialog contents only render into DOM once open
    };
    await page.click('#btn-help-close');
    await page.waitForFunction(() => document.querySelector('#help-dialog')?.open === false);

    // ---- Load 6-color artwork -> Colors detected populates, multi-unit info pill appears -------
    await page.setInputFiles('#svg-input', {
      name: 'six-color.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(SIX_COLOR_SVG),
    });
    await page.evaluate(() => window.__mosaic.whenIdle());
    await page.waitForSelector('#color-list .color-row');

    result.states.artworkLoaded = {
      colorRowCount: await page.$$eval('.color-list .color-row', (r) => r.length),
      colorRow: await elementSnapshot(page, '.color-list .color-row:not(.is-base)'),
      baseRow: await elementSnapshot(page, '.color-list .color-row.is-base'),
      hex: await elementSnapshot(page, '.color-list .color-row:not(.is-base) .hex'),
      swatch: await elementSnapshot(page, '.color-list .color-row:not(.is-base) .swatch'),
      dragGrip: await elementSnapshot(page, '.color-list .drag-grip'),
      mergeSelect: await elementSnapshot(page, '.color-list .merge-with'),
      exportButtons: await page.$$eval('#btn-export, #btn-export-stl', (btns) =>
        btns.map((b) => ({ id: b.id, disabled: b.disabled })),
      ),
      exportEnabledSnapshot: await elementSnapshot(page, '#btn-export'),
      slotCount: await elementSnapshot(page, '#slot-count'),
      warnPills: await page.$$eval('.warn-pill', (pills) =>
        pills.map((p) => ({ classes: p.className, text: p.textContent.trim() })),
      ),
      warnPillInfo: await elementSnapshot(page, '.warn-pill.info'),
      warnDismiss: await elementSnapshot(page, '.warn-dismiss'),
    };

    // dragging a color row: real HTML5 drag can't be scripted headlessly via drag&drop events
    // reliably across browsers, so exercise the class the app itself applies mid-drag by firing
    // its own dragstart handler path is out of scope here — recorded as not reached, see report.

    // ---- Switch printer to Snapmaker U1 -> over-max warn pill (danger tone) --------------------
    await page.selectOption('#p-printer', 'snapmaker-u1');
    await page.evaluate(() => window.__mosaic.whenIdle());
    await page.waitForFunction(
      () => document.querySelector('.warn-pill:not(.info)') !== null,
      null,
      { timeout: 15000 },
    );
    result.states.overMaxWarning = {
      warnPills: await page.$$eval('.warn-pill', (pills) =>
        pills.map((p) => ({ classes: p.className, text: p.textContent.trim() })),
      ),
      warnPillDanger: await elementSnapshot(page, '.warn-pill:not(.info)'),
      slotCountOverCapacity: await elementSnapshot(page, '#slot-count.over-capacity'),
      clearAll: await elementSnapshot(page, '.warn-clear-all'),
    };
    await page.selectOption('#p-printer', 'bambu-x1c');
    await page.evaluate(() => window.__mosaic.whenIdle());

    // ---- Confirm dialog: switching shape-kind with artwork loaded prompts first ----------------
    // Must differ from whatever's already selected (an assembly kind by default, not 'disc') or
    // selectOption() fires no 'change' event and the confirm never opens.
    const currentKind = await page.$eval('#shape-kind', (s) => s.value);
    const kindOptions = await page.$$eval('#shape-kind option', (os) =>
      os.map((o) => o.value).filter((v) => v),
    );
    const otherKind = kindOptions.find((v) => v !== currentKind);
    if (otherKind) {
      await page.selectOption('#shape-kind', otherKind);
      await page
        .waitForFunction(() => document.querySelector('#confirm-dialog')?.open === true, null, {
          timeout: 5000,
        })
        .catch(() => {});
      const open = await page.$eval('#confirm-dialog', (d) => d.open).catch(() => false);
      if (open) {
        result.states.confirmDialogOpen = {
          dialog: await elementSnapshot(page, '#confirm-dialog'),
          message: await page.$eval('#confirm-message', (p) => p.textContent.trim()),
          okButton: await elementSnapshot(page, '#confirm-ok'),
          cancelButton: await elementSnapshot(page, '#confirm-cancel'),
        };
        await page.click('#confirm-cancel');
        await page.waitForFunction(() => document.querySelector('#confirm-dialog')?.open === false);
      } else {
        result.states.confirmDialogOpen = { reached: false, reason: 'dialog did not open' };
      }
    } else {
      result.states.confirmDialogOpen = {
        reached: false,
        reason: 'no other shape kind to switch to',
      };
    }

    // ---- Final: full-page scale census with everything that opened this run in the DOM ---------
    result.states.finalUnion = {
      scale: await scaleCensus(page),
      cssVars: await cssVarCensus(page),
    };

    // Off-scale outliers worth naming, not just counting: which elements actually render pure
    // black text / pure white fills on a navy-panel dark theme, and which render the 0px radius
    // step that a computed-style census can't otherwise distinguish from "nothing set it".
    result.states.finalUnion.outliers = await page.evaluate(() => {
      const describe = (el) =>
        `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().replace(/\s+/g, '.') : ''}`;
      const black = [];
      const white = [];
      const zeroRadius = [];
      for (const el of document.querySelectorAll('#app *')) {
        const cs = getComputedStyle(el);
        if (cs.color === 'rgb(0, 0, 0)' && black.length < 10) black.push(describe(el));
        if (cs.backgroundColor === 'rgb(255, 255, 255)' && white.length < 10)
          white.push(describe(el));
        if (cs.borderRadius === '0px' && zeroRadius.length < 15) zeroRadius.push(describe(el));
      }
      return { black, white, zeroRadius };
    });

    result.consoleErrors = errors;
  } finally {
    await browser?.close();
    await preview.stop();
  }

  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[system-audit-drive] wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
