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
  /** Unindexed soup; welded on the fly when `indexed` is absent (fallback parts). */
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
  /** Baked 3x3 plate rotation (row-major, p' = p * R), verbatim from the reference 3MF build item,
   * for a pose that isn't design-face-down (FOOTREST_PLATE_R). Overrides rotZdeg/nsign. */
  plateR?: number[][];
  /** 1-based plate pin: parts sharing a hint share a plate (stride offset only; XY comes from
   * fixedPos below). */
  plateHint?: number;
  /** Absolute local (pre-stride) plate position, bypassing footprint packing. For a placement that
   * is an externally-verified constant, not something to compute (see WHEEL_TOP_POS/WHEEL_CAP_POS). */
  fixedPos?: { x: number; y: number };
  /** Bed-specific positions, keyed `"<w>x<d>"` in mm; a key means that bed was verified. Beats
   * `fixedPos` and is taken VERBATIM, skipping `placeHintedGroup`'s re-centering (which rescues a
   * coordinate authored for another bed). */
  fixedPosByPlate?: Record<string, { x: number; y: number }>;
  /** Prime tower offset from this part's final local position, on the part anchoring its plate's
   * tower. Relative, so it rides along on every printer (WHEEL_/FOOTREST_PRIME_TOWER_DELTA). */
  primeTowerDelta?: { x: number; y: number };
  /** Bed-specific `primeTowerDelta`, keyed `"<w>x<d>"`: that bed was verified and disagreed
   * (room on a 270mm plate can hit the edge once a 256mm plate re-centers the group). */
  primeTowerDeltaByPlate?: Record<string, { x: number; y: number }>;
  /** Per-object Bambu overrides for model_settings.config, baked from the part's reference 3MF
   * (FOOTREST_OBJECT_SETTINGS; the chair's handles ask for a brim). */
  objectSettings?: Record<string, string>;
  /** File-global settings this part's verified plate depends on (`prime_tower_width`: the hubcap's
   * clearance holds only at the verified width), merged into project_settings.config. */
  projectSettings?: Record<string, string>;
  /** Beds (`"<w>x<d>"`) a human checked this baked layout on in a slicer; any other bed gets a note.
   * Absent on a part with no baked layout, which says so through its own placement notice. */
  verifiedBeds?: readonly string[];
}
export interface ExportOptions {
  rotZdeg?: number;
  printer: Printer;
}

/**
 * Soup to indexed mesh, for fallback parts only (Manifold meshes arrive indexed). The key rounds to
 * 4 decimals (0.1 micron) by integer scaling: Math.round is markedly cheaper than toFixed(4).
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
 * Group parts onto plates by `plateHint`, ascending; anything unhinted opens its own plate.
 * Shared with src/ui/exportPanel.ts so the plate count it states before export can't drift.
 * Hinted branch only: greedy packing needs real footprints, so check `partsCarryPlateHints` first.
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
 * Bambu's PartPlateList::compute_colum_count, `ceil(sqrt(n))`: plates form a square-ish grid, not
 * a row (4 plates 2x2, 12 plates 4x3, confirmed against real MakeGood project files).
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
 * Minimal Metadata/project_settings.config: Bambu ignores core-spec 3MF basematerials, so this is
 * what imports the palette as filament colors. Bambu, Snapmaker Orca and OrcaSlicer share the shape
 * and fill unwritten keys from the named system presets.
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
  // Bambu-family slicers (confirmed against a real Snapmaker Orca export) read
  // `different_settings_to_system` to tell a deliberate override from a resolved value; without it,
  // a resave silently reconciles them back to the preset.
  const printOverrideKeys = [
    'brim_type',
    'sparse_infill_density',
    'sparse_infill_pattern',
    'enable_support',
    'support_type',
    // Baked settings too: reconciling prime_tower_width would retire the verified clearance.
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
      // No brim: mosaic faces are broad and print flat. Global, so every plate is brim-free, as in
      // mosaic-wheel-mount-left.3mf (brim_type=no_brim, tracked in different_settings_to_system).
      brim_type: 'no_brim',
      // [print, one per filament, printer]: only the print slot (index 0) differs from system.
      different_settings_to_system: [printOverrideKeys.join(';'), ...rep(''), ''],
      // Per plate: a part's verified primeTowerDelta, else suggestTowerPos. Deliberately not in
      // different_settings_to_system, matching the reference files.
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

// Wheel Top and Cap: fixed rotation + position, never computed. Build-item transforms of
// stubs/whlle-reference.3mf (the shipped MakeGood TMT project), corrected for Bambu's import
// recentering (model_settings.config source_offset_y/z). Top's -45° is the mirror of what an angle
// search lands on; Cap is valid only relative to this Top, so apply both together and never
// re-derive per printer. Verified on all three registered plates.
export const WHEEL_TOP_ROT_DEG = -45;
export const WHEEL_TOP_POS = { x: 104.106567, y: 104.933839 };
export const WHEEL_CAP_ROT_DEG = 0;
// Cap relative to Top, from stubs/mosaic-wheel-snapmaker.3mf (our export hand-repositioned in
// Snapmaker Orca; a vendor reopen, so no recentering correction). Rides with Top when re-centered.
export const WHEEL_CAP_POS = { x: 87.861827, y: 50.328835 };
// Tower hand-dragged on plate 1 of stubs/mosaic-wheel-snapmaker.3mf. An offset from Top's final
// local position (Top's primeTowerDelta), so it reproduces on every printer and plate.
export const WHEEL_PRIME_TOWER_DELTA = { x: -87.833131, y: -28.867078 };
// The bed fixedPos was authored on (Bambu X1C); only `isRefPlate` reads it. Other beds re-center
// each fixedPos group on its own bounding box, never a fixed offset from this: the reference is
// off-center by a few mm, fine on the H2D, visibly off on the Snapmaker U1 (14mm more per axis).
const ASSEMBLY_REF_PLATE = { w: 256, d: 256 };

// Footrest pose from its reference Bambu project: a pure Rz(-45°) standing it on its long edge to
// print support-free, via plateR since it isn't a face-down tilt. NO fixedPos: the reference
// translation (135.329137, 135.329137) is just the U1's 270x270 bed center, so it centers on any
// plate. Z lift is -minZ.
//
// Equivalent to rotXthenZ(-90 * nsign, angleDeg) at nsign 0, rotZdeg -45; a full 3x3 so a future
// genuinely tilted reference pose fits. Collapse into rotZdeg if none materializes.
export const FOOTREST_PLATE_R = [
  [0.707106781, -0.707106781, 0],
  [0.707106781, 0.707106781, 0],
  [0, 0, 1],
];
// stubs/footrest reference tower.3mf: tower (165.138, 177.187) minus footrest at the U1 center
// (135.329137, 135.329137). Relative, so it lands in the corner the 45° part leaves open.
export const FOOTREST_PRIME_TOWER_DELTA = { x: 29.808863, y: 41.857863 };
/**
 * Footrest per-object overrides from the same reference: support off, as the 45° pose needs none.
 * Brim is off globally (`brim_type`). Exported so tests/threemf.test.ts uses this value, not a
 * hand-copied duplicate that keeps passing after this one changes.
 */
export const FOOTREST_OBJECT_SETTINGS: Record<string, string> = { enable_support: '0' };

/**
 * Hubcap placement from two slicer-verified references (2026-08-06), both at the 220mm default:
 * stubs/mosaic-hubcap.3mf (X1C, 256x256) and stubs/mosaic-hubcap-snap.3mf (U1, 270x270).
 *
 * - **Disc and tower only work together**, hence one table. Centred, a 220mm disc leaves no tower
 *   corner, so the disc moved up-right and the tower took the freed corner. Rim-to-tower clearance:
 *   7.0mm X1C, 18.9mm U1.
 * - Plate-origin-relative: Snapmaker Orca saves `printable_area` from (0.5, 1), so converted.
 * - `wipe_tower_x/y` is the FRONT-LEFT CORNER, settled by these files: as a centre, the X1C's 35mm
 *   tower hangs off at x = -0.7 and clears the disc by 31.6mm, not the 7.0mm placed by eye.
 * - `prime_tower_width` is written because the clearance holds only at that width. 35 and 30 are
 *   each slicer's default, not a reference override (both files' different_settings_to_system is
 *   `brim_type;enable_support;sparse_infill_pattern`).
 * - **Valid only up to the verified diameter**, enforced in hubcapPlacement() (geometry/hubcap.ts).
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
 * Footprint axes for the prime-tower corner search: 16 axes, 32 half-planes, wrapping the CONVEX
 * HULL to 1/cos(180°/32), 0.48% (0.5mm of radius on a 220mm hubcap). A concave part over-reports by
 * its concavity: `chair-caster-std-left` in its baked pose measures 1.70x (docs/tech-debt.md).
 * Always a superset of the BODY SOUP; an inlay filling an edge cut-through can reach a hair past.
 *
 * Quarter-turn rotation, not `Math.cos(k * Math.PI / 16)` (6.1e-17, not 0, at a right angle), so a
 * part that FILLS its bounding box measures exactly that box, not 1e-14mm² off it, by geometry
 * rather than by TIE_MM2.
 */
const FOOTPRINT_AXIS: { x: number; y: number }[] = [];
for (let k = 0; k < 8; k++) {
  const a = (Math.PI * k) / 16;
  FOOTPRINT_AXIS.push({ x: Math.cos(a), y: Math.sin(a) });
}
for (let k = 0; k < 8; k++)
  FOOTPRINT_AXIS.push({ x: -FOOTPRINT_AXIS[k].y, y: FOOTPRINT_AXIS[k].x });

/** Sutherland-Hodgman: the part of `poly` on the `sign` side of `p·d = limit`. */
function clipToHalfPlane(
  poly: { x: number; y: number }[],
  d: { x: number; y: number },
  limit: number,
  sign: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    const fp = sign * (p.x * d.x + p.y * d.y - limit);
    const fq = sign * (q.x * d.x + q.y * d.y - limit);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    }
  }
  return out;
}

/** Absolute shoelace area, so winding doesn't decide the sign. */
function polygonArea(poly: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return Math.abs(a) / 2;
}

/** A part's rotation, footprint and translation on the plate grid. */
export interface PlacedPart {
  part: ExportPart;
  R: number[][];
  w: number;
  d: number;
  cx: number;
  cy: number;
  minZ: number;
  /** Support distances along FOOTPRINT_AXIS, in the same rotated frame as cx/cy/w/d. */
  supportMin: number[];
  supportMax: number[];
  tx?: number;
  ty?: number;
  tz?: number;
}

/** Everything the 3MF says about where things go, and every note about it, before any XML. */
export interface PlateLayout {
  /** Input order; translations include the plate-grid stride. */
  placed: PlacedPart[];
  /** Plate order, each the parts on it. */
  plates: PlacedPart[][];
  /** Per-plate `wipe_tower_x/y`; undefined when every tower-printing plate is blocked. */
  towerPositions: Array<{ x: number; y: number } | undefined> | undefined;
  warnings: string[];
  /** Information, not warnings: a verified layout on a bed nobody checked it on. */
  notices: string[];
}

// From every body vertex, NOT the un-rotated bbox's 8 corners: exact only at zero spin; with a Z
// angle plus tilt, a non-box shape's (a thin crescent) ghost corners land far outside the mesh.
function footprintFor(part: ExportPart, R: number[][]): Footprint {
  const tmn = [Infinity, Infinity, Infinity],
    tmx = [-Infinity, -Infinity, -Infinity];
  const smn = FOOTPRINT_AXIS.map(() => Infinity),
    smx = FOOTPRINT_AXIS.map(() => -Infinity);
  // Scalars, not a per-vertex array: this runs over every body vertex after every rebuild, for the
  // notes stated before Export.
  const [r00, r01, r02] = R[0],
    [r10, r11, r12] = R[1],
    [r20, r21, r22] = R[2];
  const nAxes = FOOTPRINT_AXIS.length;
  const ax = Float64Array.from(FOOTPRINT_AXIS, (a) => a.x),
    ay = Float64Array.from(FOOTPRINT_AXIS, (a) => a.y);
  const sMin = new Float64Array(nAxes).fill(Infinity),
    sMax = new Float64Array(nAxes).fill(-Infinity);
  const soup = part.bodySoup;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i],
      y = soup[i + 1],
      z = soup[i + 2];
    const p0 = x * r00 + y * r10 + z * r20,
      p1 = x * r01 + y * r11 + z * r21,
      p2 = x * r02 + y * r12 + z * r22;
    if (p0 < tmn[0]) tmn[0] = p0;
    if (p0 > tmx[0]) tmx[0] = p0;
    if (p1 < tmn[1]) tmn[1] = p1;
    if (p1 > tmx[1]) tmx[1] = p1;
    if (p2 < tmn[2]) tmn[2] = p2;
    if (p2 > tmx[2]) tmx[2] = p2;
    for (let a = 0; a < nAxes; a++) {
      const t = p0 * ax[a] + p1 * ay[a];
      if (t < sMin[a]) sMin[a] = t;
      if (t > sMax[a]) sMax[a] = t;
    }
  }
  for (let a = 0; a < nAxes; a++) {
    smn[a] = sMin[a];
    smx[a] = sMax[a];
  }
  // Every sub-mesh, not just the body: an inlay filling a recess can reach lower than the holed
  // body. Body-only minZ left inlays floating below Z=0.
  let minZ = tmn[2];
  for (const sub of part.subs) {
    const verts: ArrayLike<number> | undefined = sub.indexed ? sub.indexed.positions : sub.soup;
    if (!verts) continue;
    for (let i = 0; i < verts.length; i += 3) {
      const x = verts[i],
        y = verts[i + 1],
        z = verts[i + 2];
      const pz = x * r02 + y * r12 + z * r22;
      if (pz < minZ) minZ = pz;
    }
  }
  return {
    w: tmx[0] - tmn[0],
    d: tmx[1] - tmn[1],
    cx: (tmn[0] + tmx[0]) / 2,
    cy: (tmn[1] + tmx[1]) / 2,
    minZ,
    supportMin: smn,
    supportMax: smx,
  };
}

type Footprint = Omit<PlacedPart, 'part' | 'R' | 'tx' | 'ty' | 'tz'>;

/**
 * Keyed by body soup: a footprint depends on the mesh and its pose, never the bed, so a printer
 * switch and the export re-use the one taken after the rebuild (~180ms on the chair,
 * scripts/bench-placement-notes.mjs). Sound because a build's arrays are never written once it
 * lands; a new build is new arrays.
 */
const footprints = new WeakMap<
  Float32Array,
  { R: number[][]; subs: (ArrayLike<number> | undefined)[]; fp: Footprint }
>();

function footprintOf(part: ExportPart, R: number[][]): Footprint {
  const subs = part.subs.map((s) => (s.indexed ? s.indexed.positions : s.soup));
  const hit = footprints.get(part.bodySoup);
  if (
    hit &&
    hit.R.every((row, i) => row.every((v, j) => v === R[i][j])) &&
    hit.subs.length === subs.length &&
    hit.subs.every((v, i) => v === subs[i])
  )
    return hit.fp;
  const fp = footprintFor(part, R);
  footprints.set(part.bodySoup, { R, subs, fp });
  return fp;
}

/**
 * One line for the whole export, never one per part (a chair is 13): parts whose baked layout
 * names the beds it was checked on, none of them this one.
 */
function uncheckedBedNotice(parts: ExportPart[], bedKey: string, w: number, d: number) {
  const n = parts.filter((p) => p.verifiedBeds && !p.verifiedBeds.includes(bedKey)).length;
  if (!n) return null;
  const which =
    n < parts.length
      ? `${n} of the ${parts.length} parts`
      : n === 1
        ? 'this part'
        : `all ${n} parts`;
  return (
    `The plate layout for ${which} hasn't been checked on a ${w} × ${d}mm bed. ` +
    `Check the parts and prime tower in your slicer before printing.`
  );
}

/**
 * Where every part and prime tower goes on `opts.printer`, and every placement note, without
 * writing anything: the panel states these before Export, from the same call the file is written from.
 *
 * Parts lay MOSAIC-FACE-DOWN (or `part.plateR`), spin, then place by precedence: `fixedPos` exactly
 * (externally-verified only: bbox math can't tell overlap from a concave part's open interior);
 * `plateHint` groups, unfixed ones centered; else greedy, largest footprint first.
 */
export function layoutPlates(parts: ExportPart[], opts: ExportOptions): PlateLayout {
  const rotZ = opts.rotZdeg || 0,
    gap = 8;
  const printer = opts.printer;
  const plateW = printer.plate.w;
  const plateD = printer.plate.d;
  type Placed = PlacedPart;

  const placed: Placed[] = parts.map((part) => {
    const R = part.plateR ?? rotXthenZ(-90 * part.nsign, part.rotZdeg ?? rotZ);
    return { part, R, ...footprintOf(part, R) };
  });

  const warnings: string[] = [];
  // Too big for any position: the off-plate check skips these rather than warn twice.
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

  // fixedPos stays verbatim on the X1C it was authored on; other plates re-center each fixedPos
  // group (plate 1's Top + Cap, each plate 2+ Top alone) on its own bounding box.
  const isRefPlate = plateW === ASSEMBLY_REF_PLATE.w && plateD === ASSEMBLY_REF_PLATE.d;
  /** Lookup key for ExportPart.primeTowerDeltaByPlate. */
  const bedKey = `${plateW}x${plateD}`;

  // plateHint pins a part to a plate (wheel: Top + Cap on plate 1, each rotated-duplicate half on
  // its own; see exportPanel.ts). Position within it: fixedPos, else plate center.
  /** A position authored for exactly this bed, if the part carries one. */
  const bedPos = (part: ExportPart): { x: number; y: number } | undefined =>
    part.fixedPosByPlate?.[bedKey];

  function placeHintedGroup(items: Placed[]): void {
    let groupOffsetX = 0,
      groupOffsetY = 0;
    if (!isRefPlate) {
      // This plate's fixedPos group's true bounds from each item's rotated footprint plus fixedPos,
      // never a symmetry assumption about the reference plate.
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
    // Centering is a single-part fallback: two centered parts print through each other. Nothing
    // ships that way, but warn rather than fail silently.
    const centered = items.filter((pl) => !pl.part.fixedPos && !bedPos(pl.part));
    if (centered.length > 1)
      warnings.push(
        `${centered.map((pl) => `"${pl.part.name}"`).join(', ')} share a build plate with no ` +
          `verified position between them. They are stacked on the plate center: ` +
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
   * Tower corner for a plate with no verified `primeTowerDelta`: a starting point for the human
   * pass, NOT a baked position. Only has to beat the plate center, straight through the part.
   */
  function suggestTowerPos(items: Placed[]): { x: number; y: number; clear: boolean } {
    const TOWER = 60; // nominal prime-tower footprint; the slicer sizes the real one per filament count
    // `wipe_tower_x/y` is the FRONT-LEFT CORNER (see HUBCAP_PLATE), so a footprint runs from it,
    // not around it: a centred box put a 256mm plate's near corner at 30..90 (into a centred part)
    // and the far one at 226..286 (off the plate).
    // Score whole corners against each part's own footprint: per-axis "most room" can meet inside a
    // part, and a group box calls the gap between two parts (the caster plate) occupied.
    // FOOTPRINT_AXIS polygon, not the bbox: the bbox read a 220mm hubcap centred on the 350x320 H2D
    // as blocking all four corners, which it clears by 14mm.
    const one = (pl: Placed, c: { x: number; y: number }): number => {
      // the square in the part's own rotated frame, where its support distances are measured
      const x0 = c.x - pl.tx!,
        y0 = c.y - pl.ty!;
      let poly = [
        { x: x0, y: y0 },
        { x: x0 + TOWER, y: y0 },
        { x: x0 + TOWER, y: y0 + TOWER },
        { x: x0, y: y0 + TOWER },
      ];
      for (let a = 0; a < FOOTPRINT_AXIS.length; a++) {
        poly = clipToHalfPlane(poly, FOOTPRINT_AXIS[a], pl.supportMax[a], 1);
        if (!poly.length) return 0;
        poly = clipToHalfPlane(poly, FOOTPRINT_AXIS[a], pl.supportMin[a], -1);
        if (!poly.length) return 0;
      }
      return polygonArea(poly);
    };
    const overlap = (c: { x: number; y: number }) => items.reduce((sum, pl) => sum + one(pl, c), 0);
    // Front-left LAST: it carries the Bambu nozzle-wipe exclusion (roughly 18x28mm), and `reduce`
    // keeps the earlier candidate on a tie, so front-left wins only when strictly freer. The 20mm
    // inset clears 18mm in X but not 28mm in Y, so ordering is what keeps the tower out.
    // The inset costs nothing: a 220mm disc centred on each bed, back-right corner (plate centre to
    // tower's nearest corner minus the 110mm radius), stays blocked on 256 and 270 even flush
    // (-13.8mm, -3.9mm) and clears on the 350x320 either way (+14.2mm inset, +42.4mm flush).
    const EDGE = 20;
    const far = (span: number) => Math.max(EDGE, span - TOWER - EDGE);
    const corners = [
      { x: far(plateW), y: far(plateD) }, // back-right
      { x: EDGE, y: far(plateD) }, // back-left
      { x: far(plateW), y: EDGE }, // front-right
      { x: EDGE, y: EDGE }, // front-left, the excluded one, last resort
    ];
    // Corners tie unless they differ by more than this (mm²): a centred disc overlaps all four
    // equally, but clipped shoelace areas aren't exactly equal. At 0, 62 of the 193 discs from 150
    // to 246mm at 0.5mm steps take another corner, front-left included ("keeps the corner order",
    // tests/generated-parts.test.ts). There the 99 ties sit within 2.3e-12mm² and the 94 real
    // differences at 0.157mm² or more; this splits them with ~10^5 to spare either way.
    const TIE_MM2 = 1e-6;
    const scored = corners.map((c) => ({ c, area: overlap(c) }));
    const best = scored.reduce((a, b) => (b.area < a.area - TIE_MM2 ? b : a));
    // Not a promise of clearance (TOWER is nominal, the footprint a superset), so a crowded plate
    // warns. A one-filament plate (the caster plate) prints no tower and never uses this.
    const needsTower = platePrintsTower(items);
    // Same tolerance as the ranking, or a sub-TIE_MM2 sliver winning a tie calls the plate blocked
    // beside a free corner. 1e-6mm² is a micron square.
    const clear = best.area <= TIE_MM2;
    // Recorded, not announced: the wording depends on the whole-export gate at the bottom (a lone
    // blocked plate gets its corner written; all blocked writes no wipe_tower_x/y).
    if (needsTower && !clear)
      blockedTowers.push({
        names: items.map((pl) => `"${pl.part.name}"`).join(', '),
        plate: `${plateW}×${plateD}mm`,
        at: best.c,
      });
    return { ...best.c, clear };
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
      // Relative to the anchor's final local (pre-stride) position, as wipe_tower_x/y want. Match a
      // delta in either form: `primeTowerDelta` alone discarded a part's verified per-bed delta.
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
      // Without this, the slicer's preset tower is very likely through a part centered here.
      plate.towerNeeded = platePrintsTower(plate.row);
      const { clear, ...pos } = suggestTowerPos(plate.row);
      plate.wipeTower = pos;
      plate.towerBlocked = !clear;
    });
  }
  // The size check only rules out parts too big anywhere; a baked fixedPos can still land off a bed
  // it wasn't authored for. Positions are still plate-local here.
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

  // The slicer reads an object's plate from its world position. Plates tile a grid (plateColumns)
  // with a 1/5-plate gap per axis (LOGICAL_PART_PLATE_GAP): +X across, then -Y down.
  const cols = plateColumns(plates.length);
  plates.forEach((plate, pi) => {
    const offsetX = (pi % cols) * plateW * 1.2;
    const offsetY = -Math.floor(pi / cols) * plateD * 1.2;
    plate.row.forEach((pl) => {
      pl.tx = (pl.tx ?? 0) + offsetX;
      pl.ty = (pl.ty ?? 0) + offsetY;
    });
  });

  // Tower positions, decided once for the file. Omitted only when EVERY tower-printing plate is
  // blocked: pinning an overlapped corner asserts a measured collision, so the slicer's default
  // wins, but the keys are per-plate arrays with no "no opinion" entry. Single-filament plates
  // don't vote: letting them pinned a 240mm two-material disc's tower onto the disc.
  const towerPlates = plates.filter((p) => p.towerNeeded);
  const allBlocked = towerPlates.length > 0 && towerPlates.every((p) => p.towerBlocked);
  const towerPositions = allBlocked ? undefined : plates.map((p) => p.wipeTower);
  // Said here because the wording depends on the decision above: a written corner can be moved,
  // an unwritten one is the slicer's call.
  blockedTowers.forEach(({ names, plate, at }) =>
    warnings.push(
      `The prime tower on the plate holding ${names} has no verified position. ` +
        `Every corner of the ${plate} plate overlaps a part. ` +
        (allBlocked
          ? 'No tower position was saved, so your slicer will place it. Check it before printing.'
          : // Named: this arm means a position WAS written, and without it they hunt under a part.
            `It was put at (${at.x.toFixed(0)}, ${at.y.toFixed(0)}), so move the tower in your slicer.`),
    ),
  );

  const unchecked = uncheckedBedNotice(parts, bedKey, plateW, plateD);
  return {
    placed,
    plates: plates.map((p) => p.row),
    towerPositions,
    warnings,
    notices: unchecked ? [unchecked] : [],
  };
}

/**
 * One print-ready Bambu Studio *project* 3MF. A core-spec 3MF triggers the "not from Bambu Lab"
 * dialog, drops colors, renames parts and piles everything on one plate, so this writes
 * 3D/3dmodel.model (with the BambuStudio:3mfVersion marker), model_settings.config and
 * project_settings.config, at the positions `layoutPlates` decides.
 * materials: index 0 = body/base, then each shipped color.
 */
export async function build3MFCombined(
  materials: ExportMaterial[],
  parts: ExportPart[],
  opts: ExportOptions,
): Promise<{ blob: Blob; warnings: string[]; notices: string[] }> {
  const { placed, plates, towerPositions, warnings, notices } = layoutPlates(parts, opts);
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

  const written = new Map<
    PlacedPart,
    { cid: number; subs: { id: number; name: string; matIndex: number }[]; xf: string }
  >();
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
    const xf = [
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
    written.set(pl, { cid, subs, xf });
    items.push(`  <item objectid="${cid}" transform="${xf}" printable="1"/>`);
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

  // model_settings.config: where Bambu reads part names, per-part extruder and plate membership.
  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  for (const pl of placed) {
    const w = written.get(pl)!;
    cfg.push(`  <object id="${w.cid}">`);
    cfg.push(`    <metadata key="name" value="${xmlEscape(pl.part.name)}"/>`);
    cfg.push(`    <metadata key="extruder" value="1"/>`);
    // Object-level overrides on top of the global project settings (footrest support, handle brim).
    for (const [key, value] of Object.entries(pl.part.objectSettings ?? {}))
      cfg.push(`    <metadata key="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`);
    for (const s of w.subs) {
      cfg.push(`    <part id="${s.id}" subtype="normal_part">`);
      cfg.push(`      <metadata key="name" value="${xmlEscape(s.name)}"/>`);
      cfg.push(`      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>`);
      cfg.push(`      <metadata key="extruder" value="${s.matIndex + 1}"/>`);
      cfg.push(`    </part>`);
    }
    cfg.push(`  </object>`);
  }
  let identifyId = 100;
  plates.forEach((row, pi) => {
    // Shown in Bambu/Orca's plate list, so the distinct part names ("Top + Cap"), not a blank.
    const plateName = [...new Set(row.map((pl) => pl.part.name))].join(' + ');
    cfg.push('  <plate>');
    cfg.push(`    <metadata key="plater_id" value="${pi + 1}"/>`);
    cfg.push(`    <metadata key="plater_name" value="${xmlEscape(plateName)}"/>`);
    cfg.push(`    <metadata key="locked" value="false"/>`);
    row.forEach((pl) => {
      cfg.push('    <model_instance>');
      cfg.push(`      <metadata key="object_id" value="${written.get(pl)!.cid}"/>`);
      cfg.push(`      <metadata key="instance_id" value="0"/>`);
      cfg.push(`      <metadata key="identify_id" value="${identifyId++}"/>`);
      cfg.push('    </model_instance>');
    });
    cfg.push('  </plate>');
  });
  cfg.push('  <assemble>');
  for (const pl of placed) {
    const { cid, xf } = written.get(pl)!;
    cfg.push(
      `   <assemble_item object_id="${cid}" instance_id="0" transform="${xf}" offset="0 0 0"/>`,
    );
  }
  cfg.push('  </assemble>');
  cfg.push('</config>');
  files.push({ name: 'Metadata/model_settings.config', data: enc.encode(cfg.join('\n')) });

  files.push({
    name: 'Metadata/project_settings.config',
    data: enc.encode(
      // Not gated on useHints: when it was, an unhinted plate fell back to the slicer's preset,
      // not this file's plate-centre fallback, and nowhere near a part just centered on the plate.
      bambuProjectSettings(
        materials,
        opts.printer,
        towerPositions,
        // File-global, so baked overrides merge; nothing ships two parts disagreeing on a key.
        parts.reduce<Record<string, string>>((acc, p) => Object.assign(acc, p.projectSettings), {}),
      ),
    ),
  });
  return { blob: zipStore(files), warnings, notices };
}
