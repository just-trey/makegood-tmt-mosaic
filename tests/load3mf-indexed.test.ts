// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { load3MF } from '../src/geometry/meshparts';
import {
  read3MFIndexed,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/zonebake.mjs';

// The zone sidecar stores per-part vertex INDICES; a chart resolves them against load3MF's `vertices`
// at runtime, but those indices were assigned by the bake's read3MFIndexed. Both must enumerate the
// packed mesh in the same order or every chart resolves to the wrong 3D points — and the bbox/count
// fingerprint (order-independent) would not catch it. load3MF parses with DOMParser, read3MFIndexed
// with a regex scan; pin them together on a synthetic packed 3MF (a real mesh through jsdom's
// DOMParser is far too slow, per gen-templates.mjs). jsdom supplies DOMParser.

// distinct, order-revealing coords so any reordering by either reader shows up immediately
const VERTS = Array.from({ length: 8 }, (_, i) => [i + 0.5, i * 2 + 0.25, i * 3 - 1.75]);
const TRIS = [
  [0, 1, 2],
  [2, 3, 4],
  [4, 5, 6],
  [6, 7, 0],
];

async function packedSingleObject3MF(): Promise<Buffer> {
  const v = VERTS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const t = TRIS.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources><object id="1" type="model"><mesh>` +
    `<vertices>${v}</vertices><triangles>${t}</triangles>` +
    `</mesh></object></resources><build><item objectid="1"/></build></model>`;
  const zip = new JSZip();
  zip.file('3D/3dmodel.model', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('load3MF vs read3MFIndexed vertex order', () => {
  it('enumerate a single-object 3MF in the same order and values', async () => {
    const buf = await packedSingleObject3MF();
    const runtime = await load3MF(new Uint8Array(buf).buffer);
    const baked = await read3MFIndexed(buf);

    expect(runtime.vertices.length).toBe(VERTS.length * 3);
    expect(baked.verts.length).toBe(VERTS.length);
    expect(runtime.triCount).toBe(TRIS.length);
    for (let i = 0; i < VERTS.length; i++) {
      for (let k = 0; k < 3; k++) {
        expect(runtime.vertices[i * 3 + k]).toBeCloseTo(VERTS[i][k], 5);
        expect(baked.verts[i][k]).toBeCloseTo(VERTS[i][k], 5);
      }
    }
  });
});
