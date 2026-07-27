// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSVGDocument } from '../src/svg/parse';
import { WARNINGS } from '../src/warnings';
import type { PatternEntry } from '../src/types';

// jsdom has no 2d canvas without the native `canvas` package — same stub as tests/parse.test.ts,
// enough of the fillStyle contract to resolve the patterns' plain #rrggbb fills.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () {
    let value = '#000000';
    return {
      get fillStyle() {
        return value;
      },
      set fillStyle(s: string) {
        const str = String(s).trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(str)) value = str;
      },
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

// import.meta.url doesn't reliably point at this file's location under the jsdom test
// environment (jsdom stubs the document location), unlike the other REPO-resolving tests in
// this suite — cwd is the repo root vitest is invoked from instead.
const REPO = process.cwd();
const manifest: PatternEntry[] = JSON.parse(
  readFileSync(resolve(REPO, 'public/patterns/patterns.json'), 'utf8'),
);

// Every entry the picker strip can offer must actually parse cleanly and stay clear of the
// wheel/rect anchor trap (a <circle> element) — see scripts/gen-patterns.mjs's header comment.
describe('every built-in pattern asset', () => {
  it('the manifest is non-empty and self-consistent', () => {
    expect(manifest.length).toBeGreaterThan(0);
    manifest.forEach((p) => {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.file).toBeTruthy();
    });
  });

  it.each(manifest.map((p) => [p.id, p.file] as const))(
    '%s parses as a clean, sized, flat design',
    (_id, file) => {
      const svgText = readFileSync(resolve(REPO, 'public/patterns', file), 'utf8');
      WARNINGS.length = 0;
      const parsed = parseSVGDocument(svgText);

      expect(parsed.shapes.length).toBeGreaterThan(0);
      // explicit mm width/height + matching viewBox, so rect-mode assembly placement maps 1:1
      expect(parsed.userUnitMM).toBeCloseTo(1, 6);
      // must never trigger the wheel/rect design-boundary auto-anchor
      expect(parsed.rawSVGCircle).toBeNull();
      // flat fills only — a gradient/pattern fill would have been skipped with a warning
      expect(WARNINGS).toEqual([]);
      parsed.shapes.forEach((s) => expect(s.fill).toMatch(/^#[0-9a-f]{6}$/));
    },
  );
});

/**
 * The whole point of these assets is that Fill mode repeats them edge-to-edge, so what has to hold
 * is that the color a hair inside one edge matches the color a hair inside the opposite edge —
 * where the next tile's copy butts up against it. Zebra shipped violating this (its marching-squares
 * contours were traced in a padded window and any contour that didn't close inside it was silently
 * discarded), with mismatched runs up to 11.67mm; nothing in the suite noticed because the other
 * three patterns tile by construction.
 */
describe('every built-in pattern tiles seamlessly', () => {
  const SAMPLES = 2000;
  // A mismatch run this short can't survive a 0.4mm nozzle; anything longer is a visible seam.
  const MAX_RUN_MM = 0.25;

  const inLoop = (x: number, y: number, loop: { x: number; y: number }[]): boolean => {
    let hit = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i],
        b = loop[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };

  it.each(manifest.map((p) => [p.id, p.file] as const))('%s', (_id, file) => {
    const parsed = parseSVGDocument(readFileSync(resolve(REPO, 'public/patterns', file), 'utf8'));
    const { minX, minY, maxX, maxY } = parsed.bbox;
    const W = maxX - minX,
      H = maxY - minY;

    // topmost shape covering the point wins, matching document-order paint (and the app's own
    // per-color netting); a shape is covered when an odd number of its subpath loops contain it
    const colorAt = (x: number, y: number): string => {
      for (let i = parsed.shapes.length - 1; i >= 0; i--) {
        const s = parsed.shapes[i];
        if (s.loops.filter((l) => inLoop(x, y, l)).length % 2 === 1) return s.fill;
      }
      return 'none';
    };

    const d = 0.001;
    for (const axis of ['x', 'y'] as const) {
      const span = axis === 'x' ? H : W;
      const step = span / SAMPLES;
      let run = 0,
        worst = 0,
        bad = 0;
      for (let i = 0; i < SAMPLES; i++) {
        const t = minY + (i + 0.5) * step;
        const s = minX + (i + 0.5) * step;
        const [near, far] =
          axis === 'x'
            ? [colorAt(minX + d, t), colorAt(maxX - d, t)]
            : [colorAt(s, minY + d), colorAt(s, maxY - d)];
        if (near === far) run = 0;
        else {
          bad++;
          run += step;
          worst = Math.max(worst, run);
        }
      }
      expect({ axis, worstRunMM: worst < MAX_RUN_MM, badFrac: bad / SAMPLES < 0.01 }).toEqual({
        axis,
        worstRunMM: true,
        badFrac: true,
      });
    }
  });
});
