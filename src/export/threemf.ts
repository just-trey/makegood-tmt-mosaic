import type { IndexedMesh } from '../types';
import { zipStore, type ZipEntry } from './zip';
import type { Printer } from './printers';

export interface ExportMaterial {
  name: string;
  color: string;
}
export interface ExportSub {
  name: string;
  matIndex: number;
  /** Manifold's native index, emitted as-is when available (skips re-welding the soup). */
  indexed?: IndexedMesh;
  /** Unindexed soup; welded on the fly when `indexed` is absent (flat mode, fallback parts). */
  soup?: Float32Array;
}
export interface ExportPart {
  name: string;
  /** face-down tilt direction: +1/-1 rotate the design face onto the plate, 0 = export upright */
  nsign: number;
  bodySoup: Float32Array;
  subs: ExportSub[];
  /** in-plane spin (deg) for this part specifically; falls back to ExportOptions.rotZdeg. */
  rotZdeg?: number;
  /** 1-based plate pin — parts sharing a hint go onto the same plate together (stride offset
   * only; XY placement within the plate comes from fixedPos below). */
  plateHint?: number;
  /** Absolute local (pre-stride) plate-plane position, bypassing footprint-based packing —
   * used for parts whose placement is a fixed, externally-verified constant rather than
   * something to compute (see WHEEL_TOP_POS/WHEEL_CAP_POS). */
  fixedPos?: { x: number; y: number };
  /** This part's final local position anchors its plate's prime/wipe tower offset (see
   * WHEEL_PRIME_TOWER_DELTA) — set on the wheel's Top half. */
  primeTowerAnchor?: boolean;
}
export interface ExportOptions {
  rotZdeg?: number;
  printer: Printer;
}

/**
 * Triangle soup -> indexed {verts, tris} for compact 3MF output. The key rounds to 4 decimals
 * (0.1 micron) via integer scaling — Math.round is markedly cheaper than toFixed(4), which
 * matters on large meshes. Used for meshes that don't arrive pre-indexed (flat mode, fallback
 * parts); Manifold-derived assembly meshes carry their own index and skip this entirely.
 */
export function soupToIndexed(soup: Float32Array): { verts: number[]; tris: number[] } {
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tris: number[] = [];
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i],
      y = soup[i + 1],
      z = soup[i + 2];
    const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let idx = map.get(k);
    if (idx === undefined) {
      idx = verts.length / 3;
      verts.push(x, y, z);
      map.set(k, idx);
    }
    tris.push(idx);
  }
  return { verts, tris };
}

export function xmlEscape(s: unknown): string {
  return String(s).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string,
  );
}

export function fmtCoord(v: number): string {
  return Number.isFinite(v) ? v.toFixed(5) : '0';
}

/**
 * Row-vector rotation R = Rx(theta) * Rz(phi) (apply face-down tilt first, then spin about the
 * vertical axis). Returned as a 3x3 where a point transforms as p' = p * R.
 */
export function rotXthenZ(thetaDeg: number, phiDeg: number): number[][] {
  const t = (thetaDeg * Math.PI) / 180,
    p = (phiDeg * Math.PI) / 180;
  const ct = Math.cos(t),
    st = Math.sin(t),
    cp = Math.cos(p),
    sp = Math.sin(p);
  return [
    [cp, sp, 0],
    [-ct * sp, ct * cp, st],
    [st * sp, -st * cp, ct],
  ];
}

/**
 * Minimal Bambu Studio project settings (Metadata/project_settings.config). This is what makes
 * the palette show up as actual filament colors on import — Bambu ignores core-spec 3MF
 * basematerials entirely. Only the keys we care about are written; Bambu (and Snapmaker
 * Orca/OrcaSlicer, which read the same project_settings.config shape) fill everything else from
 * the named system presets / the user's current profile.
 */
export function bambuProjectSettings(
  materials: ExportMaterial[],
  printer: Printer,
  wipeTower?: Array<{ x: number; y: number } | undefined>,
): string {
  const { plate } = printer;
  const rep = (v: string) => materials.map(() => v);
  const nozzle = printer.variant || '0.4';
  // Keys we override on top of the named print preset. Bambu-family slicers (Bambu Studio,
  // OrcaSlicer, Snapmaker Orca — same project_settings.config shape, confirmed against a real
  // Snapmaker Orca export) use `different_settings_to_system` to know these are intentional
  // per-project overrides rather than incidentally-resolved values; without it, a reload/resave
  // can silently reconcile them back to the preset's own current default.
  const printOverrideKeys = [
    'sparse_infill_density',
    'sparse_infill_pattern',
    'enable_support',
    'support_type',
  ];
  return JSON.stringify(
    {
      from: 'project',
      name: 'project_settings',
      version: '02.00.03.54',
      printer_settings_id: printer.printerId,
      print_settings_id: printer.printId,
      filament_settings_id: rep(printer.filamentId),
      filament_colour: materials.map((m) => (m.color || '#CCCCCC').toUpperCase()),
      filament_type: rep('PETG'),
      filament_diameter: rep('1.75'),
      nozzle_diameter: [nozzle],
      printable_area: ['0x0', plate.w + 'x0', plate.w + 'x' + plate.d, '0x' + plate.d],
      printable_height: String(plate.height),
      curr_bed_type: printer.bedType,
      // sparse infill: 15% gyroid, tree(auto) support — same keys across Bambu Studio, OrcaSlicer,
      // and Snapmaker Orca, layered on top of the printer's own standard process profile.
      sparse_infill_density: '15%',
      sparse_infill_pattern: 'gyroid',
      enable_support: '1',
      support_type: 'tree(auto)',
      support_style: 'default',
      // [print, one per filament, printer] — only the print slot (index 0) differs from system.
      different_settings_to_system: [printOverrideKeys.join(';'), ...rep(''), ''],
      // Prime/wipe tower position, one entry per plate — only set for wheel exports (see
      // WHEEL_PRIME_TOWER_DELTA). Not listed in different_settings_to_system: the reference file
      // this was verified against doesn't track it there either, so a plain value matches real
      // slicer behavior. A plate with no anchor part falls back to plate center.
      ...(wipeTower
        ? {
            wipe_tower_x: wipeTower.map((w) => fmtCoord(w ? w.x : plate.w / 2)),
            wipe_tower_y: wipeTower.map((w) => fmtCoord(w ? w.y : plate.d / 2)),
          }
        : {}),
    },
    null,
    1,
  );
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
 * Parts are laid MOSAIC-FACE-DOWN, spun `opts.rotZdeg` about vertical (or their own
 * `part.rotZdeg`, when set), then packed onto `opts.printer`'s build plates. Parts carrying a
 * `plateHint` go onto that plate together instead of through the size-driven greedy packer (used
 * by the wheel assembly: top half + cap share plate 1, each rotated-duplicate half gets its own
 * plate) — the greedy packer claims plates largest-footprint-first, each part joining an existing
 * plate's row only if it fits, otherwise opening a new plate. A part carrying `fixedPos` skips
 * footprint-based placement entirely and goes exactly there (see WHEEL_TOP_POS/WHEEL_CAP_POS) —
 * used for parts whose real-world placement has been externally verified rather than computed,
 * since bounding-box math alone can't tell a genuine overlap from a concave part's open interior.
 * A part that still overhangs its plate (fixed or computed) is reported back via `warnings`
 * instead of assumed safe.
 *   materials: index 0 = body/base, then one per palette color
 */

// Wheel assembly's Top (wheel half) and Cap parts use a fixed rotation + plate position instead
// of computed placement — the geometry is a specific, externally-verified real product (see
// stubs/whlle-reference.3mf, the shipped MakeGood TMT project file), not something to re-derive.
// Values are the reference file's own build-item transforms, corrected for the recentering Bambu
// applies on import (recoverable from that file's model_settings.config source_offset_y/z): Top's
// -45° spin is the mirror of what a generic angle search would ever land on, and Cap's position
// is only valid relative to this exact Top placement, so both must be applied together, never
// re-derived per printer or per export. Verified against all three registered printer plates.
export const WHEEL_TOP_ROT_DEG = -45;
export const WHEEL_TOP_POS = { x: 104.106567, y: 104.933839 };
export const WHEEL_CAP_ROT_DEG = 0;
// Cap's position relative to Top, from a second reference: stubs/mosaic-wheel-snapmaker.3mf, our
// own exported wheel reopened and hand-repositioned by the user in Snapmaker Orca (already a
// vendor project reopen, not a fresh import, so no recentering correction needed). Cap rides
// along with Top under placeHintedGroup's per-plate group-centering, so this single constant is
// enough to keep it locked to Top's new position on every printer.
export const WHEEL_CAP_POS = { x: 87.861827, y: 50.328835 };
// Prime/wipe tower position, likewise from stubs/mosaic-wheel-snapmaker.3mf — the user manually
// dragged the tower on that file's plate 1 in Snapmaker Orca. Expressed as an offset from the
// Top anchor's own final local position (not an absolute), so the same relative placement
// reproduces on every printer and on every plate a Top half lands on (see `primeTowerAnchor`).
export const WHEEL_PRIME_TOWER_DELTA = { x: -87.833131, y: -28.867078 };
// The plate the reference file's own positions were authored against (Bambu X1C, 256x256) — used
// only to recognize that printer and leave its fixedPos values untouched (see `isRefPlate` below).
// On any other printer's plate, each fixedPos group is instead re-centered on its own true
// bounding box (see `placeHintedGroup`), not by a fixed offset off this constant — the reference
// file's own placement isn't itself centered on its 256x256 plate (off by a few mm), so scaling
// that same skew down to a bigger plate looked fine on the much-larger H2D bed but was visibly
// off-center on the Snapmaker U1's, which only has 14mm more room than the reference in each axis.
const WHEEL_REF_PLATE = { w: 256, d: 256 };

export async function build3MFCombined(
  materials: ExportMaterial[],
  parts: ExportPart[],
  opts: ExportOptions,
): Promise<{ blob: Blob; warnings: string[] }> {
  const rotZ = opts.rotZdeg || 0,
    gap = 8;
  const printer = opts.printer;
  const plateW = printer.plate.w;
  const plateD = printer.plate.d;
  const enc = new TextEncoder();
  const files: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`),
    },
    {
      name: '_rels/.rels',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`),
    },
  ];

  interface Placed {
    part: ExportPart;
    R: number[][];
    w: number;
    d: number;
    cx: number;
    cy: number;
    minZ: number;
    tx?: number;
    ty?: number;
    tz?: number;
    cid?: number;
    subs?: { id: number; name: string; matIndex: number }[];
    xf?: string;
  }

  // Rotated footprint at a given in-plane spin angle, from every body vertex — NOT from
  // rotating the un-rotated bbox's 8 corners. That shortcut is exact only when the part isn't
  // actually spun (corners == true extremes there), but badly overestimates the footprint of a
  // non-box shape (e.g. a thin curved crescent) once a real Z angle is combined with the
  // face-down tilt: the rotated "ghost" corners land far outside where the real mesh ever
  // reaches. Transforming all vertices is the only way to get the true rotated AABB.
  function footprintFor(
    part: ExportPart,
    angleDeg: number,
  ): { R: number[][]; w: number; d: number; cx: number; cy: number; minZ: number } {
    const R = rotXthenZ(-90 * part.nsign, angleDeg);
    const tmn = [Infinity, Infinity, Infinity],
      tmx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < part.bodySoup.length; i += 3) {
      const x = part.bodySoup[i],
        y = part.bodySoup[i + 1],
        z = part.bodySoup[i + 2];
      const p = [
        x * R[0][0] + y * R[1][0] + z * R[2][0],
        x * R[0][1] + y * R[1][1] + z * R[2][1],
        x * R[0][2] + y * R[1][2] + z * R[2][2],
      ];
      for (let k = 0; k < 3; k++) {
        if (p[k] < tmn[k]) tmn[k] = p[k];
        if (p[k] > tmx[k]) tmx[k] = p[k];
      }
    }
    // The build-plate flush height has to account for every sub-mesh, not just the body: a
    // color recess cuts into the body's own surface, so the inlay filling that recess can reach
    // further along the tilt-affected axis than the (now-holed) body mesh does on its own —
    // using body-only minZ left the inlay floating below Z=0 in the exported file.
    let minZ = tmn[2];
    for (const sub of part.subs) {
      const verts: ArrayLike<number> | undefined = sub.indexed ? sub.indexed.positions : sub.soup;
      if (!verts) continue;
      for (let i = 0; i < verts.length; i += 3) {
        const x = verts[i],
          y = verts[i + 1],
          z = verts[i + 2];
        const pz = x * R[0][2] + y * R[1][2] + z * R[2][2];
        if (pz < minZ) minZ = pz;
      }
    }
    return {
      R,
      w: tmx[0] - tmn[0],
      d: tmx[1] - tmn[1],
      cx: (tmn[0] + tmx[0]) / 2,
      cy: (tmn[1] + tmx[1]) / 2,
      minZ,
    };
  }

  const placed: Placed[] = parts.map((part) => ({
    part,
    ...footprintFor(part, part.rotZdeg ?? rotZ),
  }));

  const warnings: string[] = [];
  for (const pl of placed) {
    const worst = Math.max(pl.w - plateW, pl.d - plateD);
    if (worst > 0.5)
      warnings.push(
        `"${pl.part.name}" overhangs the ${plateW}×${plateD}mm plate by ~${Math.ceil(worst)}mm even at its best-fit rotation.`,
      );
  }

  // Bambu X1C's plate is exactly the size the reference file's fixedPos values were authored
  // against — leave them verbatim there, the real tested layout. Any other printer's plate gets
  // each fixedPos group (plate 1's Top + Cap, each plate 2+ rotated-duplicate Top alone)
  // re-centered on its own true bounding box instead (see `placeHintedGroup`).
  const isRefPlate = plateW === WHEEL_REF_PLATE.w && plateD === WHEEL_REF_PLATE.d;

  // A part carrying plateHint is pinned to that plate instead of going through the greedy
  // packer — used by the wheel assembly (top half + cap share plate 1, each rotated-duplicate
  // half gets its own plate; see exportPanel.ts). Placement within the plate comes from each
  // part's fixedPos when set (the normal case here — see WHEEL_TOP_POS/WHEEL_CAP_POS), or plate
  // center as a fallback for any hinted part that doesn't carry one.
  function placeHintedGroup(items: Placed[]): void {
    let groupOffsetX = 0,
      groupOffsetY = 0;
    if (!isRefPlate) {
      // True world bounding box of this plate's fixedPos group (e.g. Top + Cap together), from
      // each item's own rotated footprint (cx/w/d, cy) plus its raw fixedPos — not a symmetric
      // assumption about where the group sits on the reference plate.
      let gMinX = Infinity,
        gMaxX = -Infinity,
        gMinY = Infinity,
        gMaxY = -Infinity;
      items.forEach((pl) => {
        const pos = pl.part.fixedPos;
        if (!pos) return;
        gMinX = Math.min(gMinX, pos.x + pl.cx - pl.w / 2);
        gMaxX = Math.max(gMaxX, pos.x + pl.cx + pl.w / 2);
        gMinY = Math.min(gMinY, pos.y + pl.cy - pl.d / 2);
        gMaxY = Math.max(gMaxY, pos.y + pl.cy + pl.d / 2);
      });
      if (gMinX !== Infinity) {
        groupOffsetX = (plateW - (gMaxX - gMinX)) / 2 - gMinX;
        groupOffsetY = (plateD - (gMaxY - gMinY)) / 2 - gMinY;
      }
    }
    items.forEach((pl) => {
      const pos = pl.part.fixedPos;
      pl.tx = pos ? pos.x + groupOffsetX : plateW / 2 - pl.cx;
      pl.ty = pos ? pos.y + groupOffsetY : plateD / 2 - pl.cy;
      pl.tz = -pl.minZ;
    });
  }

  const useHints = placed.some((pl) => pl.part.plateHint != null);
  const plates: { row: Placed[]; wipeTower?: { x: number; y: number } }[] = [];
  if (useHints) {
    // group by plateHint (ascending); parts without a hint each open their own plate
    const groups = new Map<number, Placed[]>();
    let auto = 1e6;
    placed.forEach((pl) => {
      const h = pl.part.plateHint ?? auto++;
      (groups.get(h) || groups.set(h, []).get(h)!).push(pl);
    });
    [...groups.keys()].sort((a, b) => a - b).forEach((h) => plates.push({ row: groups.get(h)! }));
  } else {
    // greedy plate packing: biggest footprints claim plates first, small parts
    // slot into an existing plate's row when there's room
    placed
      .slice()
      .sort((a, b) => b.w * b.d - a.w * a.d)
      .forEach((pl) => {
        let plate = plates.find(
          (p) =>
            pl.d <= plateD &&
            p.row.reduce((s, q) => s + q.w, 0) + p.row.length * gap + pl.w <= plateW,
        );
        if (!plate) {
          plate = { row: [] };
          plates.push(plate);
        }
        plate.row.push(pl);
      });
  }
  // Local placement first (no world-X offset yet).
  if (useHints) {
    plates.forEach((plate) => {
      placeHintedGroup(plate.row);
      // Prime/wipe tower position is relative to this plate's own Top anchor's final local
      // position (still pre-stride here, which is exactly what wipe_tower_x/y want).
      const anchor = plate.row.find((pl) => pl.part.primeTowerAnchor);
      if (anchor) {
        plate.wipeTower = {
          x: anchor.tx! + WHEEL_PRIME_TOWER_DELTA.x,
          y: anchor.ty! + WHEEL_PRIME_TOWER_DELTA.y,
        };
      }
    });
  } else {
    plates.forEach((plate) => {
      const totalW = plate.row.reduce((s, q) => s + q.w, 0) + gap * (plate.row.length - 1);
      let x = plateW / 2 - totalW / 2;
      plate.row.forEach((pl) => {
        pl.tx = x + pl.w / 2 - pl.cx; // row across the plate, centered
        pl.ty = plateD / 2 - pl.cy; // centered front-to-back
        pl.tz = -pl.minZ; // rest the face flat on the plate (Z=0)
        x += pl.w + gap;
      });
    });
  }
  // Bambu lays logical plates out along world X with a gap of 1/5 plate width
  // (LOGICAL_PART_PLATE_GAP); build item transforms are world coordinates.
  const stride = plateW * 1.2;
  plates.forEach((plate, pi) => {
    const offsetX = pi * stride;
    plate.row.forEach((pl) => {
      pl.tx = (pl.tx ?? 0) + offsetX;
    });
  });

  let nextId = 1;
  let objXml = '';
  const items: string[] = [];
  for (const pl of placed) {
    const subs: { id: number; name: string; matIndex: number }[] = [];
    for (const sub of pl.part.subs) {
      const { verts, tris }: { verts: ArrayLike<number>; tris: ArrayLike<number> } = sub.indexed
        ? { verts: sub.indexed.positions, tris: sub.indexed.indices }
        : soupToIndexed(sub.soup!);
      const oid = nextId++;
      subs.push({ id: oid, name: sub.name, matIndex: sub.matIndex });
      const vlines: string[] = [];
      for (let v = 0; v < verts.length; v += 3)
        vlines.push(
          `<vertex x="${fmtCoord(verts[v])}" y="${fmtCoord(verts[v + 1])}" z="${fmtCoord(verts[v + 2])}"/>`,
        );
      const tlines: string[] = [];
      for (let t = 0; t < tris.length; t += 3)
        tlines.push(`<triangle v1="${tris[t]}" v2="${tris[t + 1]}" v3="${tris[t + 2]}"/>`);
      objXml += `  <object id="${oid}" name="${xmlEscape(sub.name)}" type="model">
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
    objXml += `  <object id="${cid}" name="${xmlEscape(pl.part.name)}" type="model">
   <components>
${subs.map((s) => `    <component objectid="${s.id}"/>`).join('\n')}
   </components>
  </object>
`;
    const R = pl.R;
    pl.cid = cid;
    pl.subs = subs;
    pl.xf = [
      R[0][0],
      R[0][1],
      R[0][2],
      R[1][0],
      R[1][1],
      R[1][2],
      R[2][0],
      R[2][1],
      R[2][2],
      pl.tx!,
      pl.ty!,
      pl.tz!,
    ]
      .map((v) => +v.toFixed(6))
      .join(' ');
    items.push(`  <item objectid="${cid}" transform="${pl.xf}" printable="1"/>`);
  }

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">BambuStudio-02.00.03.54</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${objXml} </resources>
 <build>
${items.join('\n')}
 </build>
</model>`;
  files.push({ name: '3D/3dmodel.model', data: enc.encode(model) });

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
    // Plate name: the distinct part names actually on it (e.g. "Top + Cap"), not a blank —
    // Bambu Studio/OrcaSlicer show this in the plate list/preview UI.
    const plateName = [...new Set(plate.row.map((pl) => pl.part.name))].join(' + ');
    cfg.push('  <plate>');
    cfg.push(`    <metadata key="plater_id" value="${pi + 1}"/>`);
    cfg.push(`    <metadata key="plater_name" value="${xmlEscape(plateName)}"/>`);
    cfg.push(`    <metadata key="locked" value="false"/>`);
    plate.row.forEach((pl) => {
      cfg.push('    <model_instance>');
      cfg.push(`      <metadata key="object_id" value="${pl.cid}"/>`);
      cfg.push(`      <metadata key="instance_id" value="0"/>`);
      cfg.push(`      <metadata key="identify_id" value="${identifyId++}"/>`);
      cfg.push('    </model_instance>');
    });
    cfg.push('  </plate>');
  });
  cfg.push('  <assemble>');
  for (const pl of placed)
    cfg.push(
      `   <assemble_item object_id="${pl.cid}" instance_id="0" transform="${pl.xf}" offset="0 0 0"/>`,
    );
  cfg.push('  </assemble>');
  cfg.push('</config>');
  files.push({ name: 'Metadata/model_settings.config', data: enc.encode(cfg.join('\n')) });

  files.push({
    name: 'Metadata/project_settings.config',
    data: enc.encode(
      bambuProjectSettings(
        materials,
        printer,
        useHints ? plates.map((p) => p.wipeTower) : undefined,
      ),
    ),
  });
  return { blob: zipStore(files), warnings };
}
