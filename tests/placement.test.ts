import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  readMesh,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/mesh.mjs';
import {
  read3MFIndexed,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/zonebake.mjs';
import JSZip from 'jszip';
import { meshFingerprint } from '../src/geometry/zoneCharts';
import { PLACEMENT, placementNotice, resolvePlacement } from '../src/export/placement';
import { PART_FINGERPRINTS } from '../src/export/partFingerprints';
import { build3MFCombined, FOOTREST_PLATE_R, type ExportPart } from '../src/export/threemf';
import { getPrinter } from '../src/export/printers';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import type { AssemblyPart } from '../src/types';

// Guards the mesh-identity seal export placement relies on (src/export/placement.ts): every part
// PLACEMENT can place is sealed, every sealed part's shipped mesh still matches its seal, and
// resolvePlacement actually refuses a mismatched or foreign mesh rather than silently applying a
// baked pose to the wrong geometry. Reads only tracked public/stl assets.

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const stlPath = (id: string): string => resolve(REPO, 'public/stl', `${id}.3mf`);

interface ManifestEntry {
  id: string;
  name: string;
  file: string;
}
const manifest: ManifestEntry[] = JSON.parse(
  readFileSync(resolve(REPO, 'public/stl/parts.json'), 'utf8'),
);

// Every library part id a role in ASSEMBLY_KINDS can actually load — the renamed-part-id guard
// walks this set rather than trusting PLACEMENT or parts.json alone, so a rename in either place
// that drifts from the other fails here.
//
// `generatedOnly` splits off the ids belonging to a role that BUILDS its mesh from the asset
// (AssemblyRole.buildMesh) instead of loading it: those still ship a real asset that must be
// listed and sealed, but they can carry no baked placement, because a pose is verified against
// one exact mesh and theirs is built to vary. Requiring a PLACEMENT entry for them would force a
// constant that resolvePlacement is guaranteed to refuse.
function reachableLibraryPartIds(generatedOnly = false): Set<string> {
  const ids = new Set<string>();
  for (const kind of ASSEMBLY_KINDS)
    for (const role of kind.roles) {
      if (!!role.buildMesh !== generatedOnly) continue;
      if (role.libraryPartId) ids.add(role.libraryPartId);
      if (role.libraryPartIdByVariant)
        Object.values(role.libraryPartIdByVariant).forEach((id) => ids.add(id));
    }
  return ids;
}

/** Both halves — what parts.json must list and what PART_FINGERPRINTS must seal. */
function allLibraryPartIds(): Set<string> {
  return new Set([...reachableLibraryPartIds(), ...reachableLibraryPartIds(true)]);
}

const soupCache = new Map<string, Float32Array>();
async function soupOf(id: string): Promise<Float32Array> {
  let soup = soupCache.get(id);
  if (!soup) {
    soup = await readMesh(stlPath(id));
    soupCache.set(id, soup!);
  }
  return soup!;
}

function makePart(overrides: Partial<AssemblyPart> = {}): AssemblyPart {
  return {
    id: 1,
    name: 'test part',
    roleId: 'role',
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
    topZ: 0,
    baseDepth: 0,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
    ...overrides,
  };
}

describe('renamed/drifted part ids', () => {
  it('every id a role can load has both a PLACEMENT entry and a fingerprint seal', () => {
    for (const id of reachableLibraryPartIds()) {
      expect(PLACEMENT, id).toHaveProperty(id);
      expect(PART_FINGERPRINTS, id).toHaveProperty(id);
    }
  });

  it('a generated role ships a sealed asset but claims no baked placement', () => {
    const generated = reachableLibraryPartIds(true);
    expect(generated.size).toBeGreaterThan(0); // the hubcap clips; guards the split above
    for (const id of generated) {
      expect(PART_FINGERPRINTS, id).toHaveProperty(id);
      expect(PLACEMENT, id).not.toHaveProperty(id);
    }
  });

  it('PLACEMENT carries no id a role can no longer load', () => {
    const reachable = reachableLibraryPartIds();
    for (const id of Object.keys(PLACEMENT)) expect(reachable.has(id), id).toBe(true);
  });

  it('parts.json and the reachable-role set agree exactly', () => {
    const reachable = [...allLibraryPartIds()].sort();
    const listed = manifest.map((e) => e.id).sort();
    expect(listed).toEqual(reachable);
  });
});

describe('PART_FINGERPRINTS seal', () => {
  it('matches every shipped part.json asset', async () => {
    for (const entry of manifest) {
      const soup = await soupOf(entry.id);
      const got = meshFingerprint(soup, soup.length / 9);
      expect(got, entry.id).toEqual(PART_FINGERPRINTS[entry.id]);
    }
  }, 60000);

  it('agrees whether computed from the triangle soup or the indexed vertex list', async () => {
    for (const id of ['footrest', 'wheel-half', 'chair-seat-center']) {
      const soup = await soupOf(id);
      const fromSoup = meshFingerprint(soup, soup.length / 9);

      const indexed = await read3MFIndexed(readFileSync(stlPath(id)));
      const vertices = new Float32Array(indexed.verts.length * 3);
      indexed.verts.forEach((v: number[], i: number) => vertices.set(v, i * 3));
      const fromVertices = meshFingerprint(vertices, indexed.tris.length);

      expect(fromVertices, id).toEqual(fromSoup);
    }
  });
});

describe('resolvePlacement', () => {
  it('returns the verified baked placement for the real library mesh', async () => {
    const soup = await soupOf('footrest');
    const part = makePart({ roleId: 'footrest', libraryPartId: 'footrest', positions: soup });
    const res = resolvePlacement(part);
    expect(res.verified).toBe(true);
    if (res.verified) expect(res.placement.plateR).toEqual(FOOTREST_PLATE_R);
  });

  it('refuses a library part id whose loaded mesh no longer matches its seal', async () => {
    const soup = await soupOf('footrest');
    // push one coordinate far outside the mesh's real extent — same triangle count, guaranteed
    // to move the bbox (and so the hash) no matter which vertex index 0 happens to be
    const tampered = Float32Array.from(soup);
    tampered[0] += 1000;
    const part = makePart({
      roleId: 'footrest',
      libraryPartId: 'footrest',
      positions: tampered,
    });
    const res = resolvePlacement(part);
    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.reason).toBe('mesh-mismatch');
  });

  it('reports an id with no PLACEMENT entry as unknown-part', () => {
    const part = makePart({
      roleId: 'nonexistent-role',
      libraryPartId: 'nonexistent-part',
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    });
    const res = resolvePlacement(part);
    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.reason).toBe('unknown-part');
  });

  // The roleId fallback is what a part with no libraryPartId resolves through, so it has to be
  // held to the same seal as an id — otherwise a role name alone would buy the baked pose.
  it('refuses the footrest placement to a mesh that resolves by roleId but fails the seal', () => {
    const foreign = Float32Array.from([0, 0, 0, 40, 0, 0, 0, 40, 0]);
    const part = makePart({ roleId: 'footrest', positions: foreign });
    const res = resolvePlacement(part);
    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.reason).toBe('mesh-mismatch');
  });

  it('resolves the roleId fallback when the mesh really is the shipped one', async () => {
    const soup = await soupOf('footrest');
    const part = makePart({ roleId: 'footrest', positions: soup });
    const res = resolvePlacement(part);
    expect(res.verified).toBe(true);
    if (res.verified) expect(res.placement.plateR).toEqual(FOOTREST_PLATE_R);
  });

  it('reports a role id that is not a PLACEMENT key as unknown-part', () => {
    const foreign = Float32Array.from([0, 0, 0, 40, 0, 0, 0, 40, 0]);
    // a chair role id is never a PLACEMENT key — those are keyed by library part id
    const part = makePart({ roleId: 'handle-left', positions: foreign });
    const res = resolvePlacement(part);
    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.reason).toBe('unknown-part');
  });
});

describe('placementNotice', () => {
  const foreign = Float32Array.from([0, 0, 0, 40, 0, 0, 0, 40, 0]);
  const noticeFor = (part: AssemblyPart) => placementNotice(part.name, resolvePlacement(part));

  it('says nothing when the placement verified', async () => {
    const soup = await soupOf('footrest');
    expect(
      noticeFor(makePart({ roleId: 'footrest', libraryPartId: 'footrest', positions: soup })),
    ).toBeNull();
  });

  // A renamed id and a re-packed mesh need different fixes (update the table vs. re-verify and
  // reseal), so the text has to tell them apart rather than sharing one "doesn't match" message.
  it('distinguishes a missing part id from a mesh that drifted, and names the id', () => {
    const unknown = noticeFor(
      makePart({ name: 'Handle (left)', roleId: 'handle-left', libraryPartId: 'chair-handle-lft' }),
    );
    expect(unknown?.level).toBe('warn');
    expect(unknown?.message).toContain('no verified print placement');
    expect(unknown?.message).toContain('"chair-handle-lft"');

    const mismatch = noticeFor(
      makePart({
        name: 'Footrest',
        roleId: 'footrest',
        libraryPartId: 'footrest',
        positions: foreign,
      }),
    );
    expect(mismatch?.level).toBe('warn');
    expect(mismatch?.message).toContain('baked against');
    expect(mismatch?.message).not.toContain('no verified print placement');
  });

  // exportPanel clears a stale message by matching this suffix, so every variant must end with it
  // or a fixed export would keep showing the previous attempt's pill.
  it('ends every message with the shared suffix exportPanel clears on', () => {
    const parts = [
      makePart({ roleId: 'handle-left', libraryPartId: 'chair-handle-lft' }),
      makePart({ roleId: 'footrest', libraryPartId: 'footrest', positions: foreign }),
      makePart({ roleId: 'hubcap', assetPositions: foreign, positions: foreign }),
    ];
    for (const p of parts)
      expect(noticeFor(p)?.message).toMatch(
        /so it was placed automatically — check it in your slicer before printing\.$/,
      );
  });
});

// exportPanel.ts's real wiring is DOM code (overlay, download) that isn't unit-tested here; this
// exercises the same resolvePlacement -> spread-into-ExportPart path it uses, proving a mismatch
// actually changes the exported item's transform rather than just the resolver's return value.
describe('resolvePlacement wired into an export', () => {
  function toExportPart(
    name: string,
    positions: Float32Array,
    resolution: ReturnType<typeof resolvePlacement>,
  ): ExportPart {
    return {
      name,
      nsign: 1,
      bodySoup: positions,
      subs: [{ name: 'Body', matIndex: 0, soup: positions }],
      ...(resolution.verified ? resolution.placement : {}),
    };
  }

  it('only the verified footrest mesh exports at the baked standing rotation', async () => {
    const printer = getPrinter('bambu-x1c');

    const realSoup = await soupOf('footrest');
    const verifiedPart = makePart({
      roleId: 'footrest',
      libraryPartId: 'footrest',
      positions: realSoup,
    });
    const verifiedExport = toExportPart('Footrest', realSoup, resolvePlacement(verifiedPart));

    const foreignSoup = Float32Array.from([0, 0, 0, 40, 0, 0, 0, 40, 0]);
    const unverifiedPart = makePart({ roleId: 'footrest', positions: foreignSoup });
    const unverifiedExport = toExportPart(
      'Drifted mesh',
      foreignSoup,
      resolvePlacement(unverifiedPart),
    );

    const verified = await build3MFCombined(
      [{ name: 'Body', color: '#cccccc' }],
      [verifiedExport],
      { printer },
    );
    const unverified = await build3MFCombined(
      [{ name: 'Body', color: '#cccccc' }],
      [unverifiedExport],
      { printer },
    );

    const transformOf = async (blob: Blob): Promise<number[]> => {
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const model = await zip.file('3D/3dmodel.model')!.async('string');
      return model
        .match(/<item[^>]*transform="([^"]+)"/)![1]
        .split(/\s+/)
        .map(Number);
    };

    const vTransform = await transformOf(verified.blob);
    const uTransform = await transformOf(unverified.blob);

    const flatR = FOOTREST_PLATE_R.flat();
    for (let i = 0; i < 9; i++) expect(vTransform[i]).toBeCloseTo(flatR[i], 5);
    // the unverified part gets the default face-down tilt, not the baked standing rotation
    expect(uTransform.slice(0, 9)).not.toEqual(vTransform.slice(0, 9));
  });
});
