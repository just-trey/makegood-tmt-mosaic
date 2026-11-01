import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildAssemblyGeometry, type AssemblyBuildInput } from '../src/geometry/assembly';
import { reconstructChart, type ZoneSidecar } from '../src/geometry/zoneCharts';
import { getManifold } from '../src/geometry/manifold';
import type { AssemblyPart, DesignZone, ParsedSVG } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';
import {
  read3MFIndexed,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/zonebake.mjs';

// How many pills a plain 3-color design raises on the whole chair, and whether each kind is one
// line. Review cycle 2026-10-06 item 4: 8 "too fine to print" notices at depth 1, 17 lines at
// depth 60. `REPORT_NOTICE_COUNTS=1 npx vitest run tests/chair-notices.test.ts` prints the counts.

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const sidecar: ZoneSidecar = JSON.parse(
  readFileSync(resolve(REPO, 'public/stl/chair-body-zones.json'), 'utf8'),
);

interface LoadedMesh {
  positions: Float32Array;
  vertices: Float32Array;
}
const meshes = new Map<string, LoadedMesh>();

async function loadPacked(id: string): Promise<LoadedMesh> {
  const cached = meshes.get(id);
  if (cached) return cached;
  const m = await read3MFIndexed(readFileSync(resolve(REPO, 'public/stl', `${id}.3mf`)));
  const vertices = new Float32Array(m.verts.length * 3);
  m.verts.forEach((v: number[], i: number) => vertices.set(v, i * 3));
  const positions = new Float32Array(m.tris.length * 9);
  m.tris.forEach((t: number[], i: number) => {
    t.forEach((vi, k) => positions.set(m.verts[vi], i * 9 + k * 3));
  });
  const out = { positions, vertices };
  meshes.set(id, out);
  return out;
}

function zonesFor(id: string, mesh: LoadedMesh): DesignZone[] {
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

let nextId = 1;
function chairPart(id: string, mesh: LoadedMesh, zones: DesignZone[]): AssemblyPart {
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
  };
}

const BACKDROP = '#c1272d';
const MIDDLE = '#1e5fa8';
const YELLOW = '#f5d020';

const FILAMENTS = [
  { name: 'Red', hex: BACKDROP },
  { name: 'Blue', hex: MIDDLE },
  { name: 'Yellow', hex: YELLOW },
];

/** A big backdrop, a square on it, a disc on that: three plain colors, no detail anywhere. */
function threeColorParsed(size: number): ParsedSVG {
  const square = (lo: number, hi: number) => [
    { x: lo, y: lo },
    { x: hi, y: lo },
    { x: hi, y: hi },
    { x: lo, y: hi },
    { x: lo, y: lo },
  ];
  const c = size / 2;
  const disc = Array.from({ length: 49 }, (_, k) => {
    const t = (2 * Math.PI * (k % 48)) / 48;
    return { x: c + (size / 8) * Math.cos(t), y: c + (size / 8) * Math.sin(t) };
  });
  return {
    shapes: [
      { fill: BACKDROP, loops: [square(0, size)], order: 0 },
      { fill: MIDDLE, loops: [square(size / 4, (size * 3) / 4)], order: 1 },
      { fill: YELLOW, loops: [disc], order: 2 },
    ],
    bbox: { minX: 0, minY: 0, maxX: size, maxY: size },
    rawSVGCircle: null,
    userUnitMM: 1,
  };
}

async function wholeChair(): Promise<AssemblyPart[]> {
  const ids = new Set<string>();
  for (const z of sidecar.zones) for (const c of z.charts) ids.add(c.libraryPartId);
  const parts: AssemblyPart[] = [];
  for (const id of ids) {
    const mesh = await loadPacked(id);
    parts.push(chairPart(id, mesh, zonesFor(id, mesh)));
  }
  return parts;
}

function input(parts: AssemblyPart[], globalDepth: number): AssemblyBuildInput {
  return {
    artworks: [
      {
        parsed: threeColorParsed(600),
        zoneId: null,
        scaleMult: 1,
        offX: 0,
        offZ: 0,
        flipX: false,
        flipY: false,
        rotationDeg: 0,
      },
    ],
    parts,
    mergeGroups: [],
    colorSettings: {},
    globalDepth,
    radius: 0,
    designFit: 'rect',
    filaments: FILAMENTS,
  };
}

// Both wordings of each kind, so the same counts can be read off a build from before the grouping.
const SPECK = /0\.4 mm across/;
const TOO_DEEP = /deeper than/;
const THIN_WALL = /thick under|as thin as/;

let parts: AssemblyPart[];
const built: Record<number, string[]> = {};

async function messagesAt(depth: number): Promise<string[]> {
  if (built[depth]) return built[depth];
  clearWarnings();
  await buildAssemblyGeometry(input(parts, depth));
  return (built[depth] = WARNINGS.map((w) => w.message));
}

beforeAll(async () => {
  await getManifold();
  parts = await wholeChair();
}, 120000);

describe('a plain 3-color design on every zone of the chair', () => {
  it('reports its notice counts', { timeout: 600000 }, async () => {
    if (!process.env.REPORT_NOTICE_COUNTS) return;
    for (const depth of [1, 60]) {
      const m = await messagesAt(depth);
      console.log(
        `depth ${depth}: ${m.length} pills, ${m.filter((x) => SPECK.test(x)).length} speck, ` +
          `${m.filter((x) => TOO_DEEP.test(x)).length} too-deep, ` +
          `${m.filter((x) => THIN_WALL.test(x)).length} thin-wall\n  ${m.join('\n  ')}`,
      );
    }
  });

  it('says the pieces too small to cut once, naming the color as its row does', async () => {
    const speck = (await messagesAt(1)).filter((m) => SPECK.test(m));
    // Blue is the only color that leaves one on this design: six parts, six notices before.
    expect(speck).toHaveLength(1);
    expect(speck[0]).toContain('"Blue (#1e5fa8)"');
    expect(speck[0]).toContain(' on 6 parts are under about 0.4 mm across');
  }, 600000);

  it('says a depth the parts cannot take once per kind', async () => {
    const m = await messagesAt(60);
    expect(m.filter((x) => TOO_DEEP.test(x))).toHaveLength(0);
    expect(m.filter((x) => THIN_WALL.test(x))).toHaveLength(1);
  }, 600000);

  it('names every color it clamped as the color row does', async () => {
    const [line] = (await messagesAt(60)).filter((x) => THIN_WALL.test(x));
    expect(line).toContain('"Red (#c1272d)"');
    expect(line).toContain('"Blue (#1e5fa8)"');
    expect(line).toContain('"Yellow (#f5d020)"');
    expect(line).not.toMatch(/"#[0-9a-f]{6}"/);
  }, 600000);
});
