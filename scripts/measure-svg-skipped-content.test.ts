// Which warnings does parseSVGDocument raise on every SVG this repo ships or tests against? Written
// to tune the skipped-content warnings (clip/mask, linked copies, text, outline-only shapes) so a
// file that prints as drawn stays quiet: the four fixture patterns, every public/templates/ file,
// the in-app sample badge and the generated hubcap templates.
//
// Usage: RUN_SVG_SKIP_SWEEP=1 npx vitest run scripts/measure-svg-skipped-content.test.ts
// Prints one row per file: shapes imported, then every warning raised (none = quiet). A second table
// reruns with TEMPLATE_INKS emptied: what the templates would raise without the guide-ink exemption.
// @vitest-environment jsdom
import { beforeAll, describe, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_INKS, parseSVGDocument } from '../src/svg/parse';
import { WARNINGS, clearWarnings } from '../src/warnings';
import { hubcapTemplateSvg } from '../src/geometry/hubcap';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function svgFiles(dir: string): [string, string][] {
  const abs = path.join(REPO, dir);
  return readdirSync(abs)
    .filter((f) => f.endsWith('.svg'))
    .sort()
    .map((f) => [path.join(dir, f), readFileSync(path.join(abs, f), 'utf8')]);
}

/** The sample badge, read from its source so this can't drift from what the app loads. */
function sampleBadge(): string {
  const src = readFileSync(path.join(REPO, 'src/ui/artworkPanel.ts'), 'utf8');
  const m = /const SAMPLE_SVG = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error('SAMPLE_SVG not found in src/ui/artworkPanel.ts');
  return m[1];
}

describe.skipIf(!process.env.RUN_SVG_SKIP_SWEEP)('skipped-content warning sweep', () => {
  it('reports warnings per shipped/fixture SVG', () => {
    const inputs: [string, string][] = [
      ['src/ui/artworkPanel.ts SAMPLE_SVG', sampleBadge()],
      ...svgFiles('tests/fixtures/patterns'),
      ...svgFiles('public/templates'),
      ['hubcapTemplateSvg circle 220mm', hubcapTemplateSvg({ kind: 'circle', diameterMm: 220 })],
      [
        'hubcapTemplateSvg silhouette',
        hubcapTemplateSvg({
          kind: 'silhouette',
          outline: [
            [
              { x: 0, z: 0 },
              { x: 100, z: 0 },
              { x: 100, z: 60 },
              { x: 0, z: 60 },
            ],
          ],
        }),
      ],
    ];
    const table = (): string => {
      const rows: string[] = [];
      for (const [name, text] of inputs) {
        clearWarnings();
        let shapes: number | string;
        try {
          shapes = parseSVGDocument(text).shapes.length;
        } catch (e) {
          shapes = `threw: ${(e as Error).message}`;
        }
        const warnings = WARNINGS.map((w) => w.message);
        rows.push(`${name}\t${shapes}\t${warnings.length ? warnings.join(' | ') : '(quiet)'}`);
      }
      return ['file\tshapes\twarnings', ...rows].join('\n');
    };
    console.log(table());
    const inks = [...TEMPLATE_INKS];
    (TEMPLATE_INKS as Set<string>).clear();
    try {
      console.log('\nwithout the template-ink exemption:\n' + table());
    } finally {
      for (const c of inks) (TEMPLATE_INKS as Set<string>).add(c);
    }
  });
});
