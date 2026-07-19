import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  build3MFCombined,
  rotXthenZ,
  soupToIndexed,
  xmlEscape,
  FOOTREST_PLATE_R,
  FOOTREST_PRIME_TOWER_DELTA,
  type ExportPart,
} from '../src/export/threemf';
import { getPrinter } from '../src/export/printers';

describe('soupToIndexed', () => {
  it('welds shared vertices across triangles', () => {
    // two triangles sharing the edge (1,0,0)-(0,1,0)
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const { verts, tris } = soupToIndexed(soup);
    expect(verts.length / 3).toBe(4); // 6 raw -> 4 unique
    expect(tris).toHaveLength(6);
    expect(tris.slice(0, 3)).toEqual([0, 1, 2]);
  });
});

describe('xmlEscape', () => {
  it('escapes XML metacharacters', () => {
    expect(xmlEscape('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
  });
});

describe('rotXthenZ', () => {
  it('is the identity for zero angles', () => {
    const R = rotXthenZ(0, 0);
    expect(R[0].map((v) => +v.toFixed(9))).toEqual([1, 0, 0]);
    expect(R[1].map((v) => +v.toFixed(9))).toEqual([0, 1, 0]);
    expect(R[2].map((v) => +v.toFixed(9))).toEqual([0, 0, 1]);
  });

  it('tilts a +Y face normal to +Z with theta = -90 (face-down layout math)', () => {
    // p' = p * R with row-vector convention
    const R = rotXthenZ(-90, 0);
    const p = [0, 1, 0];
    const out = [
      p[0] * R[0][0] + p[1] * R[1][0] + p[2] * R[2][0],
      p[0] * R[0][1] + p[1] * R[1][1] + p[2] * R[2][1],
      p[0] * R[0][2] + p[1] * R[1][2] + p[2] * R[2][2],
    ];
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[1]).toBeCloseTo(0, 10);
    expect(out[2]).toBeCloseTo(-1, 10);
  });
});

describe('build3MFCombined footrest placement', () => {
  // A single triangle with min-Z = -110 (like the real footrest mesh) so the rest-on-plate lift
  // (-minZ) reproduces the reference file's tz = 110 under the standing rotation.
  const tri = new Float32Array([0, 0, -110, 20, 0, -110, 0, 20, -5]);

  // The rotated footprint center (cx, cy) the exporter computes from the standing pose, so the
  // test can assert the part is centered (tx = plateW/2 - cx) without hardcoding a coordinate.
  function rotatedCenter(): { cx: number; cy: number } {
    const R = FOOTREST_PLATE_R;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (let i = 0; i < tri.length; i += 3) {
      const x = tri[i],
        y = tri[i + 1],
        z = tri[i + 2];
      const wx = x * R[0][0] + y * R[1][0] + z * R[2][0];
      const wy = x * R[0][1] + y * R[1][1] + z * R[2][1];
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minY = Math.min(minY, wy);
      maxY = Math.max(maxY, wy);
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  function makePart(): ExportPart {
    return {
      name: 'Footrest',
      nsign: 1,
      bodySoup: tri,
      subs: [{ name: 'Body', matIndex: 0, soup: tri }],
      plateHint: 1,
      plateR: FOOTREST_PLATE_R,
      primeTowerDelta: FOOTREST_PRIME_TOWER_DELTA,
      objectSettings: { brim_type: 'no_brim', enable_support: '0' },
    };
  }

  // Centering + relative tower must hold on any bed size, not a single reference plate.
  for (const printerId of ['bambu-x1c', 'snapmaker-u1']) {
    it(`centers the footrest and rides the prime tower along on ${printerId}`, async () => {
      const printer = getPrinter(printerId);
      const { blob } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], [makePart()], {
        printer,
      });
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const model = await zip.file('3D/3dmodel.model')!.async('string');
      const m = model.match(/<item[^>]*transform="([^"]+)"/);
      expect(m).not.toBeNull();
      const v = m![1].split(/\s+/).map(Number);

      // rotation (first 9) equals the baked standing pose, not a face-down tilt
      const flatR = FOOTREST_PLATE_R.flat();
      for (let i = 0; i < 9; i++) expect(v[i]).toBeCloseTo(flatR[i], 5);

      // translation centers the part on the plate (tx = plateW/2 - cx), z = rest-on-plate = 110
      const { cx, cy } = rotatedCenter();
      const tx = v[9],
        ty = v[10];
      expect(tx).toBeCloseTo(printer.plate.w / 2 - cx, 4);
      expect(ty).toBeCloseTo(printer.plate.d / 2 - cy, 4);
      expect(v[11]).toBeCloseTo(110, 4);

      // prime tower rides relative to the (centered) footrest: wipe_tower == translate + delta
      const proj = JSON.parse(
        await zip.file('Metadata/project_settings.config')!.async('string'),
      ) as { wipe_tower_x: string[]; wipe_tower_y: string[] };
      expect(Number(proj.wipe_tower_x[0])).toBeCloseTo(tx + FOOTREST_PRIME_TOWER_DELTA.x, 3);
      expect(Number(proj.wipe_tower_y[0])).toBeCloseTo(ty + FOOTREST_PRIME_TOWER_DELTA.y, 3);
    });
  }

  it('writes the per-part support-off / no-brim overrides into model_settings', async () => {
    const { blob } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], [makePart()], {
      printer: getPrinter('bambu-x1c'),
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const cfg = await zip.file('Metadata/model_settings.config')!.async('string');
    // the footrest object block carries the baked per-object overrides
    const objBlock = cfg.slice(cfg.indexOf('<object'), cfg.indexOf('</object>'));
    expect(objBlock).toContain('<metadata key="brim_type" value="no_brim"/>');
    expect(objBlock).toContain('<metadata key="enable_support" value="0"/>');
  });
});
