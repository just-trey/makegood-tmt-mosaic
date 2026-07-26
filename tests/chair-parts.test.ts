import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  analyze,
  readMesh,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/mesh.mjs';

// Guards the packed chair assets ship correctly: every manifest entry loads as a single-object
// 3MF (the format load3MF reads — a Bambu multi-part 3MF would read as zero triangles), and the
// 15 pieces sit in ONE shared assembled world frame rather than each recentered on the origin.
// The frame is load-bearing: the Phase 4 zone bake welds these meshes in this pose, so a stray
// re-pack with --center would silently stack them and break every baked chart. Reads only the
// tracked public/stl assets, never the gitignored stubs.

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const stl = (f: string): string => resolve(REPO, 'public', f);

interface Entry {
  id: string;
  name: string;
  file: string;
}
type Box = { cx: number; cy: number; cz: number; mn: number[]; mx: number[]; tris: number };

const manifest: Entry[] = JSON.parse(readFileSync(stl('stl/parts.json'), 'utf8'));
const chairEntries = manifest.filter((e) => e.id.startsWith('chair-'));

// Welded-body envelope (stubs/Main Chair Body.stl), the frame the pieces were exported in.
const ENVELOPE = { mn: [-191, 14, -664], mx: [191, 563, -3] };

const boxes = new Map<string, Box>();

beforeAll(async () => {
  for (const e of chairEntries) {
    const a = analyze(await readMesh(stl(e.file)));
    boxes.set(e.id, {
      cx: (a.bb.mn[0] + a.bb.mx[0]) / 2,
      cy: (a.bb.mn[1] + a.bb.mx[1]) / 2,
      cz: (a.bb.mn[2] + a.bb.mx[2]) / 2,
      mn: a.bb.mn,
      mx: a.bb.mx,
      tris: a.triCount,
    });
  }
}, 60000);

describe('chair part manifest', () => {
  it('registers all 15 printed pieces (both caster variants)', () => {
    expect(chairEntries).toHaveLength(15);
    expect(new Set(chairEntries.map((e) => e.id)).size).toBe(15);
  });

  it('every piece loads as a non-empty single-object 3MF', () => {
    for (const e of chairEntries) {
      const b = boxes.get(e.id)!;
      // >0 triangles proves the reader (same one load3MF uses) resolved an inlined <object> and
      // not a <component p:path>, which would have read as zero.
      expect(b.tris, e.id).toBeGreaterThan(0);
    }
  });
});

describe('assembled pose', () => {
  it('keeps every piece inside the welded-body envelope', () => {
    for (const e of chairEntries) {
      const b = boxes.get(e.id)!;
      for (let k = 0; k < 3; k++) {
        expect(b.mn[k], `${e.id} min[${k}]`).toBeGreaterThanOrEqual(ENVELOPE.mn[k]);
        expect(b.mx[k], `${e.id} max[${k}]`).toBeLessThanOrEqual(ENVELOPE.mx[k]);
      }
    }
  });

  it('is not recentered: pieces occupy distinct, spread-out positions', () => {
    // if anything had been packed with --center, every center would collapse toward the origin
    const spanX = Math.max(...[...boxes.values()].map((b) => b.cx));
    const minX = Math.min(...[...boxes.values()].map((b) => b.cx));
    expect(spanX - minX).toBeGreaterThan(200); // handles/wings reach ±150mm in X
    // z centers sit deep in the (negative) chair envelope, nowhere near an origin recenter
    for (const b of boxes.values()) expect(b.cz).toBeLessThan(-100);
  });

  const pairs: [string, string, string][] = [
    ['handle', 'chair-handle-left', 'chair-handle-right'],
    ['storage', 'chair-storage-left', 'chair-storage-right'],
    ['wing', 'chair-wing-left', 'chair-wing-right'],
    ['wheel-mount', 'chair-wheel-mount-left', 'chair-wheel-mount-right'],
    ['caster-std', 'chair-caster-std-left', 'chair-caster-std-right'],
    ['caster-kit', 'chair-caster-kit-left', 'chair-caster-kit-right'],
  ];
  it.each(pairs)('%s left/right are mirrored across x=0', (_name, leftId, rightId) => {
    const l = boxes.get(leftId)!;
    const r = boxes.get(rightId)!;
    expect(l.cx).toBeGreaterThan(0);
    expect(r.cx).toBeLessThan(0);
    expect(Math.abs(l.cx + r.cx)).toBeLessThan(2); // symmetric about the chair centerline
    expect(Math.abs(l.cy - r.cy)).toBeLessThan(2); // same height
    expect(Math.abs(l.cz - r.cz)).toBeLessThan(2); // same depth
  });

  it.each([['chair-seat-center'], ['chair-seat-back-bottom'], ['chair-seat-back-top']])(
    '%s sits on the chair centerline',
    (id) => {
      expect(Math.abs(boxes.get(id)!.cx)).toBeLessThan(2);
    },
  );

  it.each([
    ['left', 'chair-caster-std-left', 'chair-caster-kit-left'],
    ['right', 'chair-caster-std-right', 'chair-caster-kit-right'],
  ])('Standard and Kit caster mounts share the %s mounting location', (_side, stdId, kitId) => {
    // the two variants are mutually exclusive replacements for the same spot, so they overlap
    const s = boxes.get(stdId)!;
    const k = boxes.get(kitId)!;
    expect(Math.abs(s.cx - k.cx)).toBeLessThan(10);
    expect(Math.abs(s.cy - k.cy)).toBeLessThan(10);
    expect(Math.abs(s.cz - k.cz)).toBeLessThan(10);
  });
});
