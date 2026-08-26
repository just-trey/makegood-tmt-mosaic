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
  /**
   * Baked full 3x3 plate rotation (row-major, p' = p * R), overriding the default face-down
   * tilt+spin, for a part whose verified pose isn't "design face flat on the plate" (the footrest
   * stands on its long edge, see FOOTREST_PLATE_R). Verbatim from the part's reference 3MF
   * build-item transform, so rotZdeg/nsign don't apply when this is set.
   */
  plateR?: number[][];
  /** 1-based plate pin: parts sharing a hint share a plate (stride offset only; XY comes from
   * fixedPos below). */
  plateHint?: number;
  /** Absolute local (pre-stride) plate position, bypassing footprint packing. For a placement that
   * is an externally-verified constant, not something to compute (see WHEEL_TOP_POS/WHEEL_CAP_POS). */
  fixedPos?: { x: number; y: number };
  /** Bed-specific absolute positions, keyed `"<w>x<d>"` in mm. Like `primeTowerDeltaByPlate`, a key
   * means that bed was verified in its own right. Unlike `fixedPos`, a match is taken VERBATIM and
   * skips `placeHintedGroup`'s re-centering, which exists to rescue a coordinate authored for a
   * different bed. Takes precedence over `fixedPos`. */
  fixedPosByPlate?: Record<string, { x: number; y: number }>;
  /** Prime/wipe tower offset from this part's final local position, set on the part anchoring its
   * plate's tower (the wheel's Top half, or the footrest). Held relative so the tower rides along
   * on every printer. Baked from the reference 3MF (WHEEL_/FOOTREST_PRIME_TOWER_DELTA). */
  primeTowerDelta?: { x: number; y: number };
  /** Bed-specific overrides for `primeTowerDelta`, keyed `"<w>x<d>"` in mm. Relative holding
   * transfers across beds for free in most cases, but not always: a position with room on a 270mm
   * plate can hit the edge once a 256mm plate re-centers the group. A key means that bed was
   * verified separately and disagreed; a bed with no key uses primeTowerDelta. */
  primeTowerDeltaByPlate?: Record<string, { x: number; y: number }>;
  /** Per-object Bambu print overrides, written into model_settings.config as <metadata key value/>
   * on this part's object (FOOTREST_OBJECT_SETTINGS; the chair's handles ask for a brim). Baked
   * from the part's reference 3MF. */
  objectSettings?: Record<string, string>;
  /** Project-wide Bambu settings this part's verified plate depends on, merged into
   * project_settings.config (`prime_tower_width`: the hubcap's clearance is only true at the width
   * it was verified at). Unlike `objectSettings`, these are global to the file, so a value here
   * claims something about the whole plate rather than one object. */
  projectSettings?: Record<string, string>;
}
export interface ExportOptions {
  rotZdeg?: number;
  printer: Printer;
}

/**
 * Triangle soup to indexed {verts, tris} for compact 3MF output. The key rounds to 4 decimals
 * (0.1 micron) via integer scaling: Math.round is markedly cheaper than toFixed(4) on large
 * meshes. Only for meshes that don't arrive pre-indexed (flat mode, fallback parts); Manifold
 * assembly meshes carry their own index and skip this.
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
  if (!Number.isFinite(v))
    throw new Error('Refusing to write a non-finite coordinate into the exported 3MF.');
  return v.toFixed(5);
}

/**
 * Group parts onto plates by their `plateHint`, ascending; anything unhinted opens its own plate.
 *
 * Shared with the pre-export summary (src/ui/exportPanel.ts), which has to state the plate count
 * the export will actually produce. A private copy there would be a second implementation of the
 * one rule a user reads before committing to a multi-day print, and the two would drift.
 *
 * Only the hinted branch. Greedy packing needs real footprints, so a caller that wants a count
 * before the meshes are placed has to check `partsCarryPlateHints` first and say nothing when it
 * is false.
 */
export function groupByPlateHint<T>(items: T[], hintOf: (item: T) => number | undefined): T[][] {
  const groups = new Map<number, T[]>();
  let auto = 1e6;
  items.forEach((it) => {
    const h = hintOf(it) ?? auto++;
    (groups.get(h) || groups.set(h, []).get(h)!).push(it);
  });
  return [...groups.keys()].sort((a, b) => a - b).map((h) => groups.get(h)!);
}

/** Whether plate layout is determined by hints, and so knowable without placing any geometry. */
export function partsCarryPlateHints(parts: { plateHint?: number }[]): boolean {
  return parts.some((p) => p.plateHint != null);
}

/**
 * Columns of logical build plates the slicer lays a project out in: Bambu's own
 * PartPlateList::compute_colum_count, `ceil(sqrt(n))` written the long way. Plates form a
 * square-ish grid, not a row. A 4-plate project is 2x2, a 12-plate one 4x3, both confirmed against
 * real MakeGood project files. It returns 2 for a 2-plate project, one row, which is why the
 * wheel's export was correct while this was hardcoded to a row.
 */
export function plateColumns(count: number): number {
  const value = Math.sqrt(count);
  const rounded = Math.round(value);
  return value > rounded ? rounded + 1 : rounded;
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
 * Minimal Bambu Studio project settings (Metadata/project_settings.config). This is what makes the
 * palette import as real filament colors: Bambu ignores core-spec 3MF basematerials entirely.
 * Only the keys we care about are written. Bambu, Snapmaker Orca and OrcaSlicer (same
 * project_settings.config shape) fill the rest from the named system presets.
 */
export function bambuProjectSettings(
  materials: ExportMaterial[],
  printer: Printer,
  wipeTower?: Array<{ x: number; y: number } | undefined>,
  /** Baked project-wide overrides from the parts on this plate (ExportPart.projectSettings). */
  extra?: Record<string, string>,
): string {
  const { plate } = printer;
  const rep = (v: string) => materials.map(() => v);
  const nozzle = printer.variant || '0.4';
  // Keys we override on top of the named print preset. Bambu-family slicers (Bambu Studio,
  // OrcaSlicer, Snapmaker Orca, same config shape, confirmed against a real Snapmaker Orca export)
  // read `different_settings_to_system` to tell a deliberate per-project override from an
  // incidentally-resolved value. Without it, a reload/resave silently reconciles them back.
  const printOverrideKeys = [
    'brim_type',
    'sparse_infill_density',
    'sparse_infill_pattern',
    'enable_support',
    'support_type',
    // Baked plate settings listed too, for the reason above: reconciling prime_tower_width back
    // to the preset default would silently retire the clearance the position was verified against.
    ...Object.keys(extra ?? {}),
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
      // 15% gyroid infill, tree(auto) support: same keys across Bambu Studio, OrcaSlicer and
      // Snapmaker Orca, layered on the printer's own standard process profile.
      sparse_infill_density: '15%',
      sparse_infill_pattern: 'gyroid',
      enable_support: '1',
      support_type: 'tree(auto)',
      support_style: 'default',
      // No brim on any part: mosaic faces are broad and print flat, so a brim only wastes filament
      // and adds a peel-off step. Global, not per-object, so every plate is brim-free. Matches the
      // reference project (mosaic-wheel-mount-left.3mf), which carries brim_type=no_brim tracked
      // in different_settings_to_system.
      brim_type: 'no_brim',
      // [print, one per filament, printer]: only the print slot (index 0) differs from system.
      different_settings_to_system: [printOverrideKeys.join(';'), ...rep(''), ''],
      // Prime/wipe tower position, one entry per plate: the verified primeTowerDelta of a part on
      // that plate (wheel, footrest), else the free corner suggestTowerPos works out. Deliberately
      // absent from different_settings_to_system, since the reference files don't track it there
      // either and a plain value matches real slicer behavior.
      ...(wipeTower
        ? {
            wipe_tower_x: wipeTower.map((w) => fmtCoord(w ? w.x : plate.w / 2)),
            wipe_tower_y: wipeTower.map((w) => fmtCoord(w ? w.y : plate.d / 2)),
          }
        : {}),
      // last, so a baked plate setting wins over anything above it that shares a key
      ...(extra ?? {}),
    },
    null,
    1,
  );
}

// Wheel Top (wheel half) and Cap use fixed rotation + plate position, never computed placement:
// the geometry is an externally-verified real product (stubs/whlle-reference.3mf, the shipped
// MakeGood TMT project file). Values are that file's own build-item transforms, corrected for the
// recentering Bambu applies on import (recoverable from its model_settings.config
// source_offset_y/z). Top's -45° spin is the mirror of what an angle search would land on, and
// Cap's position is only valid relative to this exact Top placement, so the two must be applied
// together and never re-derived per printer or export. Verified on all three registered plates.
export const WHEEL_TOP_ROT_DEG = -45;
export const WHEEL_TOP_POS = { x: 104.106567, y: 104.933839 };
export const WHEEL_CAP_ROT_DEG = 0;
// Cap relative to Top, from a second reference: stubs/mosaic-wheel-snapmaker.3mf, our own exported
// wheel reopened and hand-repositioned in Snapmaker Orca (a vendor project reopen, not a fresh
// import, so no recentering correction). Cap rides with Top under placeHintedGroup's per-plate
// centering, so this one constant keeps it locked to Top on every printer.
export const WHEEL_CAP_POS = { x: 87.861827, y: 50.328835 };
// Prime/wipe tower, also from stubs/mosaic-wheel-snapmaker.3mf, dragged by hand on that file's
// plate 1 in Snapmaker Orca. An offset from Top's final local position, not an absolute, so the
// placement reproduces on every printer and every plate a Top half lands on. Passed via Top's
// ExportPart.primeTowerDelta.
export const WHEEL_PRIME_TOWER_DELTA = { x: -87.833131, y: -28.867078 };
// The plate the fixedPos constants above were authored against (Bambu X1C, 256x256). Used only to
// recognize that printer and leave the values untouched (see `isRefPlate`). Any other plate
// re-centers each fixedPos group on its own true bounding box (see `placeHintedGroup`), never by a
// fixed offset off this constant: the reference placement isn't itself centered on its 256x256
// plate (off by a few mm), and scaling that skew looked fine on the large H2D bed but was visibly
// off-center on the Snapmaker U1, which has only 14mm more room per axis than the reference.
const ASSEMBLY_REF_PLATE = { w: 256, d: 256 };

// Footrest placement, baked from its reference Bambu project: same "use the tested numbers" rule
// as the wheel. The verified pose is a pure Rz(-45°) standing the part on its long (front-back)
// edge to print support-free, applied as a full matrix via ExportPart.plateR since it is not a
// face-down tilt. NO fixedPos: the reference translation (135.329137, 135.329137) is just the
// Snapmaker U1's 270x270 bed center and isn't portable, so the footrest centers on whatever plate
// (placeHintedGroup's no-fixedPos branch). The z lift is recovered as -minZ (rest-on-plate).
//
// Redundant with the general rotXthenZ(-90 * nsign, angleDeg) path for nsign: 0 + rotZdeg: -45,
// and kept as an explicit full 3x3 anyway: it generalizes to a future part whose verified
// reference pose is genuinely tilted, which the axis-aligned path cannot express. Collapse it into
// rotZdeg if that part never materializes.
export const FOOTREST_PLATE_R = [
  [0.707106781, -0.707106781, 0],
  [0.707106781, 0.707106781, 0],
  [0, 0, 1],
];
// Tower offset from the footrest's centered position, baked from stubs/footrest reference
// tower.3mf: tower at (165.138, 177.187), footrest at the U1 center (135.329137, 135.329137), so
// the difference is (29.808863, 41.857863). Held relative (ExportPart.primeTowerDelta) so it lands
// in the empty diagonal corner the 45°-rotated part leaves open, on every printer.
export const FOOTREST_PRIME_TOWER_DELTA = { x: 29.808863, y: 41.857863 };
/**
 * Per-object slicer overrides for the footrest, from the same verified reference: support off,
 * because the 45° standing pose is what makes it printable without any (see FOOTREST_PLATE_R).
 * Brim is off globally rather than per object (see `brim_type` in bambuProjectSettings).
 *
 * Exported so [tests/threemf.test.ts](../../tests/threemf.test.ts) builds its footrest from this
 * value rather than retyping it: a hand-copied duplicate keeps passing after this one changes.
 */
export const FOOTREST_OBJECT_SETTINGS: Record<string, string> = { enable_support: '0' };

/**
 * Hubcap plate placement, baked from two reference projects verified in the slicer (2026-08-06):
 * stubs/mosaic-hubcap.3mf (Bambu X1C, 256x256) and stubs/mosaic-hubcap-snap.3mf (Snapmaker U1,
 * 270x270). Both verified at the 220mm default.
 *
 * **The disc moved as well as the tower, and the two only work together.** Centred, a 220mm disc
 * leaves no corner a tower fits in on either bed, so the part was pushed up and right and the
 * tower put in the freed corner. Applying the tower position without the matching part position
 * puts the tower through the disc: hence one table, not two constants. Measured rim-to-tower
 * clearance: 7.0mm on the X1C, 18.9mm on the U1.
 *
 * Positions are plate-origin-relative. The Snapmaker file's `printable_area` starts at (0.5, 1),
 * not (0, 0), because Snapmaker Orca rewrites it on save, so its raw numbers were converted here,
 * not copied.
 *
 * `wipe_tower_x/y` is the tower's FRONT-LEFT CORNER, not its centre. Settled by these files, not
 * assumed: read as a centre, the X1C's 35mm tower would hang off the plate at x = -0.7 and clear
 * the disc by 31.6mm rather than the 7.0mm a human placed by eye.
 *
 * `prime_tower_width` is written because the clearance holds only for a tower that wide. It is NOT
 * an override the references carry: `different_settings_to_system` in both is just
 * `brim_type;enable_support;sparse_infill_pattern`, so 35 and 30 are each slicer's own default.
 * Writing it protects the verified clearance from a volunteer whose profile differs.
 *
 * **Only valid up to the verified diameter.** The hubcap is generated, so a larger disc
 * invalidates the arrangement. That condition lives with the geometry, in hubcapPlacement()
 * (src/geometry/hubcap.ts).
 */
export const HUBCAP_PLATE: Record<
  string,
  { pos: { x: number; y: number }; tower: { x: number; y: number }; towerWidthMm: string }
> = {
  '256x256': {
    pos: { x: 141.192, y: 142.3629 },
    tower: { x: 16.8181, y: 31.8954 },
    towerWidthMm: '35',
  },
  '270x270': {
    pos: { x: 149.5842, y: 148.0757 },
    tower: { x: 27.5488, y: 27.8477 },
    towerWidthMm: '30',
  },
};

/**
 * One combined print-ready .3mf, written as a Bambu Studio *project*. A generic core-spec 3MF
 * makes Bambu Studio pop the "not from Bambu Lab" dialog, drop material colors, auto-rename parts,
 * and pile everything onto one plate, so we write the vendor format it honors:
 *   - 3D/3dmodel.model with the BambuStudio:3mfVersion marker (suppresses the dialog), mesh
 *     sub-objects, and one component object per physical part
 *   - Metadata/model_settings.config: part names, per-part extruder assignment, one <plate> block
 *     per build plate
 *   - Metadata/project_settings.config: filament colors (see bambuProjectSettings above)
 *
 * Parts lay MOSAIC-FACE-DOWN (or a baked `part.plateR`, see FOOTREST_PLATE_R), spin `opts.rotZdeg`
 * or their own `part.rotZdeg`, then pack onto `opts.printer`'s plates.
 *
 * Placement, in precedence order:
 *   - `fixedPos` goes exactly there, skipping footprint packing. For externally-verified
 *     placements only: bounding-box math can't tell a real overlap from a concave part's open
 *     interior (see WHEEL_TOP_POS/WHEEL_CAP_POS).
 *   - `plateHint` groups parts onto one plate; hinted-but-unfixed (the footrest) centers on it.
 *   - Otherwise the greedy packer claims plates largest-footprint-first, joining an existing row
 *     if it fits, else opening a new plate.
 *
 * A part still overhanging its plate is reported via `warnings`, never assumed safe.
 * materials: index 0 = body/base, then one per color that actually ships.
 */
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

  // Rotated footprint from every body vertex, NOT from rotating the un-rotated bbox's 8 corners.
  // That shortcut is exact only at zero spin. Combine a real Z angle with the face-down tilt and
  // the ghost corners of a non-box shape (a thin curved crescent) land far outside where the mesh
  // reaches. Transforming all vertices is the only way to get the true rotated AABB.
  function footprintFor(
    part: ExportPart,
    angleDeg: number,
  ): { R: number[][]; w: number; d: number; cx: number; cy: number; minZ: number } {
    const R = part.plateR ?? rotXthenZ(-90 * part.nsign, angleDeg);
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
    // Flush height must account for every sub-mesh, not just the body: a recess cuts into the
    // body's surface, so the inlay filling it can reach further along the tilt-affected axis than
    // the now-holed body does. Body-only minZ left the inlay floating below Z=0 in the export.
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
  // Parts known not to fit at any position, so the off-plate check below stays quiet about them
  // rather than saying the same thing twice in different words.
  const tooBig = new Set<ExportPart>();
  for (const pl of placed) {
    const worst = Math.max(pl.w - plateW, pl.d - plateD);
    if (worst > 0.5) {
      tooBig.add(pl.part);
      warnings.push(
        `"${pl.part.name}" overhangs the ${plateW}×${plateD}mm plate by ~${Math.ceil(worst)}mm even at its best-fit rotation.`,
      );
    }
  }

  // The X1C plate is exactly what fixedPos was authored against, so leave those verbatim there:
  // it is the real tested layout. Any other plate re-centers each fixedPos group (plate 1's Top +
  // Cap, each plate 2+ rotated-duplicate Top alone) on its own bounding box (see placeHintedGroup).
  const isRefPlate = plateW === ASSEMBLY_REF_PLATE.w && plateD === ASSEMBLY_REF_PLATE.d;
  /** Lookup key for ExportPart.primeTowerDeltaByPlate. */
  const bedKey = `${plateW}x${plateD}`;

  // A plateHint pins a part to that plate instead of the greedy packer, used by the wheel assembly
  // (top half + cap on plate 1, each rotated-duplicate half on its own; see exportPanel.ts).
  // Placement within the plate comes from fixedPos when set (the normal case, see
  // WHEEL_TOP_POS/WHEEL_CAP_POS), else plate center.
  /** A position authored for exactly this bed, if the part carries one. */
  const bedPos = (part: ExportPart): { x: number; y: number } | undefined =>
    part.fixedPosByPlate?.[bedKey];

  function placeHintedGroup(items: Placed[]): void {
    let groupOffsetX = 0,
      groupOffsetY = 0;
    if (!isRefPlate) {
      // True world bounding box of this plate's fixedPos group (Top + Cap together), from each
      // item's own rotated footprint (cx/w/d, cy) plus its raw fixedPos. Never a symmetric
      // assumption about where the group sits on the reference plate.
      let gMinX = Infinity,
        gMaxX = -Infinity,
        gMinY = Infinity,
        gMaxY = -Infinity;
      items.forEach((pl) => {
        // a per-bed position is already right for this plate, so it must not drag the group offset
        if (bedPos(pl.part)) return;
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
    // Centering is a single-part fallback: two parts taking it on one plate resolve to the same
    // spot and print through each other. Nothing ships that way today, but it would fail silently,
    // so say so rather than letting it reach a slicer.
    const centered = items.filter((pl) => !pl.part.fixedPos && !bedPos(pl.part));
    if (centered.length > 1)
      warnings.push(
        `${centered.map((pl) => `"${pl.part.name}"`).join(', ')} share a build plate with no ` +
          `verified position between them, so they are stacked on the plate center. ` +
          `double-check for overlap in your slicer.`,
      );
    items.forEach((pl) => {
      const bed = bedPos(pl.part);
      const pos = pl.part.fixedPos;
      // verbatim for a bed-specific position, offset for a reference-plate one, else centered
      pl.tx = bed ? bed.x : pos ? pos.x + groupOffsetX : plateW / 2 - pl.cx;
      pl.ty = bed ? bed.y : pos ? pos.y + groupOffsetY : plateD / 2 - pl.cy;
      pl.tz = -pl.minZ;
    });
  }

  /** A plate prints a prime tower only when its parts between them use more than one filament. */
  const platePrintsTower = (row: Placed[]): boolean =>
    new Set(row.flatMap((pl) => pl.part.subs.map((s) => s.matIndex))).size > 1;

  /** Plates whose best tower corner still overlaps a part, held until the write decision is made. */
  const blockedTowers: Array<{
    names: string;
    plate: string;
    at: { x: number; y: number };
  }> = [];

  /**
   * Where to park the prime tower on a plate whose parts carry no verified `primeTowerDelta`.
   * Deliberately NOT a baked position: it is a starting point for the human pass that produces
   * one, and only has to beat dropping the tower on the plate center, straight through the part.
   * Insets the tower's nominal footprint into whichever corner the parts intrude on least.
   */
  function suggestTowerPos(items: Placed[]): { x: number; y: number; clear: boolean } {
    const TOWER = 60; // nominal prime-tower footprint; the slicer sizes the real one per filament count
    // `wipe_tower_x/y` is the tower's FRONT-LEFT CORNER, not its centre (settled against two
    // hand-positioned references, see HUBCAP_PLATE). Every position here is therefore a corner and
    // its footprint runs from it, not around it. Scoring a centred box and returning its centre
    // put the tower half a tower up and right of the space checked as free: on a 256mm plate the
    // near corner became 30..90, into a part just centred there, and the far corner 226..286, off
    // the plate.
    //
    // Score whole corners, not each axis alone: "most room to the left" and "most room to the
    // front" can meet inside the very part they measured around. Score against each part's own
    // footprint, not the group bounding box, since two parts with a gap between them (the caster
    // plate) leave corners free that their combined box calls occupied.
    const overlap = (c: { x: number; y: number }) =>
      items.reduce((sum, pl) => {
        const ox =
          Math.min(pl.tx! + pl.cx + pl.w / 2, c.x + TOWER) -
          Math.max(pl.tx! + pl.cx - pl.w / 2, c.x);
        const oy =
          Math.min(pl.ty! + pl.cy + pl.d / 2, c.y + TOWER) -
          Math.max(pl.ty! + pl.cy - pl.d / 2, c.y);
        return sum + Math.max(0, ox) * Math.max(0, oy);
      }, 0);
    // Inset from the plate edge, and try front-left LAST. A tower at (0, 0) is a position no plate
    // can honour: the front-left of a Bambu bed carries the nozzle-wipe exclusion (roughly
    // 18x28mm). Ordering matters more than the inset, since `reduce` keeps the earlier candidate
    // on a tie, so front-left wins only when strictly freer than all three alternatives.
    //
    // 20mm, not more, because the margin is not free. Measured against a disc centred on each bed:
    // on the 256 and 270 plates every corner is blocked even flush, so the inset costs nothing; on
    // the 350x320 it is the difference between suggesting the free back corner and suggesting
    // nothing at all.
    const EDGE = 20;
    const far = (span: number) => Math.max(EDGE, span - TOWER - EDGE);
    const corners = [
      { x: far(plateW), y: far(plateD) }, // back-right
      { x: EDGE, y: far(plateD) }, // back-left
      { x: far(plateW), y: EDGE }, // front-right
      { x: EDGE, y: EDGE }, // front-left, the excluded one, last resort
    ];
    const best = corners.reduce((a, b) => (overlap(b) < overlap(a) ? b : a));
    // A starting point for the human pass, not a promise of clearance: the slicer sizes the real
    // tower per filament count so TOWER is nominal, and a part's footprint here is its bounding
    // box, which over-reports a round part. A crowded plate gets a warning rather than a position
    // that quietly prints through a part. A one-filament plate (the caster plate, no artwork)
    // prints no tower, so whatever this returns for it is never used.
    const needsTower = platePrintsTower(items);
    const clear = overlap(best) === 0;
    // Recorded, not announced. What to tell the user depends on whether the file ends up carrying
    // this position, and that is decided once for the whole export by the `towerBlocked` gate at
    // the bottom of this function: a lone blocked plate still gets its corner written, while a
    // run where every plate is blocked writes no wipe_tower_x/y at all. Said from here, the
    // message was wrong for one case or the other whichever way it was worded.
    if (needsTower && !clear)
      blockedTowers.push({
        names: items.map((pl) => `"${pl.part.name}"`).join(', '),
        plate: `${plateW}×${plateD}mm`,
        at: best,
      });
    return { ...best, clear };
  }

  const useHints = placed.some((pl) => pl.part.plateHint != null);
  const plates: {
    row: Placed[];
    wipeTower?: { x: number; y: number };
    /** true when the position is only the least-bad corner, all of which a part overlaps */
    towerBlocked?: boolean;
    /** Whether this plate prints a prime tower at all: a single-filament plate never does. */
    towerNeeded?: boolean;
  }[] = [];
  if (useHints) {
    groupByPlateHint(placed, (pl) => pl.part.plateHint).forEach((row) => plates.push({ row }));
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
      // Tower position is relative to this plate's anchor part's final local position (pre-stride,
      // which is what wipe_tower_x/y want). The anchor is whichever part carries a delta in either
      // form: matching on `primeTowerDelta` alone missed a part with only per-bed deltas, which
      // fell through to the suggested corner and discarded a human-verified position.
      const anchor = plate.row.find(
        (pl) => pl.part.primeTowerDelta || pl.part.primeTowerDeltaByPlate?.[bedKey],
      );
      const delta =
        anchor && (anchor.part.primeTowerDeltaByPlate?.[bedKey] ?? anchor.part.primeTowerDelta);
      plate.towerNeeded = platePrintsTower(plate.row);
      if (anchor && delta) {
        plate.wipeTower = { x: anchor.tx! + delta.x, y: anchor.ty! + delta.y };
      } else {
        const { clear, ...pos } = suggestTowerPos(plate.row);
        plate.wipeTower = pos;
        plate.towerBlocked = !clear;
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
      // Same free-corner search as the hinted branch. Without it this branch wrote no
      // wipe_tower_x/y, leaving the slicer on its preset default, which for a part just centered
      // on the plate is very likely through it. Reachable for any part with no plateHint.
      plate.towerNeeded = platePrintsTower(plate.row);
      const { clear, ...pos } = suggestTowerPos(plate.row);
      plate.wipeTower = pos;
      plate.towerBlocked = !clear;
    });
  }
  // Fitting on the plate and being *put* on it are different claims: the size check above only
  // rules out parts too big for any position, while a baked fixedPos lands where a reference file
  // said, on a plate that may not be the one it was authored against. Positions are still
  // plate-local here, the frame the plate's own 0..plateW/D bounds are in.
  plates.forEach((plate, pi) => {
    plate.row.forEach((pl) => {
      if (tooBig.has(pl.part)) return;
      const over = Math.max(
        -(pl.tx! + pl.cx - pl.w / 2),
        pl.tx! + pl.cx + pl.w / 2 - plateW,
        -(pl.ty! + pl.cy - pl.d / 2),
        pl.ty! + pl.cy + pl.d / 2 - plateD,
      );
      if (over > 0.5)
        warnings.push(
          `"${pl.part.name}" is placed ~${Math.ceil(over)}mm past the edge of ` +
            `${plates.length > 1 ? `plate ${pi + 1}` : 'the plate'} on this ` +
            `${plateW}×${plateD}mm bed. Reposition it in your slicer before printing.`,
        );
    });
  });

  // Build item transforms are world coordinates, and the slicer reads an object's logical plate
  // from where it lands in that world. Plates tile a grid (see plateColumns) with a gap of 1/5
  // plate size per axis (LOGICAL_PART_PLATE_GAP), filling left-to-right then downward: +X across,
  // -Y down. A row-only layout is right up to two plates, then silently puts plate 3 on empty
  // space beyond the grid's last column.
  const cols = plateColumns(plates.length);
  plates.forEach((plate, pi) => {
    const offsetX = (pi % cols) * plateW * 1.2;
    const offsetY = -Math.floor(pi / cols) * plateD * 1.2;
    plate.row.forEach((pl) => {
      pl.tx = (pl.tx ?? 0) + offsetX;
      pl.ty = (pl.ty ?? 0) + offsetY;
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
      .map((v) => {
        if (!Number.isFinite(v))
          throw new Error(
            `Part "${pl.part.name}" has a non-finite plate transform, refusing to write a malformed 3MF.`,
          );
        return +v.toFixed(6);
      })
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

  // model_settings.config: where Bambu Studio reads object/part names, per-part extruder
  // assignment, and plate membership from.
  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  for (const pl of placed) {
    cfg.push(`  <object id="${pl.cid}">`);
    cfg.push(`    <metadata key="name" value="${xmlEscape(pl.part.name)}"/>`);
    cfg.push(`    <metadata key="extruder" value="1"/>`);
    // Per-part print overrides (support off on the footrest, a brim on the chair's handles):
    // object-level metadata Bambu applies on top of the global project settings.
    for (const [key, value] of Object.entries(pl.part.objectSettings ?? {}))
      cfg.push(`    <metadata key="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`);
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
    // Plate name: the distinct part names on it ("Top + Cap"), not a blank. Bambu Studio and
    // OrcaSlicer show this in the plate list/preview UI.
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

  // Whether the export carries tower positions at all, decided once here for the whole file.
  //
  // Write nothing when NO plate has a position worth asserting: a blocked plate's best corner is
  // still overlapped, and pinning it would state a placement the exporter has just measured as
  // colliding. Omitting the key lets the slicer apply its own printer-aware default. Only when
  // *every* plate is blocked, since these keys are per-plate arrays with no way to say "no
  // opinion" for one entry.
  // Counted over the plates that actually print a tower. A single-filament plate has no opinion,
  // and letting it vote turned the gate off: a 240mm two-material disc beside a plate of
  // single-filament clips wrote wipe_tower_x for BOTH, pinning the disc plate's tower at a corner
  // the exporter had just measured as overlapping it — the exact thing this gate exists to refuse.
  const towerPlates = plates.filter((p) => p.towerNeeded);
  const allBlocked = towerPlates.length > 0 && towerPlates.every((p) => p.towerBlocked);
  const towerPositions = allBlocked ? undefined : plates.map((p) => p.wipeTower);
  // Said here rather than where the overlap is measured, because the right thing to say depends on
  // the decision above. A lone blocked plate still gets its corner written, so the user can move
  // it; when nothing was written there is no position to move and the slicer decides.
  blockedTowers.forEach(({ names, plate, at }) =>
    warnings.push(
      `The prime tower on the plate holding ${names} has no verified position, and every corner ` +
        `of the ${plate} plate overlaps a part. ` +
        (allBlocked
          ? 'No tower position was saved, so your slicer will place it. Check it before printing.'
          : // Named, because this arm fires precisely when a position WAS written. Telling someone
            // to move a tower without saying where it is leaves them hunting for it under a part,
            // which is what dropping the coordinates from both arms did.
            `It was put at (${at.x.toFixed(0)}, ${at.y.toFixed(0)}), so move the tower in your slicer.`),
    ),
  );

  files.push({
    name: 'Metadata/project_settings.config',
    data: enc.encode(
      // Both branches work out a tower position now, so this is no longer gated on useHints.
      // While it was, an unhinted plate wrote no wipe_tower_x/y and the slicer fell back to its
      // preset default, which is not this file's plate-centre fallback and is nowhere near a part
      // just centered on the plate.
      bambuProjectSettings(
        materials,
        printer,
        towerPositions,
        // Project settings are global to the file, so baked overrides merge rather than stay per
        // plate. Nothing ships two parts setting the same key differently, and one that did would
        // be a plate-level claim that can't be honored anyway.
        parts.reduce<Record<string, string>>((acc, p) => Object.assign(acc, p.projectSettings), {}),
      ),
    ),
  });
  return { blob: zipStore(files), warnings };
}
