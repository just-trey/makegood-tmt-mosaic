import { cross, dot, normalize } from '../geometry/frame';
import type { CutPiece } from '../geometry/inlay';
import { boxSize, composeAffine, flatPatches, meshBounds, rotationZ, transformMesh, translation, type Affine, type Mesh, type Vec3 } from '../geometry/mesh';
import type { Printer } from './printers';

export interface PlatedPiece {
  piece: CutPiece;
  /** Meshes already posed: lying on z=0, bbox min at the origin. */
  body: Mesh;
  inlays: { slot: number; color: string; mesh: Mesh }[];
  plate: number;
  /** Where the posed object's bbox min goes on its plate, mm. */
  x: number;
  y: number;
  sizeMm: Vec3;
  verified: boolean;
}

export interface Plate {
  index: number;
  pieces: PlatedPiece[];
  /** Prime tower position in plate mm, or null when no corner is free. */
  tower: { x: number; y: number } | null;
  towerCrowded: boolean;
}

export interface Layout {
  plates: Plate[];
  warnings: string[];
}

export const PART_GAP_MM = 8;
export const BED_MARGIN_MM = 3;
export const TOWER_MM = 35;

/** Rotation taking unit vector `from` onto unit vector `to`. */
export function rotationBetween(from: Vec3, to: Vec3): Affine {
  const f = normalize(from), t = normalize(to);
  const c = dot(f, t);
  if (c > 0.999999) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  let axis = cross(f, t);
  if (c < -0.999999) {
    // Opposite: any axis perpendicular to f.
    axis = Math.abs(f[0]) < 0.9 ? cross(f, [1, 0, 0]) : cross(f, [0, 1, 0]);
  }
  const [x, y, z] = normalize(axis);
  const s = Math.sqrt(Math.max(0, 1 - c * c));
  const cc = c < -0.999999 ? -1 : c;
  const ss = c < -0.999999 ? 0 : s;
  const C = 1 - cc;
  return [
    cc + x * x * C, x * y * C - z * ss, x * z * C + y * ss, 0,
    y * x * C + z * ss, cc + y * y * C, y * z * C - x * ss, 0,
    z * x * C - y * ss, z * y * C + x * ss, cc + z * z * C, 0,
  ];
}

/**
 * Pose a cut piece for printing. With no human-verified pose for the part, the design surface
 * goes face down: the recess floor and its inlay share the first layer, which is the flattest,
 * best-looking surface a printer makes, and the pockets need no support. The design surface is
 * taken as the largest flat patch of the uncut body.
 */
export function posePiece(piece: CutPiece, downNormal: Vec3): { body: Mesh; inlays: PlatedPiece['inlays']; size: Vec3 } {
  const rot = rotationBetween(downNormal, [0, 0, -1]);
  const rotated = transformMesh(piece.body, rot);
  const b = meshBounds(rotated);
  const shift = translation([-b.min[0], -b.min[1], -b.min[2]]);
  const pose = composeAffine(shift, rot);
  return {
    body: transformMesh(piece.body, pose),
    inlays: piece.inlays.map((i) => ({ slot: i.slot, color: i.color, mesh: transformMesh(i.mesh, pose) })),
    size: boxSize(b),
  };
}

/**
 * Pose a piece for printing. With no human-verified pose, the design surface goes face down:
 * the recess floor and its inlay share the first layer, the flattest surface a printer makes,
 * and the pockets need no support. A piece with no design surface, or one whose face-down pose
 * does not fit the bed, tries its largest flat patches down, each with a turn on the plate.
 */
export function poseToFit(piece: CutPiece, preferred: Vec3 | undefined, usableW: number, usableD: number, bedH: number): { body: Mesh; inlays: PlatedPiece['inlays']; size: Vec3; fits: boolean } {
  const candidates: Vec3[] = [];
  if (preferred) candidates.push(preferred);
  for (const p of flatPatches(piece.body, 3, 0.4, 50).slice(0, 6)) candidates.push(p.normal);
  if (candidates.length === 0) candidates.push([0, 0, -1]);
  let first: ReturnType<typeof posePiece> | null = null;
  for (const n of candidates) {
    const posed = posePiece(piece, n);
    first ??= posed;
    if (posed.size[2] > bedH) continue;
    if (posed.size[0] <= usableW && posed.size[1] <= usableD) return { ...posed, fits: true };
    const turned = turnToFit(posed, usableW, usableD);
    if (turned) return { ...turned, fits: true };
  }
  return { ...first!, fits: false };
}

/** Shelf-pack posed pieces onto as many plates as the bed needs, tallest row first. */
export function layoutPlates(pieces: CutPiece[], printer: Printer, downNormals: Map<string, Vec3>): Layout {
  const warnings: string[] = [];
  const usableW = printer.bedW - 2 * BED_MARGIN_MM;
  const usableD = printer.bedD - 2 * BED_MARGIN_MM;
  const posed = pieces.map((p) => {
    const r = poseToFit(p, downNormals.get(p.id), usableW, usableD, printer.bedH);
    return { piece: p, ...r, verified: false };
  });
  for (const p of posed) {
    if (p.size[0] > usableW || p.size[1] > usableD)
      warnings.push(`${p.piece.name} is ${fmt(p.size[0])} × ${fmt(p.size[1])} mm, more than the ${printer.bedW} × ${printer.bedD} mm bed. It's placed anyway; it won't print on this printer without turning it in your slicer.`);
    if (p.size[2] > printer.bedH) warnings.push(`${p.piece.name} is ${fmt(p.size[2])} mm tall, more than this printer's ${printer.bedH} mm.`);
  }
  posed.sort((a, b) => b.size[1] - a.size[1] || b.size[0] - a.size[0]);
  const plates: Plate[] = [];
  let cur: Plate | null = null;
  let shelfY = 0, shelfH = 0, cursorX = 0;
  const newPlate = () => {
    cur = { index: plates.length + 1, pieces: [], tower: null, towerCrowded: false };
    plates.push(cur);
    shelfY = BED_MARGIN_MM;
    shelfH = 0;
    cursorX = BED_MARGIN_MM;
  };
  for (const p of posed) {
    const w = p.size[0], d = p.size[1];
    if (!cur) newPlate();
    if (cursorX + w > printer.bedW - BED_MARGIN_MM && cursorX > BED_MARGIN_MM) {
      shelfY += shelfH + PART_GAP_MM;
      shelfH = 0;
      cursorX = BED_MARGIN_MM;
    }
    if (shelfY + d > printer.bedD - BED_MARGIN_MM && cur!.pieces.length > 0) newPlate();
    cur!.pieces.push({ piece: p.piece, body: p.body, inlays: p.inlays, plate: cur!.index, x: cursorX, y: shelfY, sizeMm: p.size, verified: false });
    cursorX += w + PART_GAP_MM;
    shelfH = Math.max(shelfH, d);
  }
  for (const plate of plates) {
    const t = towerCorner(plate, printer);
    plate.tower = t.pos;
    plate.towerCrowded = t.crowded;
    if (t.crowded) warnings.push(`Plate ${plate.index} has no clear corner for the prime tower. It's placed at its least crowded corner; move it in your slicer before printing.`);
  }
  return { plates, warnings };
}

function turnToFit(p: { body: Mesh; inlays: PlatedPiece['inlays']; size: Vec3 }, usableW: number, usableD: number): { body: Mesh; inlays: PlatedPiece['inlays']; size: Vec3 } | null {
  for (let deg = 5; deg <= 90; deg += 5) {
    const rot = rotationZ(deg);
    const body = transformMesh(p.body, rot);
    const b = meshBounds(body);
    const size = boxSize(b);
    if (size[0] > usableW || size[1] > usableD) continue;
    const pose = composeAffine(translation([-b.min[0], -b.min[1], -b.min[2]]), rot);
    return { body: transformMesh(p.body, pose), inlays: p.inlays.map((i) => ({ ...i, mesh: transformMesh(i.mesh, pose) })), size };
  }
  return null;
}

function towerCorner(plate: Plate, printer: Printer): { pos: { x: number; y: number } | null; crowded: boolean } {
  const m = BED_MARGIN_MM;
  const corners = [
    { x: printer.bedW - m - TOWER_MM, y: printer.bedD - m - TOWER_MM },
    { x: m, y: printer.bedD - m - TOWER_MM },
    { x: printer.bedW - m - TOWER_MM, y: m },
    { x: m, y: m },
  ];
  // Count part vertices inside each tower square plus gap. A turned wheel fills its bounding
  // box's corners with nothing, so a box test would call every corner crowded.
  let best: { x: number; y: number } | null = null;
  let bestHits = Infinity;
  for (const c of corners) {
    const x0 = c.x - PART_GAP_MM, x1 = c.x + TOWER_MM + PART_GAP_MM;
    const y0 = c.y - PART_GAP_MM, y1 = c.y + TOWER_MM + PART_GAP_MM;
    let hits = 0;
    for (const p of plate.pieces) {
      if (p.x > x1 || p.x + p.sizeMm[0] < x0 || p.y > y1 || p.y + p.sizeMm[1] < y0) continue;
      const pos = p.body.pos;
      for (let i = 0; i < pos.length && hits < 1000; i += 3) {
        const x = pos[i] + p.x, y = pos[i + 1] + p.y;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) hits++;
      }
    }
    if (hits < bestHits) {
      bestHits = hits;
      best = c;
    }
    if (hits === 0) break;
  }
  return { pos: best, crowded: bestHits > 0 };
}

function fmt(v: number): string {
  return Math.round(v).toString();
}
