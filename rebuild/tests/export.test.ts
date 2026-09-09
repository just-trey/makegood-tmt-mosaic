import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { defaultPlacement, type PlacedDesign } from '../src/design/placement';
import { resolveRegions } from '../src/design/regions';
import { defaultSlotSettings, planSlots } from '../src/design/slots';
import { parseSvg } from '../src/design/svg';
import { layoutPlates } from '../src/export/plates';
import { printerById } from '../src/export/printers';
import { buildSurfaceMap, templateSvg } from '../src/export/template';
import { write3mf } from '../src/export/threemf-write';
import { engine } from '../src/geometry/csg';
import { localPoint } from '../src/geometry/frame';
import { cutAll, surfaceInput } from '../src/geometry/inlay';
import { flatPatches, meshBounds, meshVolume } from '../src/geometry/mesh';
import { read3mf } from '../src/geometry/threemf-read';
import { kindDef } from '../src/parts/catalog';

const part = (f: string) => readFileSync(new URL(`../reference/parts/${f}`, import.meta.url));
const art = (f: string) => readFileSync(new URL(`../reference/artwork/${f}`, import.meta.url), 'utf8');

describe('export', () => {
  it('writes a project the reader round-trips, with parts on filament slots', async () => {
    const wasm = await engine();
    const kind = kindDef('wheel');
    const [wheel] = await read3mf(part('wheel-half.3mf'));
    const pieces = [{ id: 'wheel-half', name: 'Wheel half', mesh: wheel.mesh }];
    const surface = surfaceInput(kind.surfaces[0], pieces);
    const c = localPoint(surface.frame, flatPatches(wheel.mesh)[0].centroid);
    const svg = parseSvg(art('cow.svg'));
    const regions = resolveRegions(svg.shapes).regions;
    const source: PlacedDesign['source'] = { id: 'cow', name: 'cow.svg', kind: 'svg', widthMm: 60, heightMm: 60, regions, warnings: [] };
    const plan = planSlots(regions.map((r) => ({ color: r.color, areaMm2: r.areaMm2 })), defaultSlotSettings(), '#808080');
    const design: PlacedDesign = { id: 'd', source, surfaceId: 'face', placement: { ...defaultPlacement(), x: c[0], y: c[1], scale: 2 }, mode: 'sticker', tileGapMm: 0, mirror: false };
    const cut = await cutAll({ wasm, pieces, surfaces: [surface], designs: [design], plan, defaultDepthMm: 1 });
    console.log(cut.warnings.map((w) => w.text));
    const printer = printerById('bambu-x1c');
    const layout = layoutPlates(cut.pieces, printer, new Map([['wheel-half', [0, 1, 0]]]));
    expect(layout.plates).toHaveLength(1);
    const pp = layout.plates[0].pieces[0];
    const b = meshBounds(pp.body);
    expect(b.min[2]).toBeCloseTo(0, 3);
    // Face down: the recess floors sit at z <= depth.
    for (const inl of pp.inlays) expect(meshBounds(inl.mesh).min[2]).toBeCloseTo(0, 2);
    const slots = [{ index: 1, color: '#808080', name: 'Body' }, ...plan.slots.map((s) => ({ index: s.index, color: s.printColor, name: s.printColor }))];
    const bytes = await write3mf({ printer, layout, slots, projectName: 'test' });
    mkdirSync(new URL('../.evidence-work/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../.evidence-work/roundtrip.3mf', import.meta.url), bytes);
    const zip = await JSZip.loadAsync(bytes);
    const settings = await zip.file('Metadata/model_settings.config')!.async('string');
    expect(settings).toContain('key="extruder" value="2"');
    expect(settings).toContain('key="extruder" value="3"');
    const project = JSON.parse(await zip.file('Metadata/project_settings.config')!.async('string'));
    expect(project.filament_colour).toHaveLength(3);
    expect(project.printer_settings_id).toBe('Bambu Lab X1 Carbon 0.4 nozzle');
    const back = await read3mf(bytes);
    expect(back).toHaveLength(1);
    expect(meshVolume(back[0].mesh)).toBeCloseTo(meshVolume(wheel.mesh), -2);
  });

  it('draws a true-size template with the piece named', async () => {
    const kind = kindDef('wheel');
    const [wheel] = await read3mf(part('wheel-half.3mf'));
    const pieces = [{ id: 'wheel-half', name: 'Wheel half', mesh: wheel.mesh }];
    const surface = surfaceInput(kind.surfaces[0], pieces);
    const map = buildSurfaceMap(surface, pieces, 2);
    const svg = templateSvg(map, new Map([['wheel-half', 'Wheel half']]), 'Wheel face');
    expect(svg).toContain('width="280.00mm"');
    expect(svg).toContain('Wheel half');
    const parsed = parseSvg(svg);
    expect(parsed.widthMm).toBeCloseTo(280, 0);
    expect(parsed.shapes.length).toBeGreaterThan(0);
  });
});
