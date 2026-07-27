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
