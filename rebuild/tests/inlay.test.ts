import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRegions } from '../src/design/regions';
import { parseSvg } from '../src/design/svg';
import { defaultPlacement, type PlacedDesign } from '../src/design/placement';
import { defaultSlotSettings, planSlots } from '../src/design/slots';
import { engine, fromManifold, toManifold } from '../src/geometry/csg';
import { hubcapSolid } from '../src/geometry/hubcap';
import { cutAll, surfaceInput } from '../src/geometry/inlay';
import { flatPatches, meshBounds, meshVolume } from '../src/geometry/mesh';
import { read3mf } from '../src/geometry/threemf-read';
import { kindDef } from '../src/parts/catalog';
import { localPoint } from '../src/geometry/frame';

const part = (f: string) => readFileSync(new URL(`../reference/parts/${f}`, import.meta.url));
const art = (f: string) => readFileSync(new URL(`../reference/artwork/${f}`, import.meta.url), 'utf8');

function cowDesign(id = 'cow'): PlacedDesign['source'] {
  const svg = parseSvg(art('cow.svg'));
  const r = resolveRegions(svg.shapes);
  return { id, name: 'cow.svg', kind: 'svg', widthMm: svg.widthMm, heightMm: svg.heightMm, regions: r.regions, warnings: [] };
}

describe('cutting', () => {
  it('cuts the cow into the wheel face as two inlays of the right volume', async () => {
    const wasm = await engine();
    const kind = kindDef('wheel');
    const [wheel] = await read3mf(part('wheel-half.3mf'));
    const pieces = [{ id: 'wheel-half', name: 'Wheel half', mesh: wheel.mesh }];
    const surface = surfaceInput(kind.surfaces[0], pieces);
    // Place on the flat face's centroid.
    const face = flatPatches(wheel.mesh)[0];
    const c = localPoint(surface.frame, face.centroid);
    const source = cowDesign();
    const plan = planSlots(source.regions.map((r) => ({ color: r.color, areaMm2: r.areaMm2 })), defaultSlotSettings(), '#888888');
    expect(plan.slots).toHaveLength(2);
    const design: PlacedDesign = { id: 'd1', source, surfaceId: 'face', placement: { ...defaultPlacement(), x: c[0], y: c[1] }, mode: 'sticker', tileGapMm: 0, mirror: false };
    const before = meshVolume(wheel.mesh);
    const res = await cutAll({ wasm, pieces, surfaces: [surface], designs: [design], plan, defaultDepthMm: 1 });
    const p = res.pieces[0];
    expect(p.inlays).toHaveLength(2);
    const inlayVol = p.inlays.reduce((s, i) => s + i.volumeMm3, 0);
    // 60 x 60 mm at 1 mm deep, if the whole design sits on solid face.
    console.log('inlays', p.inlays.map((i) => `${i.color} ${Math.round(i.volumeMm3)}`), 'warnings', res.warnings.map((w) => w.text));
    expect(inlayVol).toBeGreaterThan(3000);
    expect(inlayVol).toBeLessThan(3700);
    expect(before - meshVolume(p.body)).toBeCloseTo(inlayVol, -1);
    expect(res.slotsUsed).toEqual(new Set([2, 3]));
  });

  it('caps the depth at the wall and says so', async () => {
    const wasm = await engine();
    const kind = kindDef('wheel');
    const [wheel] = await read3mf(part('wheel-half.3mf'));
    const pieces = [{ id: 'wheel-half', name: 'Wheel half', mesh: wheel.mesh }];
    const surface = surfaceInput(kind.surfaces[0], pieces);
    const face = flatPatches(wheel.mesh)[0];
    const c = localPoint(surface.frame, face.centroid);
    const source = cowDesign();
    const plan = planSlots(source.regions.map((r) => ({ color: r.color, areaMm2: r.areaMm2 })), defaultSlotSettings(), '#888888');
    const design: PlacedDesign = { id: 'd1', source, surfaceId: 'face', placement: { ...defaultPlacement(), x: c[0], y: c[1] }, mode: 'sticker', tileGapMm: 0, mirror: false };
    const res = await cutAll({ wasm, pieces, surfaces: [surface], designs: [design], plan, defaultDepthMm: 60 });
    console.log(res.warnings.map((w) => w.text));
    expect(res.warnings.some((w) => /cut shallower/.test(w.text) || /too thin/.test(w.text))).toBe(true);
    expect(meshVolume(res.pieces[0].body)).toBeGreaterThan(0);
  });

  it('generates a chamfered hubcap disc and joins the clips', async () => {
    const wasm = await engine();
    const disc = hubcapSolid(wasm, { kind: 'circle', diameterMm: 180 });
    const v = disc.volume();
    expect(v).toBeGreaterThan(Math.PI * 89 * 89 * 3);
    expect(v).toBeLessThan(Math.PI * 90 * 90 * 3);
    const [clips] = await read3mf(part('hubcap-clips.3mf'));
    const clipsM = toManifold(wasm, clips.mesh);
    const joined = wasm.Manifold.union(disc, clipsM);
    expect(joined.volume()).toBeGreaterThan(v);
    const b = meshBounds(fromManifold(joined));
    expect(b.min[1]).toBeCloseTo(19.1, 0);
    expect(b.max[1]).toBeCloseTo(27.3, 1);
    disc.delete();
    clipsM.delete();
    joined.delete();
  });
});

describe('fill', () => {
  it('tiles the zebra across the footrest and cuts both colors', async () => {
    const wasm = await engine();
    const kind = kindDef('footrest');
    const [fr] = await read3mf(part('footrest.3mf'));
    const pieces = [{ id: 'footrest', name: 'Footrest', mesh: fr.mesh }];
    const surface = surfaceInput(kind.surfaces[0], pieces);
    const svg = parseSvg(art('zebra.svg'));
    const regions = resolveRegions(svg.shapes).regions;
    const source: PlacedDesign['source'] = { id: 'z', name: 'zebra.svg', kind: 'svg', widthMm: 60, heightMm: 60, regions, warnings: [] };
    const plan = planSlots(regions.map((r) => ({ color: r.color, areaMm2: r.areaMm2 })), defaultSlotSettings(), '#8a8f94');
    const design: PlacedDesign = { id: 'd', source, surfaceId: 'face', placement: { ...defaultPlacement(), scale: 0.67 }, mode: 'fill', tileGapMm: 0, mirror: false };
    const res = await cutAll({ wasm, pieces, surfaces: [surface], designs: [design], plan, defaultDepthMm: 1 });
    expect(res.pieces[0].inlays).toHaveLength(2);
    const vol = res.pieces[0].inlays.reduce((s, i) => s + i.volumeMm3, 0);
    // The footrest face is roughly 276 x 220 mm; a 1 mm fill over most of it.
    expect(vol).toBeGreaterThan(20000);
    expect(res.warnings.filter((w) => w.kind === 'error')).toEqual([]);
  }, 120000);
});
