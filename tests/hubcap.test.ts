import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  readMesh,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/mesh.mjs';
import {
  HUBCAP_BASE_Y,
  HUBCAP_CHAMFER_MM,
  HUBCAP_CLIP_FACE_INNER_R_MM,
  HUBCAP_DEFAULT_DIAMETER_MM,
  HUBCAP_FACE_Y,
  HUBCAP_MIN_DIAMETER_MM,
  HUBCAP_REFERENCE_DIAMETER_MM,
  HUBCAP_THICKNESS_MM,
  buildHubcapBody,
  hubcapDiscSoup,
  hubcapSegments,
  soupVolume,
} from '../src/geometry/hubcap';

/**
 * The hubcap disc is generated rather than shipped, so nothing about it is pinned by a mesh
 * asset the way every other part is. These are the measurements that stood in for a verified
 * asset: they come off the reference mesh a human modelled (an untracked stubs/hubcap.stl), and
 * the point of the first test is that the generator can *reproduce* that part. A generator that
 * cannot re-derive the shape it was written from is guessing.
 *
 * Recorded here so the numbers survive the stub being untracked:
 *   disc     794 triangles, 133 segments, 220.722 x 3.000 x 220.737mm bbox
 *   rings    y=24.2550 r=110.3763 | y=26.2550 r=110.3763 | y=27.2550 r=109.3763
 *   clips    4 bodies, 2036 triangles each, spanning y 19.0828..24.2550
 */
const REF = {
  diameter: HUBCAP_REFERENCE_DIAMETER_MM,
  rOuter: 110.3763,
  rInner: 109.3763,
  yBase: 24.255,
  yMid: 26.255,
  yTop: 27.255,
  segments: 133,
};

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const clipsPath = resolve(REPO, 'public/stl/hubcap-clips.3mf');

function bounds(soup: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = soup[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  return { min, max };
}

function surfaceArea(soup: Float32Array): number {
  let a = 0;
  for (let i = 0; i < soup.length; i += 9) {
    const ux = soup[i + 3] - soup[i];
    const uy = soup[i + 4] - soup[i + 1];
    const uz = soup[i + 5] - soup[i + 2];
    const vx = soup[i + 6] - soup[i];
    const vy = soup[i + 7] - soup[i + 1];
    const vz = soup[i + 8] - soup[i + 2];
    a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return a;
}

/** Max radius of any vertex sitting on the given y-plane — the reference's ring measurement. */
function ringRadius(soup: Float32Array, y: number): number {
  let r = 0;
  for (let i = 0; i < soup.length; i += 3) {
    if (Math.abs(soup[i + 1] - y) > 1e-4) continue;
    const d = Math.hypot(soup[i], soup[i + 2]);
    if (d > r) r = d;
  }
  return r;
}

describe('hubcap disc generator', () => {
  const disc = hubcapDiscSoup(REF.diameter);

  it('reproduces the reference disc it was modelled from', () => {
    const { min, max } = bounds(disc);
    // bbox: a 133-gon inscribed at r=110.3763 measures 220.722 x 220.737 across, not 220.752 —
    // the reference's own figures, and the reason the tolerance here is 0.05mm and not 0.001mm.
    expect(max[0] - min[0]).toBeCloseTo(220.73, 1);
    expect(max[2] - min[2]).toBeCloseTo(220.73, 1);
    expect(min[1]).toBeCloseTo(REF.yBase, 4);
    expect(max[1]).toBeCloseTo(REF.yTop, 4);
    expect(max[1] - min[1]).toBeCloseTo(HUBCAP_THICKNESS_MM, 6);
  });

  it('puts the 1mm 45-degree chamfer on the top edge and nowhere else', () => {
    expect(ringRadius(disc, REF.yBase)).toBeCloseTo(REF.rOuter, 2);
    expect(ringRadius(disc, REF.yMid)).toBeCloseTo(REF.rOuter, 2);
    expect(ringRadius(disc, REF.yTop)).toBeCloseTo(REF.rInner, 2);
    // 45 degrees: the radius loses exactly what the height gains
    expect(REF.rOuter - ringRadius(disc, REF.yTop)).toBeCloseTo(REF.yTop - REF.yMid, 2);
    expect(HUBCAP_FACE_Y - HUBCAP_BASE_Y).toBe(HUBCAP_THICKNESS_MM);
  });

  it('agrees with the reference on volume to within tessellation noise', () => {
    // solid of revolution: a 3mm disc at r, less the chamfer ring's triangular section
    const r = REF.rOuter;
    const c = HUBCAP_CHAMFER_MM;
    const exact =
      Math.PI * r * r * HUBCAP_THICKNESS_MM -
      // Pappus: the 45 degree chamfer removes a right triangle of area c^2/2 whose centroid
      // sits at r - c/3 from the axis
      2 * Math.PI * (r - c / 3) * ((c * c) / 2);
    expect(soupVolume(disc) / exact).toBeCloseTo(1, 3);
  });

  it('winds every face outward', () => {
    // a soup wound inside-out has the same bbox, the same area and a negated volume, so this is
    // the only check that catches it — and Manifold would read the part as its own complement.
    expect(soupVolume(disc)).toBeGreaterThan(0);
  });

  it('tessellates finely enough that facets cannot survive slicing', () => {
    const n = hubcapSegments(REF.diameter / 2);
    // within a couple of segments of the 133 the reference CAD chose
    expect(Math.abs(n - REF.segments)).toBeLessThanOrEqual(3);
    // chord sag well inside one 0.2mm layer
    const sag = (REF.diameter / 2) * (1 - Math.cos(Math.PI / n));
    expect(sag).toBeLessThan(0.05);
  });

  it('loads at a round 220mm, which is not the reference measurement', () => {
    // Two questions, deliberately two constants: what the modelled part measures, and what a
    // volunteer is handed on load. Collapsing them back into one would either put 220.752 in
    // front of the user or quietly let the reproduction test above check a 220mm disc against a
    // 220.752mm reference — and it would still pass, because the tolerances are millimetre-scale.
    expect(HUBCAP_DEFAULT_DIAMETER_MM).toBe(220);
    expect(HUBCAP_DEFAULT_DIAMETER_MM).not.toBe(HUBCAP_REFERENCE_DIAMETER_MM);
    // and the default is a size that actually builds
    expect(HUBCAP_DEFAULT_DIAMETER_MM).toBeGreaterThan(HUBCAP_MIN_DIAMETER_MM);
    expect(soupVolume(hubcapDiscSoup(HUBCAP_DEFAULT_DIAMETER_MM))).toBeGreaterThan(0);
  });

  it('scales to any diameter, keeping the chamfer absolute', () => {
    for (const d of [60, 150, 256]) {
      const soup = hubcapDiscSoup(d);
      const { min, max } = bounds(soup);
      expect(max[0] - min[0]).toBeLessThanOrEqual(d + 1e-6);
      expect(max[0] - min[0]).toBeGreaterThan(d - 0.05);
      expect(max[1] - min[1]).toBeCloseTo(HUBCAP_THICKNESS_MM, 6);
      // the chamfer is a fixed 1mm, not a fraction of the disc
      expect(d / 2 - ringRadius(soup, HUBCAP_FACE_Y)).toBeCloseTo(HUBCAP_CHAMFER_MM, 2);
      expect(soupVolume(soup)).toBeGreaterThan(0);
    }
  });
});

describe('hubcap body = disc union clips', () => {
  it('fuses into exactly one solid', async () => {
    const clips = await readMesh(clipsPath);
    const body = await buildHubcapBody(REF.diameter, clips);
    // The disc's underside and the clips' top faces are exactly coincident, which is the case a
    // soup concat gets wrong: it looks identical in the viewport and exports without complaint,
    // but leaves two solids with a buried skin between them.
    expect(body.components).toBe(1);
    expect(body.positions.length).toBeGreaterThan(0);
    expect(soupVolume(body.positions)).toBeGreaterThan(0);
  }, 30000);

  it('comes apart below the clip reach, and the clamp floor is above that', async () => {
    const clips = await readMesh(clipsPath);
    // the failure the floor exists to prevent: a disc that misses the clip tops entirely leaves
    // five loose bodies, which still exports and still looks like a hubcap on screen
    const tooSmall = await buildHubcapBody(2 * HUBCAP_CLIP_FACE_INNER_R_MM - 2, clips);
    expect(tooSmall.components).toBe(5);
    // at the clamp floor the clip tops are fully covered
    const atFloor = await buildHubcapBody(HUBCAP_MIN_DIAMETER_MM, clips);
    expect(atFloor.components).toBe(1);
    expect(HUBCAP_MIN_DIAMETER_MM).toBeGreaterThan(2 * HUBCAP_CLIP_FACE_INNER_R_MM);
  }, 30000);

  it('keeps the clips and the design face intact through the union', async () => {
    const clips = await readMesh(clipsPath);
    const body = await buildHubcapBody(REF.diameter, clips);
    const { min, max } = bounds(body.positions);
    // clips set the floor, the design face the ceiling
    expect(min[1]).toBeCloseTo(19.0828, 2);
    expect(max[1]).toBeCloseTo(REF.yTop, 3);
    expect(max[0] - min[0]).toBeCloseTo(220.73, 1);
    // the union must not have eaten the design face
    expect(surfaceArea(body.positions)).toBeGreaterThan(0);
    expect(ringRadius(body.positions, REF.yTop)).toBeCloseTo(REF.rInner, 1);
  }, 30000);
});
