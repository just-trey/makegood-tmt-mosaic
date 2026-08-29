import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  build3MFCombined,
  groupByPlateHint,
  partsCarryPlateHints,
  plateColumns,
  rotXthenZ,
  soupToIndexed,
  xmlEscape,
  FOOTREST_OBJECT_SETTINGS,
  FOOTREST_PLATE_R,
  FOOTREST_PRIME_TOWER_DELTA,
  type ExportPart,
} from '../src/export/threemf';
import { CHAIR_PLACEMENT } from '../src/export/chairPlacement';
import { getPrinter } from '../src/export/printers';
import { PLACEMENT_WARNING_SUFFIXES } from '../src/ui/exportPanel';

/** The `transform` of every build item, in input-part order, from a built 3MF. */
async function itemTransforms(blob: Blob): Promise<number[][]> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const model = await zip.file('3D/3dmodel.model')!.async('string');
  return [...model.matchAll(/<item[^>]*transform="([^"]+)"/g)].map((m) =>
    m[1].split(/\s+/).map(Number),
  );
}

async function projectSettings(blob: Blob): Promise<Record<string, string[]>> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return JSON.parse(await zip.file('Metadata/project_settings.config')!.async('string'));
}

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

describe('groupByPlateHint', () => {
  // Shared by build3MFCombined and the pre-export summary, which promises the plate count the
  // export will produce. Two implementations of this rule would let the panel lie about a
  // multi-day print, so the rule is pinned here rather than in either caller.
  const names = (groups: { n: string }[][]) => groups.map((g) => g.map((x) => x.n));

  it('groups by hint, ascending', () => {
    const items = [
      { n: 'a', h: 2 },
      { n: 'b', h: 1 },
      { n: 'c', h: 2 },
    ];
    expect(names(groupByPlateHint(items, (i) => i.h))).toEqual([['b'], ['a', 'c']]);
  });

  it('gives every unhinted part its own plate, after the hinted ones', () => {
    const items = [
      { n: 'loose1', h: undefined },
      { n: 'pinned', h: 1 },
      { n: 'loose2', h: undefined },
    ];
    expect(names(groupByPlateHint(items, (i) => i.h))).toEqual([
      ['pinned'],
      ['loose1'],
      ['loose2'],
    ]);
  });

  it('knows when plate layout is determined by hints at all', () => {
    expect(partsCarryPlateHints([{ plateHint: 1 }, {}])).toBe(true);
    // Without a hint the greedy packer decides from real footprints, so no caller may state a
    // plate count before the geometry is placed.
    expect(partsCarryPlateHints([{}, {}])).toBe(false);
  });
});

describe('plateColumns', () => {
  // Pinned to real MakeGood project files rather than to the formula: 4-plates.3mf is laid out
  // 2x2 and the 12-plate complete-chair project 4x3. 2 -> 2 is what kept the wheel's two-plate
  // export correct while the exporter only ever strided along X.
  it('matches the plate grids the slicer actually writes', () => {
    expect(plateColumns(1)).toBe(1);
    expect(plateColumns(2)).toBe(2);
    expect(plateColumns(4)).toBe(2);
    expect(plateColumns(11)).toBe(4);
    expect(plateColumns(12)).toBe(4);
  });
});

describe('multi-plate world layout', () => {
  const tri = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  const part = (i: number): ExportPart => ({
    name: `P${i}`,
    nsign: 0,
    bodySoup: tri,
    subs: [{ name: 'Body', matIndex: 0, soup: tri }],
    plateHint: i + 1,
    plateR: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    fixedPos: { x: 20, y: 30 },
  });

  it('tiles 12 plates across the grid, +X across and -Y down', async () => {
    const printer = getPrinter('bambu-x1c');
    const parts = Array.from({ length: 12 }, (_, i) => part(i));
    const { blob } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], parts, {
      printer,
    });
    const xf = await itemTransforms(blob);
    expect(xf).toHaveLength(12);
    const strideX = printer.plate.w * 1.2;
    const strideY = printer.plate.d * 1.2;
    xf.forEach((v, i) => {
      expect(v[9]).toBeCloseTo(20 + (i % 4) * strideX, 4);
      expect(v[10]).toBeCloseTo(30 - Math.floor(i / 4) * strideY, 4);
    });
    // the last plate is a whole grid row down, not 11 columns out along a single row
    expect(xf[11][10]).toBeLessThan(0);
  });

  it('leaves a two-plate export on one row, as the wheel has always shipped it', async () => {
    const { blob } = await build3MFCombined(
      [{ name: 'Body', color: '#cccccc' }],
      [part(0), part(1)],
      { printer: getPrinter('bambu-x1c') },
    );
    const xf = await itemTransforms(blob);
    expect(xf[0][10]).toBeCloseTo(xf[1][10], 6); // same row
    expect(xf[1][9] - xf[0][9]).toBeCloseTo(256 * 1.2, 4);
  });

  it('suggests a free corner for a plate with no verified tower position', async () => {
    const printer = getPrinter('bambu-x1c');
    const { blob } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], [part(0)], {
      printer,
    });
    const proj = await projectSettings(blob);
    // anything but the plate center, which is where the part itself is
    const x = Number(proj.wipe_tower_x[0]);
    const y = Number(proj.wipe_tower_y[0]);
    expect(Math.hypot(x - printer.plate.w / 2, y - printer.plate.d / 2)).toBeGreaterThan(50);
    // The position is the tower's FRONT-LEFT CORNER, so a corner flush with the plate origin is
    // 0, not an inset half-width — what matters is that the whole nominal footprint is on the bed.
    // These read `> 0` while the suggestion was computed as a centre and written as a corner.
    const TOWER = 60;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + TOWER).toBeLessThanOrEqual(printer.plate.w);
    expect(y + TOWER).toBeLessThanOrEqual(printer.plate.d);
  });

  it('warns when two parts share a plate with no verified position between them', async () => {
    const loose = (name: string): ExportPart => ({
      ...part(0),
      name,
      fixedPos: undefined,
    });
    const { warnings } = await build3MFCombined(
      [{ name: 'Body', color: '#cccccc' }],
      [loose('A'), loose('B')],
      { printer: getPrinter('bambu-x1c') },
    );
    expect(warnings.join(' ')).toContain('"A", "B"');
    expect(warnings.join(' ')).toContain('double-check for overlap');
  });

  // A filled rectangle from the origin, so the part's plate footprint is exactly fixedPos..+w/+d.
  // Two triangles, not one: a right triangle has the same bounding box and only half the area, so
  // it left the far corner genuinely free while every assertion here reads it as occupied.
  // Two materials, because a plate down to one filament prints no tower to position.
  const box = (name: string, w: number, d: number, x: number, y: number): ExportPart => {
    const quad = new Float32Array([0, 0, 0, w, 0, 0, w, d, 0, 0, 0, 0, w, d, 0, 0, d, 0]);
    return {
      ...part(0),
      name,
      bodySoup: quad,
      subs: [
        { name: 'Body', matIndex: 0, soup: quad },
        { name: 'Red', matIndex: 1, soup: quad },
      ],
      fixedPos: { x, y },
    };
  };
  const twoMaterials = [
    { name: 'Body', color: '#cccccc' },
    { name: 'Red', color: '#c1272d' },
  ];

  /**
   * Every placement message the exporter can emit has to end with one of the suffixes the panel
   * clears on, or its pill sticks around after a printer switch describing a setup that is gone.
   *
   * Nothing pinned that pairing before, and the rot it allows is not hypothetical: rewording the
   * blocked-tower message left `scripts/export-hubcap-examples.mjs` matching a fragment no message
   * contained any more, so its check was permanently false on the one path it exists to run. The
   * suite stayed green throughout, because every other assertion matches a distinguishing phrase
   * from the middle of a message rather than the tail that does the clearing.
   */
  describe('placement warnings stay clearable', () => {
    const endsWithRegistered = (w: string) => PLACEMENT_WARNING_SUFFIXES.some((s) => w.endsWith(s));

    it('every corner blocked, so no position is written', async () => {
      const { warnings } = await build3MFCombined(twoMaterials, [box('Wide', 170, 170, 50, 50)], {
        printer: getPrinter('bambu-x1c'),
      });
      expect(warnings.length, 'this case is meant to produce a warning').toBeGreaterThan(0);
      warnings.forEach((w) =>
        expect(endsWithRegistered(w), `not clearable, so this pill would stick: ${w}`).toBe(true),
      );
    });

    it('one plate blocked while another carries a verified position', async () => {
      const { warnings } = await build3MFCombined(
        twoMaterials,
        [
          { ...box('Wide', 170, 170, 50, 50), plateHint: 1 },
          { ...box('Small', 20, 20, 50, 50), plateHint: 2, primeTowerDelta: { x: 10, y: 10 } },
        ],
        { printer: getPrinter('bambu-x1c') },
      );
      expect(warnings.length, 'this case is meant to produce a warning').toBeGreaterThan(0);
      warnings.forEach((w) =>
        expect(endsWithRegistered(w), `not clearable, so this pill would stick: ${w}`).toBe(true),
      );
    });

    // The off-plate arm, which the two cases above do not reach: they warn about a blocked tower,
    // not about a part past the edge. Rewording that message's tail broke its clearing once.
    it('a part placed off the plate', async () => {
      const { warnings } = await build3MFCombined(
        twoMaterials,
        [box('Overhang', 40, 40, 230, 100)],
        { printer: getPrinter('bambu-x1c') },
      );
      expect(warnings.length, 'this case is meant to produce a warning').toBeGreaterThan(0);
      warnings.forEach((w) =>
        expect(endsWithRegistered(w), `not clearable, so this pill would stick: ${w}`).toBe(true),
      );
    });

    // A full stop mid-message is where a reworded warning goes wrong quietly: the em-dash sweep
    // put one in front of a lowercase word across a concatenation seam, which reads as a typo and
    // no assertion on a distinguishing phrase would ever see.
    it('never starts a sentence with a lowercase word', async () => {
      const cases = await Promise.all([
        build3MFCombined(twoMaterials, [box('Overhang', 40, 40, 230, 100)], {
          printer: getPrinter('bambu-x1c'),
        }),
        build3MFCombined(twoMaterials, [box('Wide', 170, 170, 50, 50)], {
          printer: getPrinter('bambu-x1c'),
        }),
      ]);
      const all = cases.flatMap((c) => c.warnings);
      expect(all.length, 'these cases are meant to produce warnings').toBeGreaterThan(0);
      all.forEach((w) =>
        expect(/\.\s+[a-z]/.test(w), `sentence starts lowercase: ${w}`).toBe(false),
      );
    });

    // Two parts sharing a plate with no verified position between them: the third producer of a
    // placement warning. Coverage for that arm, not a regression test: its tail was never broken.
    it('parts stacked on the plate center with no verified position', async () => {
      // fixedPos removed: the branch is for parts with no verified position of their own.
      const loose = (name: string) => {
        const b = box(name, 40, 40, 60, 60);
        return { ...b, fixedPos: undefined };
      };
      const { warnings } = await build3MFCombined(twoMaterials, [loose('A'), loose('B')], {
        printer: getPrinter('bambu-x1c'),
      });
      expect(warnings.length, 'this case is meant to produce a warning').toBeGreaterThan(0);
      warnings.forEach((w) =>
        expect(endsWithRegistered(w), `not clearable, so this pill would stick: ${w}`).toBe(true),
      );
    });

    // Two parts in an L: every corner is inside their combined bounding box, but the notch between
    // them is free. Choosing the insets per axis lands in the top-right part instead.
    it('puts the suggested tower in a corner no part occupies, not one only the axes agree on', async () => {
      const printer = getPrinter('bambu-x1c');
      const { blob, warnings } = await build3MFCombined(
        twoMaterials,
        [box('L', 110, 236, 10, 10), box('R', 110, 110, 136, 136)],
        { printer },
      );
      const proj = await projectSettings(blob);
      const TOWER = 60;
      const x = Number(proj.wipe_tower_x[0]);
      const y = Number(proj.wipe_tower_y[0]);
      // the free notch is the front-right corner: right half, front edge. The figures moved by half
      // a tower when the suggestion stopped being a centre written out as a corner.
      expect(x).toBeGreaterThanOrEqual(printer.plate.w / 2);
      expect(x + TOWER).toBeLessThanOrEqual(printer.plate.w);
      expect(y + TOWER).toBeLessThan(printer.plate.d / 2);
      // Matched against what the exporter actually emits. 'move the tower' stopped being any part
      // of a shipped message, so asserting its absence pinned nothing at all.
      expect(warnings.join(' ')).not.toContain('has no verified position');
    });

    it('warns instead of parking the tower inside a part when every corner is occupied', async () => {
      const { warnings } = await build3MFCombined(twoMaterials, [box('Wide', 170, 170, 50, 50)], {
        printer: getPrinter('bambu-x1c'),
      });
      // Every plate here is blocked, so no wipe_tower_x/y is written and the message must say so
      // rather than naming a position. "It was parked at (270, 240)" quoted coordinates that appear
      // nowhere in the file; the other arm ("Move the tower in your slicer") would name one the user
      // cannot move, because none was saved.
      expect(warnings.join(' ')).toContain('No tower position was saved');
      expect(warnings.join(' ')).not.toMatch(/parked at \(/);
    });

    // The mixed case, which is where the first rewording of this message was wrong. A blocked plate
    // sitting alongside one with a verified position still gets its corner written — the omission is
    // all-or-nothing, since these keys are per-plate arrays — so there IS a position, and telling the
    // user their slicer would place it was false.
    it('tells the user to move a tower that was written, when another plate has one', async () => {
      const verified: ExportPart = {
        ...box('Small', 20, 20, 50, 50),
        plateHint: 2,
        primeTowerDelta: { x: 10, y: 10 },
      };
      const blocked: ExportPart = { ...box('Wide', 170, 170, 50, 50), plateHint: 1 };
      const { blob, warnings } = await build3MFCombined(twoMaterials, [blocked, verified], {
        printer: getPrinter('bambu-x1c'),
      });

      const proj = await projectSettings(blob);
      expect(proj.wipe_tower_x, 'a position was written for both plates').toHaveLength(2);
      expect(warnings.join(' ')).toMatch(/It was put at \(\d+, \d+\), so move the tower/);
      expect(warnings.join(' ')).not.toContain('No tower position was saved');
    });

    // A single-filament plate prints no tower, so it has no opinion on whether a position is worth
    // asserting. Letting it vote turned the all-or-nothing gate off: measured by review, a 240mm
    // two-material disc beside a plate of single-filament clips wrote wipe_tower_x for BOTH,
    // pinning the disc plate's tower at a corner just measured as overlapping it.
    it('does not let a plate that prints no tower unblock the gate', async () => {
      const disc: ExportPart = { ...box('Disc', 240, 240, 8, 8), plateHint: 1 };
      const clips = { ...box('Clips', 40, 40, 8, 8), plateHint: 2 };
      clips.subs = clips.subs.slice(0, 1); // one filament: no tower on that plate

      const { blob, warnings } = await build3MFCombined(twoMaterials, [disc, clips], {
        printer: getPrinter('bambu-x1c'),
      });

      const proj = await projectSettings(blob);
      expect(proj.wipe_tower_x, 'a colliding corner was written anyway').toBeUndefined();
      expect(warnings.join(' ')).toContain('No tower position was saved');
    });

    // The same crowded plate, minus the second filament: no tower gets printed there, so the
    // position it would have had is not worth a warning.
    it('stays quiet about the tower on a plate that prints one filament', async () => {
      const single = { ...box('Wide', 170, 170, 50, 50) };
      single.subs = single.subs.slice(0, 1);
      const { warnings } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], [single], {
        printer: getPrinter('bambu-x1c'),
      });
      // Matched against what the exporter actually emits. 'move the tower' stopped being any part
      // of a shipped message, so asserting its absence pinned nothing at all.
      expect(warnings.join(' ')).not.toContain('has no verified position');
    });

    // Size and position are separate claims: this part fits the plate at some position, just not at
    // the one it was given — the shape a verified fixedPos takes on a bed it wasn't verified against.
    it('warns about a part placed off the plate, not only one too big for it', async () => {
      const { warnings } = await build3MFCombined(
        twoMaterials,
        [box('Overhang', 40, 40, 230, 100)],
        {
          printer: getPrinter('bambu-x1c'),
        },
      );
      expect(warnings.join(' ')).toContain('"Overhang" is placed ~14mm past the edge');
      expect(warnings.join(' ')).toContain('Reposition it in your slicer');
      expect(warnings.join(' ')).not.toContain('best-fit rotation');
    });
  });

  describe('CHAIR_PLACEMENT', () => {
    const entries = Object.entries(CHAIR_PLACEMENT);

    it('covers all 15 chair pieces on the reference plates', () => {
      expect(entries).toHaveLength(15);
      for (const [, p] of entries) {
        expect(p.plateHint).toBeGreaterThanOrEqual(1);
        expect(p.plateHint).toBeLessThanOrEqual(12);
      }
    });

    // A mirrored (determinant -1) matrix would print the opposite hand of the part and look
    // plausible in every other check, so pin the handedness explicitly.
    it('bakes proper rotations, never a mirror', () => {
      for (const [id, { plateR: R }] of entries) {
        const det =
          R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
          R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
          R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
        expect(det, `${id} determinant`).toBeCloseTo(1, 4);
        for (const row of R) expect(Math.hypot(...row)).toBeCloseTo(1, 4);
      }
    });

    it('keeps the two caster variants on separate plates', () => {
      const plate = (id: string) => CHAIR_PLACEMENT[id].plateHint;
      expect(plate('chair-caster-std-left')).toBe(plate('chair-caster-std-right'));
      expect(plate('chair-caster-kit-left')).toBe(plate('chair-caster-kit-right'));
      expect(plate('chair-caster-std-left')).not.toBe(plate('chair-caster-kit-left'));
    });

    // The seat-back plate is the export's first two-part group. Its members must keep their verified
    // spacing when the group is re-centered for a bed that isn't the reference's 256x256.
    it('holds a shared plate together across bed sizes', async () => {
      const tri = new Float32Array([0, 0, 0, 40, 0, 0, 0, 40, 0]);
      const mk = (id: string): ExportPart => ({
        name: id,
        nsign: 0,
        bodySoup: tri,
        subs: [{ name: 'Body', matIndex: 0, soup: tri }],
        ...CHAIR_PLACEMENT[id],
      });
      const parts = [mk('chair-seat-back-top'), mk('chair-seat-back-bottom')];
      const gaps: number[][] = [];
      for (const printerId of ['bambu-x1c', 'snapmaker-u1']) {
        const { blob } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], parts, {
          printer: getPrinter(printerId),
        });
        const xf = await itemTransforms(blob);
        expect(xf).toHaveLength(2);
        gaps.push([xf[0][9] - xf[1][9], xf[0][10] - xf[1][10]]);
      }
      expect(gaps[0][0]).toBeCloseTo(gaps[1][0], 4);
      expect(gaps[0][1]).toBeCloseTo(gaps[1][1], 4);
    });

    it('uses the reference plate positions verbatim on the bed they were authored for', async () => {
      const tri = new Float32Array([0, 0, 0, 40, 0, 0, 0, 40, 0]);
      const id = 'chair-seat-center';
      const { blob } = await build3MFCombined(
        [{ name: 'Body', color: '#cccccc' }],
        [
          {
            name: id,
            nsign: 0,
            bodySoup: tri,
            subs: [{ name: 'Body', matIndex: 0, soup: tri }],
            ...CHAIR_PLACEMENT[id],
          },
        ],
        { printer: getPrinter('bambu-x1c') },
      );
      const v = (await itemTransforms(blob))[0];
      expect(v.slice(0, 9)).toEqual(CHAIR_PLACEMENT[id].plateR.flat());
      expect(v[9]).toBeCloseTo(CHAIR_PLACEMENT[id].fixedPos.x, 4);
      expect(v[10]).toBeCloseTo(CHAIR_PLACEMENT[id].fixedPos.y, 4);
    });

    // Exactly one anchor per plate: build3MFCombined takes the first part it finds carrying a delta,
    // so two on a plate would make the tower depend on part order.
    it('carries a verified tower on one anchor per plate, and none on the caster plates', () => {
      const anchors = new Map<number, string[]>();
      for (const [id, p] of entries)
        if (p.primeTowerDelta) anchors.set(p.plateHint, [...(anchors.get(p.plateHint) ?? []), id]);
      for (const [plate, ids] of anchors) expect(ids, `plate ${plate}`).toHaveLength(1);

      // Per-bed overrides only exist where a separately-verified bed disagreed with the default, so
      // one that merely restates it is a bake gone wrong — it would read as "checked here" while
      // carrying nothing that was.
      for (const [id, p] of entries)
        for (const [bed, d] of Object.entries(p.primeTowerDeltaByPlate ?? {})) {
          expect(p.primeTowerDelta, `${id} override for ${bed} without a default`).toBeDefined();
          const gap = Math.max(
            Math.abs(d.x - p.primeTowerDelta!.x),
            Math.abs(d.y - p.primeTowerDelta!.y),
          );
          expect(gap, `${id} override for ${bed} matches the default`).toBeGreaterThan(0.05);
        }

      // The casters carry no design zones, so their plates print one filament and have no tower to
      // verify — both variants' plates must stay unbaked rather than pick up a guess.
      const casterPlates = ['chair-caster-std-left', 'chair-caster-kit-left'].map(
        (id) => CHAIR_PLACEMENT[id].plateHint,
      );
      const baked = [...anchors.keys()];
      for (const plate of casterPlates) expect(baked).not.toContain(plate);
      expect(baked).toHaveLength(new Set(entries.map(([, p]) => p.plateHint)).size - 2);
    });

    // The deltas are baked from a 270mm Snapmaker bed. On the A1's 256mm bed each plate group is
    // re-centered, and the tower has to travel with its part rather than stay at a bed coordinate —
    // otherwise a position verified against the part drifts onto it.
    it('keeps each tower fixed relative to its anchor across bed sizes, and on the bed', async () => {
      const tri = new Float32Array([0, 0, 0, 40, 0, 0, 0, 40, 0]);
      const anchors = entries.filter(([, p]) => p.primeTowerDelta);
      const parts: ExportPart[] = anchors.map(([id]) => ({
        name: id,
        nsign: 0,
        bodySoup: tri,
        subs: [{ name: 'Body', matIndex: 0, soup: tri }],
        ...CHAIR_PLACEMENT[id],
      }));

      for (const printerId of ['bambu-x1c', 'snapmaker-u1']) {
        const printer = getPrinter(printerId);
        const { blob } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], parts, {
          printer,
        });
        const xf = await itemTransforms(blob);
        const proj = await projectSettings(blob);
        expect(xf).toHaveLength(anchors.length);

        // wipe_tower_x/y are plate-local, but an item transform carries the plate-grid stride that
        // spreads the logical plates out in world space — take it back off before comparing.
        const cols = plateColumns(anchors.length);
        const bedKey = `${printer.plate.w}x${printer.plate.d}`;
        anchors.forEach(([id], i) => {
          // A bed that was verified separately overrides the default delta; every other bed inherits
          // it. Resolving it the same way the exporter does is the point of the check.
          const delta =
            CHAIR_PLACEMENT[id].primeTowerDeltaByPlate?.[bedKey] ??
            CHAIR_PLACEMENT[id].primeTowerDelta!;
          const localX = xf[i][9] - (i % cols) * printer.plate.w * 1.2;
          const localY = xf[i][10] + Math.floor(i / cols) * printer.plate.d * 1.2;
          const towerX = Number(proj.wipe_tower_x[i]);
          const towerY = Number(proj.wipe_tower_y[i]);
          expect(towerX, `${id} on ${printerId}`).toBeCloseTo(localX + delta.x, 3);
          expect(towerY, `${id} on ${printerId}`).toBeCloseTo(localY + delta.y, 3);

          // Landing on the bed is only checkable on the 256x256 reference plate, where fixedPos is
          // used verbatim and the answer doesn't depend on the mesh. Every other bed re-centers the
          // plate group on its parts' real footprints, which these stand-in triangles are not — so
          // asserting bounds there would be testing the placeholder geometry. How much clearance the
          // tower actually needs comes from the slicer's own prime_tower_width;
          // scripts/export-chair-examples.mjs checks that against the files it builds.
          if (printerId !== 'bambu-x1c') return;
          expect(towerX, `${id} on ${printerId}`).toBeGreaterThan(0);
          expect(towerY, `${id} on ${printerId}`).toBeGreaterThan(0);
          expect(towerX, `${id} on ${printerId}`).toBeLessThan(printer.plate.w);
          expect(towerY, `${id} on ${printerId}`).toBeLessThan(printer.plate.d);
        });
      }
    });
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
      objectSettings: FOOTREST_OBJECT_SETTINGS,
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

  it('writes the per-part support-off override into model_settings', async () => {
    const { blob } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], [makePart()], {
      printer: getPrinter('bambu-x1c'),
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const cfg = await zip.file('Metadata/model_settings.config')!.async('string');
    // the footrest object block carries the baked per-object override
    const objBlock = cfg.slice(cfg.indexOf('<object'), cfg.indexOf('</object>'));
    expect(objBlock).toContain('<metadata key="enable_support" value="0"/>');
  });

  it('disables brim globally for every part in project_settings', async () => {
    const { blob } = await build3MFCombined([{ name: 'Body', color: '#cccccc' }], [makePart()], {
      printer: getPrinter('bambu-x1c'),
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const proj = JSON.parse(
      await zip.file('Metadata/project_settings.config')!.async('string'),
    ) as { brim_type: string; different_settings_to_system: string[] };
    expect(proj.brim_type).toBe('no_brim');
    // tracked as an intentional override so a reload can't reconcile it back to the preset default
    expect(proj.different_settings_to_system[0]).toContain('brim_type');
  });
});
