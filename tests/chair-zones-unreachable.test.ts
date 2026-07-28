// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/app/scheduler', () => ({
  scheduleRebuild: vi.fn(),
  isRebuildLikelySlow: () => false,
}));

import { asmCreateRolePart, asmLoadPartBuffer } from '../src/assembly/parts';
import { zoneMappersFor } from '../src/geometry/zoneMappers';
import { loadZonesSidecar, SIDECAR_SCHEMA } from '../src/geometry/zoneCharts';
import { state } from '../src/state/store';
import { WARNINGS } from '../src/warnings';
import type { AssemblyRole } from '../src/types';

// A minimal packed 3MF in the single-inlined-<object> shape load3MF reads. Synthetic on purpose:
// the sidecar fetch is what's under test and it fails before any mesh check, and a real chair mesh
// through jsdom's DOMParser is far too slow (same reasoning as tests/load3mf-indexed.test.ts).
async function tinyPacked3MF(): Promise<ArrayBuffer> {
  const verts = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
  ];
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources><object id="1" type="model"><mesh><vertices>` +
    verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('') +
    `</vertices><triangles>` +
    `<triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="2" v3="3"/>` +
    `</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const zip = new JSZip();
  zip.file('3D/3dmodel.model', xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return new Uint8Array(buf).buffer;
}

/**
 * A chair part whose zone sidecar can't be fetched must come back with NO design surfaces, not
 * with the implicit flat one. Falling through to the flat patch stamps the artwork
 * orthographically onto whatever the part's largest flat face happens to be — for a chair that's
 * worse than leaving the piece plain (see the AssemblyPart.zones contract in src/types.ts).
 */
describe('a chair part loaded with an unreachable zone sidecar', () => {
  beforeEach(() => {
    state.assembly.kindId = 'chair-body';
    WARNINGS.length = 0;
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
  });

  it('is left zoneless rather than falling back to flat stamping', async () => {
    const part = asmCreateRolePart({ id: 'r', name: 'r' } as unknown as AssemblyRole);
    part.libraryPartId = 'chair-storage-left'; // normally set by asmLoadLibraryEntryIntoPart

    await asmLoadPartBuffer(part, await tinyPacked3MF(), 'chair-storage-left.3mf');

    expect(part.zones).toEqual([]);
    expect(zoneMappersFor(part, [part], true, null)).toEqual([]);
    expect(WARNINGS.map((w) => w.message).join(' ')).toMatch(/design zones/i);
  });
});

/**
 * The mesh fingerprints guard the geometry pairing; the schema number guards the format. A
 * returning visitor can be holding a cached sidecar from an older release whose charts have no
 * per-part clip region at all — reading that with current code would clip every part to the whole
 * zone outline, which is exactly the failure the clip region exists to prevent.
 */
describe('a zone sidecar in an older format', () => {
  it('is rejected rather than read with its per-part clip regions missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schema: SIDECAR_SCHEMA - 1,
        kindId: 'chair-body',
        meshes: {},
        zones: [],
      }),
    }) as unknown as typeof fetch;

    await expect(loadZonesSidecar('stale-schema-zones.json')).rejects.toThrow(/schema/);
  });
});
