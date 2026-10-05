// How narrow does the design INK this repo ships actually get once clipped to a real part, against
// CLIP_REMNANT_FLOOR_MM2 (src/geometry/depth.ts)? Written for docs/tech-debt.md "Nobody has swept
// the design ink CLIP_REMNANT_FLOOR_MM2 actually guards" — measure-cut-width.mjs and
// measure-seam-overlap.mjs already swept the BAKE's population (part geometry); this sweeps the
// runtime one, a placed design's ink clipped to a part (`placedInk` in designClip.ts, `dropSpecks` in colorPrism.ts).
//
// Runs the four shipped patterns (public/patterns/*.svg) as real Fill designs through the real
// buildAssemblyGeometry pipeline, on real parts for every assembly kind that has one (wheel-half,
// wheel-hub-cap, footrest, a generated hubcap disc, and a representative subset of chair-body
// zones), and records the area of every piece dropUnprintableRemnants sees BEFORE the floor is
// applied — by intercepting the real call with vi.mock (partial passthrough: every other export is
// the real one), not by re-implementing its decomposition. See docs/findings/2026-09-27-clip-ink-sweep.md
// for the numbers this produced and what they mean for the tech-debt section.
//
// Usage: RUN_CLIP_INK_SWEEP=1 npx vitest run scripts/measure-clip-ink.test.ts
// Skipped by default (see the describe.skipIf below) — a full run takes several minutes of real
// CSG, not something every `npm test` should pay for.
// @vitest-environment jsdom
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// jsdom has no 2d canvas — same stub as tests/patterns-assets.test.ts, enough to resolve the
// patterns' plain #rrggbb fills.
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

interface Hit {
  label: string;
  area: number;
  w: number;
  h: number;
}
const pieceAreas: Hit[] = [];
let currentLabel = '';

/** bbox of a single piece's rings (outer + holes), for the aspect-ratio check below. */
function bboxOfPiece(coordinates: number[][][]): { w: number; h: number } {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const ring of coordinates)
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  return { w: x1 - x0, h: y1 - y0 };
}

// Partial mock: every export is the real one except dropUnprintableRemnants, which records the
// area of each piece it is handed (the exact decomposition the real floor uses, mirrored from the
// function's own toGeom+planarArea split) and then calls straight through to the real
// implementation. This taps the live call sites (placedInkFeatures, dropSpecks)
// rather than re-deriving their clip logic — a reimplementation is the wrong kind of measurement
// (bench-replica-must-be-verbatim, #218).
vi.mock('../src/geometry/regions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/geometry/regions')>();
  const piecesOf = (f: { geometry: { type: string; coordinates: unknown } }) => {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : (g.coordinates as unknown[]);
    return polys.map((coordinates) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Polygon' as const, coordinates },
    }));
  };
  return {
    ...actual,
    dropUnprintableRemnants: (
      feat: Parameters<typeof actual.dropUnprintableRemnants>[0],
      floor: number,
    ) => {
      if (feat) {
        for (const p of piecesOf(
          feat as unknown as { geometry: { type: string; coordinates: unknown } },
        )) {
          const a = actual.planarArea(p as unknown as Parameters<typeof actual.planarArea>[0]);
          if (a > 0) {
            const { w, h } = bboxOfPiece(p.geometry.coordinates as number[][][]);
            pieceAreas.push({ label: currentLabel, area: a, w, h });
          }
        }
      }
      return actual.dropUnprintableRemnants(feat, floor);
    },
  };
});

const { parseSVGDocument } = await import('../src/svg/parse');
const { buildAssemblyGeometry } = await import('../src/geometry/assembly');
const { CLIP_REMNANT_FLOOR_MM2 } = await import('../src/geometry/depth');
const { clearWarnings } = await import('../src/warnings');
const { detectFlatPatches } = await import('../src/geometry/meshparts');
const { applyAsmPatchChoice } = await import('../src/assembly/parts');
const { buildHubcapBody, HUBCAP_DEFAULT_DIAMETER_MM } = await import('../src/geometry/hubcap');
const { reconstructChart } = await import('../src/geometry/zoneCharts');
type AssemblyPart = import('../src/types').AssemblyPart;
type DesignZone = import('../src/types').DesignZone;
type ParsedSVG = import('../src/types').ParsedSVG;

const { read3MF } = (await import(
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
  './lib/mesh.mjs'
)) as { read3MF: (buf: Buffer) => Promise<Float32Array> };
const { read3MFIndexed } = (await import(
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
  './lib/zonebake.mjs'
)) as {
  read3MFIndexed: (buf: Buffer) => Promise<{ verts: number[][]; tris: number[][] }>;
};

const PATTERNS = ['cow', 'dalmatian', 'zebra', 'tiger'];
const patternSVG: Record<string, string> = {};
for (const p of PATTERNS)
  patternSVG[p] = readFileSync(path.join(REPO, 'public/patterns', `${p}.svg`), 'utf8');
// Parsed fresh on every build, never reused across buildAssemblyGeometry calls: reusing one parsed
// object across builds against different parts made every build after the first collapse to one
// merged "#000000" color instead of the artwork's real two-color palette — reproduced with a
// minimal two-call repro, not yet root-caused (see docs/findings/2026-09-27-clip-ink-sweep.md,
// "wrong turns"). Re-parsing per call sidesteps it and matches what every other measure-*.mjs
// script already does for its per-iteration input.
const parsePattern = (p: string): ParsedSVG => parseSVGDocument(patternSVG[p]);

function fillArtwork(parsed: ParsedSVG, zoneId: string | null = null) {
  return {
    parsed,
    zoneId,
    scaleMult: 1,
    offX: 0,
    offZ: 0,
    flipX: false,
    flipY: false,
    rotationDeg: 0,
    mode: 'fill' as const,
  };
}

const baseInput = (parts: AssemblyPart[], artworks: ReturnType<typeof fillArtwork>[]) => ({
  artworks,
  parts,
  mergeGroups: [],
  colorSettings: {},
  globalDepth: 1,
  radius: 0,
  designFit: 'rect' as const,
});

let nextId = 1;
function partWithPatch(
  name: string,
  positions: Float32Array,
  patches: ReturnType<typeof detectFlatPatches>,
  rank: number,
): AssemblyPart {
  const part = {
    id: nextId++,
    name,
    roleId: 'r',
    positions,
    patches,
    patchIdx: rank,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  } as unknown as AssemblyPart;
  applyAsmPatchChoice(part);
  return part;
}

/** `defaultPatchIdx` from src/assembly/parts.ts, re-run against a part built outside app state. */
function flatPart(name: string, positions: Float32Array, preferNormal?: number[]): AssemblyPart {
  const patches = detectFlatPatches(positions);
  let rank = 0;
  if (preferNormal) {
    const idx = patches.findIndex(
      (p) =>
        p.normal[0] * preferNormal[0] +
          p.normal[1] * preferNormal[1] +
          p.normal[2] * preferNormal[2] >
        0.9,
    );
    if (idx >= 0) rank = idx;
  }
  return partWithPatch(name, positions, patches, rank);
}

async function loadFlat(id: string): Promise<Float32Array> {
  return read3MF(readFileSync(path.join(REPO, 'public/stl', `${id}.3mf`)));
}

describe.skipIf(!process.env.RUN_CLIP_INK_SWEEP)('clip-remnant floor sweep', () => {
  it('wheel-half, wheel-hub-cap, footrest, hubcap: every pattern in Fill mode', async () => {
    const wheelHalfPos = await loadFlat('wheel-half');
    const wheelCapPos = await loadFlat('wheel-hub-cap');
    const footrestPos = await loadFlat('footrest');
    const hubcapClips = await loadFlat('hubcap-clips');
    const hubcapBody = await buildHubcapBody(
      { kind: 'circle', diameterMm: HUBCAP_DEFAULT_DIAMETER_MM },
      hubcapClips,
    );

    const flatKinds: [string, Float32Array, number[] | undefined][] = [
      ['wheel-half', wheelHalfPos, undefined],
      ['wheel-hub-cap', wheelCapPos, undefined],
      ['footrest', footrestPos, [0, 1, 0]],
      ['hubcap', hubcapBody.positions, [0, 1, 0]],
    ];

    for (const [name, positions, prefer] of flatKinds) {
      const part = flatPart(name, positions, prefer);
      if (!part.boundaryLoops) continue;
      for (const pattern of PATTERNS) {
        currentLabel = `${name}/${pattern}`;
        clearWarnings();
        const built = await buildAssemblyGeometry(
          baseInput([part], [fillArtwork(parsePattern(pattern))]),
        );
        expect(built, `${currentLabel}: build returned null`).not.toBeNull();
      }
    }
  }, 300000);

  it('a representative subset of chair-body zones: every pattern in Fill mode', async () => {
    const sidecar = JSON.parse(
      readFileSync(path.join(REPO, 'public/stl/chair-body-zones.json'), 'utf8'),
    );
    const meshes = new Map<string, { positions: Float32Array; vertices: Float32Array }>();
    async function loadPacked(id: string) {
      const cached = meshes.get(id);
      if (cached) return cached;
      const m = await read3MFIndexed(readFileSync(path.join(REPO, 'public/stl', `${id}.3mf`)));
      const vertices = new Float32Array(m.verts.length * 3);
      m.verts.forEach((v, i) => vertices.set(v, i * 3));
      const positions = new Float32Array(m.tris.length * 9);
      m.tris.forEach((t, i) => {
        t.forEach((vi, k) => positions.set(m.verts[vi], i * 9 + k * 3));
      });
      const out = { positions, vertices };
      meshes.set(id, out);
      return out;
    }
    function zonesFor(id: string, mesh: { vertices: Float32Array }): DesignZone[] {
      const out: DesignZone[] = [];
      for (const zone of sidecar.zones)
        for (const chart of zone.charts)
          if (chart.libraryPartId === id)
            out.push({
              id: zone.id,
              name: zone.name,
              chart: reconstructChart(zone, chart, mesh.vertices),
            });
      return out;
    }
    function chairPart(
      id: string,
      mesh: { positions: Float32Array; vertices: Float32Array },
      zones: DesignZone[],
    ): AssemblyPart {
      return {
        id: nextId++,
        name: id,
        roleId: id,
        libraryPartId: id,
        positions: mesh.positions,
        vertices: mesh.vertices,
        zones,
        patches: null,
        patchIdx: 0,
        boundaryLoops: [
          [
            [-1, 0, -1],
            [1, 0, -1],
            [1, 0, 1],
          ],
        ],
        patchNormal: [0, 1, 0],
        topZ: 0,
        baseDepth: 0,
        isDuplicateOf: null,
        pivotX: 0,
        pivotZ: 0,
        angleDeg: 0,
        loaded: true,
        cutThrough: false,
      } as unknown as AssemblyPart;
    }

    // Representative subset, not all 8 zones: a full run of all 8 took over 10 minutes once the
    // parse-fresh-per-call fix above made every build do real per-color CSG instead of silently
    // collapsing to one merged color. These four span the zone-complexity range the sidecar
    // actually has: 1, 2, 4 and 6 printed parts per zone respectively (`node -e` against
    // public/stl/chair-body-zones.json prints every zone's chart count).
    const SWEPT_ZONE_IDS = new Set(['wing-left', 'seat-left', 'left', 'front']);
    for (const zone of (
      sidecar.zones as { id: string; charts: { libraryPartId: string }[] }[]
    ).filter((z) => SWEPT_ZONE_IDS.has(z.id))) {
      const parts: AssemblyPart[] = [];
      for (const c of zone.charts) {
        const mesh = await loadPacked(c.libraryPartId);
        parts.push(
          chairPart(
            c.libraryPartId,
            mesh,
            zonesFor(c.libraryPartId, mesh).filter((z) => z.id === zone.id),
          ),
        );
      }
      for (const pattern of PATTERNS) {
        currentLabel = `chair-body/${zone.id}/${pattern}`;
        clearWarnings();
        const built = await buildAssemblyGeometry(
          baseInput(parts, [fillArtwork(parsePattern(pattern), null)]),
        );
        expect(built, `${currentLabel}: build returned null`).not.toBeNull();
      }
    }
  }, 600000);

  afterAll(() => {
    pieceAreas.sort((a, b) => a.area - b.area);
    console.log(`\ntotal pieces seen: ${pieceAreas.length}`);
    console.log(`CLIP_REMNANT_FLOOR_MM2 = ${CLIP_REMNANT_FLOOR_MM2}`);

    // Every pattern SVG's first path is the full 60x60 tile background rect (see public/patterns/
    // *.svg), so a clip artifact born from that SAME background square meeting the SAME real zone
    // edge at the SAME tile position is IDENTICAL geometry regardless of which pattern painted it —
    // the only way two different-colored artworks land the exact same area at the exact same
    // part/zone slot. Grouping by (part/zone, area) and counting how many of the 4 patterns hit it
    // separates that shared background-square population (the bake's own cut-region-width question,
    // already swept in docs/findings/2026-09-08-cut-region-width.md) from pieces that depend on
    // what was actually drawn — the foreground ink this sweep is about.
    const zoneOf = (label: string) => label.split('/').slice(0, -1).join('/');
    const byZoneArea = new Map<string, Set<string>>();
    for (const h of pieceAreas) {
      const key = `${zoneOf(h.label)}|${h.area}`;
      if (!byZoneArea.has(key)) byZoneArea.set(key, new Set());
      byZoneArea.get(key)!.add(h.label.split('/').slice(-1)[0]);
    }
    const shared = new Set(
      [...byZoneArea.entries()].filter(([, s]) => s.size === PATTERNS.length).map(([k]) => k),
    );
    const inkPieces = pieceAreas.filter((h) => !shared.has(`${zoneOf(h.label)}|${h.area}`));
    const bgPieces = pieceAreas.filter((h) => shared.has(`${zoneOf(h.label)}|${h.area}`));
    console.log(
      `background-square pieces (identical across all ${PATTERNS.length} patterns at the same slot): ${bgPieces.length}`,
    );
    console.log(`foreground-ink pieces (pattern-specific): ${inkPieces.length}`);

    const inkAboveFloor = inkPieces.filter((h) => h.area >= CLIP_REMNANT_FLOOR_MM2);
    const inkBelowFloor = inkPieces.filter((h) => h.area < CLIP_REMNANT_FLOOR_MM2);
    console.log(
      `\nforeground-ink pieces below the floor: ${inkBelowFloor.length} of ${inkPieces.length}`,
    );
    console.log(
      `narrowest foreground-ink piece at/above the floor: ${inkAboveFloor[0]?.area} mm2 (${inkAboveFloor[0]?.label})`,
    );
    const byPattern = new Map<string, number>();
    for (const h of inkBelowFloor) {
      const p = h.label.split('/').slice(-1)[0];
      byPattern.set(p, (byPattern.get(p) ?? 0) + 1);
    }
    console.log('sub-floor pieces by pattern:', Object.fromEntries(byPattern));

    const buckets = [0.001, 0.01, 0.1, CLIP_REMNANT_FLOOR_MM2, 1, 10, 100, 1000, 10000, Infinity];
    console.log('\nforeground-ink piece-area histogram:');
    let lo = 0;
    for (const hi of buckets) {
      const n = inkPieces.filter((h) => h.area >= lo && h.area < hi).length;
      console.log(`[${lo}, ${hi}) mm2: ${n}`);
      lo = hi;
    }
  });
});
