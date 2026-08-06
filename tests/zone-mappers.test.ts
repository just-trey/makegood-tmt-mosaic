import { describe, expect, it } from 'vitest';
import { primaryZoneMapper, zoneMappersFor } from '../src/geometry/zoneMappers';
import { ConformalZoneMapper, type ConformalChart } from '../src/geometry/conformal';
import type { AssemblyPart, DesignZone } from '../src/types';

/** A 10×10mm square in the z=0 plane, UV in true mm — the smallest chart a mapper will accept. */
function squareChart(): ConformalChart {
  return {
    positions3: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
    uv: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
    normalSign: 1,
    boundary: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    zoneBounds: { minU: 0, minV: 0, maxU: 10, maxV: 10 },
  };
}

function part(zones: DesignZone[] | undefined): AssemblyPart {
  return {
    id: 1,
    name: 'p',
    roleId: 'r',
    // a flat square patch, so the implicit (flat) fallback has something real to build from
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0]),
    patches: [{ normal: [0, 0, 1], offset: 0, area: 100, triIndices: [0, 1] }],
    patchIdx: 0,
    boundaryLoop: null,
    topZ: 0,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
    zones,
  } as unknown as AssemblyPart;
}

const zone = (id: string): DesignZone => ({ id, name: id, chart: squareChart() });

describe('zoneMappersFor', () => {
  it('gives a part with no sidecar the one implicit flat zone', () => {
    const p = part(undefined);

    const mappers = zoneMappersFor(p, [p], false, null);

    expect(mappers).toHaveLength(1);
    expect(mappers[0]).not.toBeInstanceOf(ConformalZoneMapper);
  });

  it('gives a part the bake left empty NO zones — not the flat fallback', () => {
    // A chair caster mount has no design surface; stamping artwork on its largest flat face
    // would be worse than leaving it plain (the AssemblyPart.zones contract).
    const p = part([]);

    expect(zoneMappersFor(p, [p], false, null)).toEqual([]);
  });

  it('builds one conformal mapper per baked zone, in the part’s zone order', () => {
    const p = part([zone('front'), zone('back')]);

    const mappers = zoneMappersFor(p, [p], false, null);

    expect(mappers).toHaveLength(2);
    expect(mappers.every((m) => m instanceof ConformalZoneMapper)).toBe(true);
  });

  it('skips a zone whose chart failed to reconstruct, keeping the ones that survived', () => {
    // A chartless entry means reconstruction failed — cutting it would stamp that zone's artwork
    // onto the part's unrelated flat patch.
    const p = part([zone('front'), { id: 'broken', name: 'broken' }, zone('back')]);

    const mappers = zoneMappersFor(p, [p], false, null);

    expect(mappers).toHaveLength(2);
    expect(mappers.every((m) => m instanceof ConformalZoneMapper)).toBe(true);
  });

  it('drops to zero mappers when every zone lost its chart, rather than falling back to flat', () => {
    const p = part([{ id: 'broken', name: 'broken' }]);

    expect(zoneMappersFor(p, [p], false, null)).toEqual([]);
  });
});

describe('primaryZoneMapper', () => {
  it('is the first baked zone — what the on-face gizmo reads its frame from', () => {
    const p = part([zone('front'), zone('back')]);

    const all = zoneMappersFor(p, [p], false, null);
    const primary = primaryZoneMapper(p, [p], false);

    expect(primary).toBeInstanceOf(ConformalZoneMapper);
    expect(all).toHaveLength(2); // and the gizmo takes only the first of them
  });

  it('is the implicit flat zone for a part with no sidecar', () => {
    const p = part(undefined);

    const primary = primaryZoneMapper(p, [p], false);

    expect(primary).not.toBeNull();
    expect(primary).not.toBeInstanceOf(ConformalZoneMapper);
  });

  it('is null for a part the bake gave no zones — the gizmo has nothing to attach to', () => {
    expect(primaryZoneMapper(part([]), [part([])], false)).toBeNull();
  });

  it('is null when the only zone lost its chart', () => {
    const p = part([{ id: 'broken', name: 'broken' }]);

    expect(primaryZoneMapper(p, [p], false)).toBeNull();
  });

  it('builds a read-only mapper — no boolean engine needed for the gizmo’s frame', () => {
    const p = part([zone('front')]);

    // primaryZoneMapper passes wasm: null; constructing must not throw
    expect(() => primaryZoneMapper(p, [p], false)).not.toThrow();
  });
});
