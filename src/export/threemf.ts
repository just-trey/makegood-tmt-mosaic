import JSZip from 'jszip';

export interface ExportMaterial { name: string; color: string }
export interface ExportSub { name: string; matIndex: number; soup: Float32Array }
export interface ExportPart {
  name: string;
  /** face-down tilt direction: +1/-1 rotate the design face onto the plate, 0 = export upright */
  nsign: number;
  bodySoup: Float32Array;
  subs: ExportSub[];
}
export interface ExportOptions { rotZdeg?: number; plate?: { w: number; d: number } }

/** Triangle soup -> indexed {verts, tris} for compact 3MF output. */
export function soupToIndexed(soup: Float32Array): { verts: number[]; tris: number[] } {
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tris: number[] = [];
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    const k = x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
    let idx = map.get(k);
    if (idx === undefined) { idx = verts.length / 3; verts.push(x, y, z); map.set(k, idx); }
    tris.push(idx);
  }
  return { verts, tris };
}

export function xmlEscape(s: unknown): string {
  return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
}

export function fmtCoord(v: number): string {
  return Number.isFinite(v) ? v.toFixed(5) : '0';
}

/**
 * Row-vector rotation R = Rx(theta) * Rz(phi) (apply face-down tilt first, then spin about the
 * vertical axis). Returned as a 3x3 where a point transforms as p' = p * R.
 */
export function rotXthenZ(thetaDeg: number, phiDeg: number): number[][] {
  const t = thetaDeg * Math.PI / 180, p = phiDeg * Math.PI / 180;
  const ct = Math.cos(t), st = Math.sin(t), cp = Math.cos(p), sp = Math.sin(p);
  return [
    [cp, sp, 0],
    [-ct * sp, ct * cp, st],
    [st * sp, -st * cp, ct],
  ];
}

/**
 * Minimal Bambu Studio project settings (Metadata/project_settings.config). This is what makes
 * the palette show up as actual filament colors on import — Bambu ignores core-spec 3MF
 * basematerials entirely. Only the keys we care about are written; Bambu fills everything else
 * from the named system presets / the user's current profile.
 */
export function bambuProjectSettings(materials: ExportMaterial[], plateW: number, plateD: number): string {
  const presets: Record<string, { printer: string; print: string; filament: string; height: number }> = {
    '256x256': { printer: 'Bambu Lab X1 Carbon 0.4 nozzle', print: '0.20mm Standard @BBL X1C', filament: 'Bambu PLA Basic @BBL X1C', height: 250 },
    '350x320': { printer: 'Bambu Lab H2D 0.4 nozzle', print: '0.20mm Standard @BBL H2D', filament: 'Bambu PLA Basic @BBL H2D', height: 325 },
    '180x180': { printer: 'Bambu Lab A1 mini 0.4 nozzle', print: '0.20mm Standard @BBL A1M', filament: 'Bambu PLA Basic @BBL A1M', height: 180 },
  };
  const p = presets[plateW + 'x' + plateD] || presets['256x256'];
  const rep = (v: string) => materials.map(() => v);
  return JSON.stringify({
    from: 'project',
    name: 'project_settings',
    version: '02.00.03.54',
    printer_settings_id: p.printer,
    print_settings_id: p.print,
    filament_settings_id: rep(p.filament),
    filament_colour: materials.map(m => (m.color || '#CCCCCC').toUpperCase()),
    filament_type: rep('PLA'),
    filament_diameter: rep('1.75'),
    nozzle_diameter: ['0.4'],
    printable_area: ['0x0', plateW + 'x0', plateW + 'x' + plateD, '0x' + plateD],
    printable_height: String(p.height),
    curr_bed_type: 'Textured PEI Plate',
  }, null, 1);
}

/**
 * One combined print-ready .3mf, written as a Bambu Studio *project* (Bambu Studio / Orca
 * compatible). A generic core-spec 3MF makes Bambu Studio pop the "not from Bambu Lab" dialog,
 * drop material colors, auto-rename parts, and pile everything onto one plate — so we write the
 * vendor format it actually honors:
 *   - 3D/3dmodel.model carrying the BambuStudio:3mfVersion marker (suppresses the dialog),
 *     with mesh sub-objects + one component object per physical part
 *   - Metadata/model_settings.config: part names, per-part filament (extruder) assignment,
 *     and one <plate> block per build plate
 *   - Metadata/project_settings.config: filament colors (see bambuProjectSettings above)
 * Parts are laid MOSAIC-FACE-DOWN, spun `rotZdeg` about vertical, then packed onto
 * `opts.plate`-sized build plates: largest footprint first, each part joining an existing
 * plate's row only if it fits, otherwise opening a new plate. A part bigger than the plate
 * still gets its own plate, centered — the overhang is visible and the user's call.
 *   materials: index 0 = body/base, then one per palette color
 */
export async function build3MFCombined(materials: ExportMaterial[], parts: ExportPart[], opts?: ExportOptions): Promise<Blob> {
  opts = opts || {};
  const rotZ = opts.rotZdeg || 0, gap = 8;
  const plateW = (opts.plate && opts.plate.w) || 256;
  const plateD = (opts.plate && opts.plate.d) || 256;
  const z = new JSZip();
  z.file('[Content_Types].xml',
`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`);
  z.file('_rels/.rels',
`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`);

  interface Placed {
    part: ExportPart; R: number[][];
    w: number; d: number; cx: number; cy: number; minZ: number;
    tx?: number; ty?: number; tz?: number;
    cid?: number; subs?: { id: number; name: string; matIndex: number }[]; xf?: string;
  }

  // per-part rotation + transformed footprint (from the body bbox corners)
  const placed: Placed[] = parts.map(part => {
    const R = rotXthenZ(-90 * part.nsign, rotZ);
    const s = part.bodySoup;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { const v = s[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    const tr = (x: number, y: number, zz: number) => [
      x * R[0][0] + y * R[1][0] + zz * R[2][0],
      x * R[0][1] + y * R[1][1] + zz * R[2][1],
      x * R[0][2] + y * R[1][2] + zz * R[2][2],
    ];
    const tmn = [Infinity, Infinity, Infinity], tmx = [-Infinity, -Infinity, -Infinity];
    for (const cx of [mn[0], mx[0]]) for (const cy of [mn[1], mx[1]]) for (const cz of [mn[2], mx[2]]) {
      const p = tr(cx, cy, cz);
      for (let k = 0; k < 3; k++) { if (p[k] < tmn[k]) tmn[k] = p[k]; if (p[k] > tmx[k]) tmx[k] = p[k]; }
    }
    return { part, R, w: tmx[0] - tmn[0], d: tmx[1] - tmn[1], cx: (tmn[0] + tmx[0]) / 2, cy: (tmn[1] + tmx[1]) / 2, minZ: tmn[2] };
  });

  // greedy plate packing: biggest footprints claim plates first, small parts (the cap)
  // slot into an existing plate's row when there's room
  const plates: { row: Placed[] }[] = [];
  placed.slice().sort((a, b) => (b.w * b.d) - (a.w * a.d)).forEach(pl => {
    let plate = plates.find(p =>
      pl.d <= plateD &&
      p.row.reduce((s, q) => s + q.w, 0) + p.row.length * gap + pl.w <= plateW);
    if (!plate) { plate = { row: [] }; plates.push(plate); }
    plate.row.push(pl);
  });
  // Bambu lays logical plates out along world X with a gap of 1/5 plate width
  // (LOGICAL_PART_PLATE_GAP); build item transforms are world coordinates.
  const stride = plateW * 1.2;
  plates.forEach((plate, pi) => {
    const totalW = plate.row.reduce((s, q) => s + q.w, 0) + gap * (plate.row.length - 1);
    let x = pi * stride + plateW / 2 - totalW / 2;
    plate.row.forEach(pl => {
      pl.tx = (x + pl.w / 2) - pl.cx;  // row across the plate, centered
      pl.ty = plateD / 2 - pl.cy;      // centered front-to-back
      pl.tz = -pl.minZ;                // rest the face flat on the plate (Z=0)
      x += pl.w + gap;
    });
  });

  let nextId = 1;
  let objXml = '';
  const items: string[] = [];
  for (const pl of placed) {
    const subs: { id: number; name: string; matIndex: number }[] = [];
    for (const sub of pl.part.subs) {
      const { verts, tris } = soupToIndexed(sub.soup);
      const oid = nextId++;
      subs.push({ id: oid, name: sub.name, matIndex: sub.matIndex });
      const vlines: string[] = [];
      for (let v = 0; v < verts.length; v += 3) vlines.push(`<vertex x="${fmtCoord(verts[v])}" y="${fmtCoord(verts[v + 1])}" z="${fmtCoord(verts[v + 2])}"/>`);
      const tlines: string[] = [];
      for (let t = 0; t < tris.length; t += 3) tlines.push(`<triangle v1="${tris[t]}" v2="${tris[t + 1]}" v3="${tris[t + 2]}"/>`);
      objXml +=
`  <object id="${oid}" name="${xmlEscape(sub.name)}" type="model">
   <mesh>
    <vertices>
${vlines.join('\n')}
    </vertices>
    <triangles>
${tlines.join('\n')}
    </triangles>
   </mesh>
  </object>
`;
    }
    const cid = nextId++;
    objXml +=
`  <object id="${cid}" name="${xmlEscape(pl.part.name)}" type="model">
   <components>
${subs.map(s => `    <component objectid="${s.id}"/>`).join('\n')}
   </components>
  </object>
`;
    const R = pl.R;
    pl.cid = cid;
    pl.subs = subs;
    pl.xf = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2], pl.tx!, pl.ty!, pl.tz!]
      .map(v => +v.toFixed(6)).join(' ');
    items.push(`  <item objectid="${cid}" transform="${pl.xf}" printable="1"/>`);
  }

  const model =
`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">BambuStudio-02.00.03.54</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${objXml} </resources>
 <build>
${items.join('\n')}
 </build>
</model>`;
  z.file('3D/3dmodel.model', model);

  // model_settings.config: this is where Bambu Studio actually reads object/part names,
  // per-part filament (extruder) assignment, and plate membership from.
  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  for (const pl of placed) {
    cfg.push(`  <object id="${pl.cid}">`);
    cfg.push(`    <metadata key="name" value="${xmlEscape(pl.part.name)}"/>`);
    cfg.push(`    <metadata key="extruder" value="1"/>`);
    for (const s of pl.subs!) {
      cfg.push(`    <part id="${s.id}" subtype="normal_part">`);
      cfg.push(`      <metadata key="name" value="${xmlEscape(s.name)}"/>`);
      cfg.push(`      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>`);
      cfg.push(`      <metadata key="extruder" value="${s.matIndex + 1}"/>`);
      cfg.push(`    </part>`);
    }
    cfg.push(`  </object>`);
  }
  let identifyId = 100;
  plates.forEach((plate, pi) => {
    cfg.push('  <plate>');
    cfg.push(`    <metadata key="plater_id" value="${pi + 1}"/>`);
    cfg.push(`    <metadata key="plater_name" value=""/>`);
    cfg.push(`    <metadata key="locked" value="false"/>`);
    plate.row.forEach(pl => {
      cfg.push('    <model_instance>');
      cfg.push(`      <metadata key="object_id" value="${pl.cid}"/>`);
      cfg.push(`      <metadata key="instance_id" value="0"/>`);
      cfg.push(`      <metadata key="identify_id" value="${identifyId++}"/>`);
      cfg.push('    </model_instance>');
    });
    cfg.push('  </plate>');
  });
  cfg.push('  <assemble>');
  for (const pl of placed) cfg.push(`   <assemble_item object_id="${pl.cid}" instance_id="0" transform="${pl.xf}" offset="0 0 0"/>`);
  cfg.push('  </assemble>');
  cfg.push('</config>');
  z.file('Metadata/model_settings.config', cfg.join('\n'));

  z.file('Metadata/project_settings.config', bambuProjectSettings(materials, plateW, plateD));
  return z.generateAsync({ type: 'blob' });
}
