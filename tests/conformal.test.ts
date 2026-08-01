import { beforeAll, describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import {
  CHART_SNAP_MM,
  ConformalZoneMapper,
  FILL_REFINE_MM,
  type ConformalChart,
} from '../src/geometry/conformal';
import {
  getManifold,
  manifoldIsValid,
  soupToManifold,
  type ManifoldAPI,
} from '../src/geometry/manifold';
import { canvasAnchor } from '../src/geometry/assembly';
import type { DesignPlacement } from '../src/geometry/zones';
import type { ParsedSVG, PolyFeature } from '../src/types';

// Quarter-cylinder shell, the one curved surface that unwraps exactly: radius R about the Y axis,
// θ ∈ [0, 90°], height H. UV is the analytic unwrap (u = R·θ arc length, v = y), so every chart
// quantity has a closed form to test against. Grid spacing ~2mm keeps chord sag (R·dθ²/8) well
// under the 0.05mm accuracy budget.
const R = 30;
const H = 60;
const ARC_U = (R * Math.PI) / 2;

function cylinderPoint(u: number, v: number): [number, number, number] {
  const th = u / R;
  return [R * Math.sin(th), v, R * Math.cos(th)];
}

function makeCylinderChart(): ConformalChart {
  const nu = 24; // θ segments → du ≈ 1.96mm
  const nv = 15; // height segments → dv = 4mm
  const positions3: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i <= nu; i++) {
    const u = (i / nu) * ARC_U;
    for (let j = 0; j <= nv; j++) {
      const v = (j / nv) * H;
      positions3.push(...cylinderPoint(u, v));
      uv.push(u, v);
    }
  }
  const triangles: number[] = [];
  const idx = (i: number, j: number): number => i * (nv + 1) + j;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = idx(i, j),
        b = idx(i + 1, j),
        c = idx(i + 1, j + 1),
        d = idx(i, j + 1);
      triangles.push(a, b, c, a, c, d); // CCW in UV → outward (radial) normals
    }
  }
  return {
    positions3: Float32Array.from(positions3),
    uv: Float32Array.from(uv),
    triangles: Uint32Array.from(triangles),
    normalSign: 1,
    boundary: [
      [0, 0],
      [ARC_U, 0],
      [ARC_U, H],
      [0, H],
    ],
  };
}

function squareAt(cu: number, cv: number, half: number): PolyFeature {
  return turf.polygon([
    [
      [cu - half, cv - half],
      [cu + half, cv - half],
      [cu + half, cv + half],
      [cu - half, cv + half],
      [cu - half, cv - half],
    ],
  ]) as PolyFeature;
}

const placement = (over: Partial<DesignPlacement> = {}): DesignPlacement => ({
  svgC: { cx: 5, cy: 5, r: 5 },
  mmPerUnit: 1,
  xFlip: 1,
  zMul: -1,
  offX: 0,
  offZ: 0,
  rotationDeg: 0,
  ...over,
});

let wasm: ManifoldAPI;
let mapper: ConformalZoneMapper;

beforeAll(async () => {
  wasm = await getManifold();
  mapper = new ConformalZoneMapper(wasm, makeCylinderChart());
}, 30000);

describe('chart validation', () => {
  it('rejects a uv array that does not match the vertex count', () => {
    const chart = makeCylinderChart();
    expect(
      () => new ConformalZoneMapper(wasm, { ...chart, uv: chart.uv.slice(0, chart.uv.length - 2) }),
    ).toThrow();
  });

  it('rejects a triangle index beyond the vertex count (mismatched sidecar)', () => {
    const chart = makeCylinderChart();
    const triangles = Uint32Array.from(chart.triangles);
    triangles[0] = chart.positions3.length / 3;
    expect(() => new ConformalZoneMapper(wasm, { ...chart, triangles })).toThrow();
  });
});

describe('surface evaluation (frameAt)', () => {
  it('lands on the analytic cylinder within 0.05mm across the chart', () => {
    // frameAt takes offsets from the chart UV center, like the flat mapper
    for (const du of [-20, -10, -3.7, 0, 7.3, 15, 20]) {
      for (const dv of [-25, -8.1, 0, 12.5, 25]) {
        const frame = mapper.frameAt(du, dv);
        const [x, y, z] = cylinderPoint(ARC_U / 2 + du, H / 2 + dv);
        const dist = Math.hypot(frame.origin.x - x, frame.origin.y - y, frame.origin.z - z);
        expect(dist).toBeLessThan(0.05);
      }
    }
  });

  it('produces a radial normal and tangential/axial frame axes', () => {
    for (const du of [-18, 0, 11]) {
      const frame = mapper.frameAt(du, 5);
      const th = (ARC_U / 2 + du) / R;
      const radial = { x: Math.sin(th), y: 0, z: Math.cos(th) };
      const tangent = { x: Math.cos(th), y: 0, z: -Math.sin(th) };
      expect(frame.normal.x * radial.x + frame.normal.z * radial.z).toBeGreaterThan(0.999);
      expect(frame.uAxis.x * tangent.x + frame.uAxis.z * tangent.z).toBeGreaterThan(0.999);
      expect(frame.vAxis.y).toBeGreaterThan(0.999);
    }
  });

  it('reports the area-weighted average chart normal as faceNormal', () => {
    const n = mapper.faceNormal!;
    // quarter arc averages to the 45° radial direction
    expect(n[0]).toBeCloseTo(Math.SQRT1_2, 1);
    expect(n[1]).toBeCloseTo(0, 5);
    expect(n[2]).toBeCloseTo(Math.SQRT1_2, 1);
    expect(mapper.nsign).toBe(1);
  });
});

describe('placer', () => {
  // chart UVs are Float32Array, so the chart center carries float32 quantization (~6e-8)
  const expectUV = (got: number[], u: number, v: number): void => {
    expect(got[0]).toBeCloseTo(u, 6);
    expect(got[1]).toBeCloseTo(v, 6);
  };

  it('maps the SVG anchor center to the chart UV center, y-down to v-down', () => {
    const place = mapper.placer(placement());
    expectUV(place([5, 5]), ARC_U / 2, H / 2);
    expectUV(place([6, 5]), ARC_U / 2 + 1, H / 2);
    // one SVG unit DOWN the image is one mm DOWN the surface (−v)
    expectUV(place([5, 6]), ARC_U / 2, H / 2 - 1);
  });

  it('applies user flips and offsets without a per-face mirror correction', () => {
    const place = mapper.placer(placement({ xFlip: -1, offX: 2, offZ: -3 }));
    expectUV(place([6, 5]), ARC_U / 2 + 2 - 1, H / 2 - 3);
  });

  it('rotates about the design center', () => {
    const place = mapper.placer(placement({ rotationDeg: 90 }));
    const [u, v] = place([6, 5]);
    expect(u).toBeCloseTo(ARC_U / 2, 6);
    expect(v).toBeCloseTo(H / 2 + 1, 6);
  });
});

// The template the bake emits for a zone spans it 1:1 in mm with SVG y running down
// (svg_y = H - v, scripts/lib/zonebake.mjs zoneTemplateSVG). Anchoring placement on that canvas
// rather than on the drawn content is what makes the template's own promise — "load at Scale 100%,
// Offset 0/0 and it lands on the zone" — hold for a design that doesn't fill the sheet.
describe('canvas anchoring (zone templates)', () => {
  const sheet = (bbox: ParsedSVG['bbox']): ParsedSVG => ({
    shapes: [],
    bbox,
    rawSVGCircle: null,
    canvas: { w: ARC_U, h: H },
  });

  const placeOn = (p: ParsedSVG): ((pt: number[]) => number[]) => {
    const anchor = canvasAnchor(p);
    if (!anchor) throw new Error('test sheet declares a viewBox; canvasAnchor should find it');
    return mapper.placer(placement({ svgC: anchor }));
  };

  it('inverts the template mapping: svg (x, y) → uv (x, H − y)', () => {
    const place = placeOn(sheet({ minX: 0, minY: 0, maxX: ARC_U, maxY: H }));
    for (const [x, y] of [
      [0, 0],
      [ARC_U, H],
      [ARC_U / 3, H / 4],
    ]) {
      const [u, v] = place([x, y]);
      expect(u).toBeCloseTo(x, 6);
      expect(v).toBeCloseTo(H - y, 6);
    }
  });

  it('keeps a corner-drawn shape in its corner (the fender case)', () => {
    const corner = { minX: 0, minY: 0, maxX: ARC_U * 0.2, maxY: H * 0.2 };
    const [u, v] = placeOn(sheet(corner))([0, 0]);
    expect(u).toBeCloseTo(0, 6);
    expect(v).toBeCloseTo(H, 6);

    // Anchoring on the drawn content instead — the old behavior — drags that same corner 40% of
    // the way across the zone and well down it, which is how a fender-shaped design ended up cut
    // on the neighbouring part.
    const [uOld, vOld] = mapper.placer(
      placement({
        svgC: { cx: (corner.minX + corner.maxX) / 2, cy: (corner.minY + corner.maxY) / 2, r: 1 },
      }),
    )([0, 0]);
    expect(uOld).toBeCloseTo(ARC_U * 0.4, 6);
    expect(vOld).toBeCloseTo(H * 0.6, 6);
  });

  it('agrees with content anchoring when the design fills its canvas', () => {
    const full = { minX: 0, minY: 0, maxX: ARC_U, maxY: H };
    const anchor = canvasAnchor(sheet(full));
    expect(anchor?.cx).toBeCloseTo((full.minX + full.maxX) / 2, 6);
    expect(anchor?.cy).toBeCloseTo((full.minY + full.maxY) / 2, 6);
  });

  it('reports no canvas when the document declares neither a viewBox nor a size', () => {
    const noCanvas: ParsedSVG = {
      shapes: [],
      bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      rawSVGCircle: null,
    };
    expect(canvasAnchor(noCanvas)).toBeNull();
  });
});

describe('boundary', () => {
  it('is the zone outline in UV space, closed for turf', () => {
    const poly = mapper.boundary()!;
    expect(poly).not.toBeNull();
    expect(poly.geometry.type).toBe('Polygon');
    const ring = (poly.geometry.coordinates as number[][][])[0];
    expect(ring).toHaveLength(5); // 4 corners + closing repeat
    expect(ring[0]).toEqual(ring[4]);
    expect(ring).toContainEqual([ARC_U, H]);
  });

  it('passes the depth setting through unchanged', () => {
    expect(mapper.resolveCutDepth(2.5)).toBe(2.5);
  });

  it('fillExtent is the chart UV bbox a fill tiles over', () => {
    const e = mapper.fillExtent()!;
    expect(e).not.toBeNull();
    expect(e.minX).toBeCloseTo(0, 4);
    expect(e.minY).toBeCloseTo(0, 4);
    expect(e.maxX).toBeCloseTo(ARC_U, 3);
    expect(e.maxY).toBeCloseTo(H, 3);
  });
});

describe('buildCutter', () => {
  const DEPTH = 1.5;
  const OVER = 0.5;

  it('bends a flat prism onto the cylinder: constant pocket depth along the arc', () => {
    const soup = mapper.buildCutter(squareAt(ARC_U / 2, H / 2, 10), DEPTH, OVER)!;
    expect(soup).not.toBeNull();
    expect(soup.length / 9).toBeGreaterThan(1000); // refinement actually happened

    let minR = Infinity,
      maxR = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (let i = 0; i < soup.length; i += 3) {
      const r = Math.hypot(soup[i], soup[i + 2]);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      const y = soup[i + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // inner surface a constant DEPTH below the cylinder, overshoot a constant OVER above —
    // 0.06mm budget = chord sag + interpolated-normal error
    expect(minR).toBeGreaterThan(R - DEPTH - 0.06);
    expect(minR).toBeLessThan(R - DEPTH + 0.06);
    expect(maxR).toBeGreaterThan(R + OVER - 0.06);
    expect(maxR).toBeLessThan(R + OVER + 0.06);
    // cylinder normals have no axial component, so the cutter stays in its v-band
    expect(minY).toBeGreaterThan(H / 2 - 10 - 0.02);
    expect(maxY).toBeLessThan(H / 2 + 10 + 0.02);
  }, 20000);

  it('refineMM coarsens the warp for a fill-sized cutter, still on the cylinder', () => {
    const feat = squareAt(ARC_U / 2, H / 2, 10);
    const fine = mapper.buildCutter(feat, DEPTH, OVER)!;
    const coarse = mapper.buildCutter(feat, DEPTH, OVER, { refineMM: FILL_REFINE_MM })!;
    expect(coarse).not.toBeNull();
    expect(coarse.length).toBeLessThan(fine.length);
    // coarser subdivision means more chord sag, but the surface is still tracked closely
    let minR = Infinity;
    for (let i = 0; i < coarse.length; i += 3)
      minR = Math.min(minR, Math.hypot(coarse[i], coarse[i + 2]));
    expect(Math.abs(minR - (R - DEPTH))).toBeLessThan(0.2);
  }, 20000);

  it('produces a watertight solid with the analytic shell volume', () => {
    const soup = mapper.buildCutter(squareAt(ARC_U / 2, H / 2, 10), DEPTH, OVER)!;
    const man = soupToManifold(wasm, soup);
    expect(manifoldIsValid(man)).toBe(true);
    // radial shell of a 20×20 UV square: width scales r/R, so
    // V = 20 · ∫ 20·(r/R) dr over [R−DEPTH, R+OVER]
    const analytic = (400 * ((R + OVER) ** 2 - (R - DEPTH) ** 2)) / (2 * R);
    expect(Math.abs(man.volume() - analytic) / analytic).toBeLessThan(0.015);
    man.delete();
  }, 20000);

  it('subtracts from a real solid: pocket volume matches the analytic shell below the surface', () => {
    const soup = mapper.buildCutter(squareAt(ARC_U / 2, H / 2, 10), DEPTH, OVER)!;
    const cutter = soupToManifold(wasm, soup);
    // solid cylinder matching the chart: Manifold's is along Z, rotate −90° about X → along Y
    const part = wasm.Manifold.cylinder(H, R, R, 128).rotate([-90, 0, 0]);
    const body = wasm.Manifold.difference(part, cutter);
    expect(manifoldIsValid(body)).toBe(true);
    const pocket = part.volume() - body.volume();
    // material removed = cutter below the surface: 20 · ∫ 20·(r/R) dr over [R−DEPTH, R];
    // 5% slack covers the 128-segment facet sag of the test cylinder itself
    const analytic = (400 * (R ** 2 - (R - DEPTH) ** 2)) / (2 * R);
    expect(Math.abs(pocket - analytic) / analytic).toBeLessThan(0.05);
    body.delete();
    part.delete();
    cutter.delete();
  }, 20000);

  it('snaps a slight overhang past the chart edge (simplified-boundary tolerance)', () => {
    // left edge pokes 0.3mm past u=0 — inside CHART_SNAP_MM, must still build
    expect(0.3).toBeLessThan(CHART_SNAP_MM);
    const soup = mapper.buildCutter(squareAt(10 - 0.3, H / 2, 10), DEPTH, OVER);
    expect(soup).not.toBeNull();
  }, 20000);

  it('refuses artwork landing beyond the chart', () => {
    const soup = mapper.buildCutter(squareAt(ARC_U + ARC_U / 2, H / 2, 10), DEPTH, OVER);
    expect(soup).toBeNull();
  }, 20000);

  // A sticker gets the same tolerance a fill does. The two used to differ (0.5 vs 2) on the theory
  // that only a fill runs along the clipped boundary; measuring the shipped bake showed the
  // uncovered patches sit *interior* to each part's claim, so both modes meet them equally — and a
  // sticker covering one was failing on the chair's seat-back parts.
  // 2.2mm clears the worst gap the shipped chair bake actually has (2.150mm, right/chair-wing-right
  // — see chair-zones.test.ts). A tolerance that stops snapping this far out drops colours off the
  // seat back again, which is the bug this pair of tests exists to keep fixed.
  it('snaps an overhang a sticker also has to survive, not just a fill', () => {
    expect(mapper.buildCutter(squareAt(10 - 2.2, H / 2, 10), DEPTH, OVER)).not.toBeNull();
  }, 20000);

  // The other side of the same guard, and the reason both offsets are literals rather than
  // multiples of CHART_SNAP_MM: derived offsets move with the constant and so can never fail.
  // Raising it past 6 fails here instead — the bake needs ~2.15mm, so a tolerance near 6 has
  // stopped guarding against misplaced artwork and is just snapping whatever it is handed.
  it('refuses an overhang past the tolerance, at either refinement', () => {
    expect(CHART_SNAP_MM).toBeLessThan(6);
    const past = squareAt(10 - 6, H / 2, 10);
    expect(mapper.buildCutter(past, DEPTH, OVER)).toBeNull();
    expect(mapper.buildCutter(past, DEPTH, OVER, { refineMM: FILL_REFINE_MM })).toBeNull();
  }, 20000);

  it('still refuses artwork off the chart entirely, at either refinement', () => {
    const far = squareAt(ARC_U + ARC_U / 2, H / 2, 10);
    expect(mapper.buildCutter(far, DEPTH, OVER)).toBeNull();
    expect(mapper.buildCutter(far, DEPTH, OVER, { refineMM: FILL_REFINE_MM })).toBeNull();
  }, 20000);
});
