import type { Vec3 } from '../geometry/mesh';

export type PartKind = 'wheel' | 'hubcap' | 'footrest' | 'chair';

export interface PieceDef {
  id: string;
  name: string;
  file: string;
  /** Present on pieces that differ between hardware variants. */
  variant?: string;
  /** No design surface reaches this piece, so it is exported uncut. */
  noDesign?: boolean;
}

export interface SurfaceDef {
  id: string;
  name: string;
  /** Viewing direction the design is projected along, in part space. */
  normal: Vec3;
  up?: Vec3;
  /** Pinned frame origin, for a surface whose piece is generated and so has no fixed centre. */
  origin?: Vec3;
  /** Pieces that take the design. Others are hidden or belong to another surface. */
  pieces: string[];
  /** A paired surface a mirrored copy can go on. */
  mirrorOf?: string;
}

export interface KindDef {
  kind: PartKind;
  name: string;
  pieces: PieceDef[];
  surfaces: SurfaceDef[];
  variants?: { id: string; name: string }[];
  /** Full-face fill is offered only where the design surface is one flat face. */
  fill: boolean;
}

const chairPieces: PieceDef[] = [
  { id: 'chair-handle-left', name: 'Handle (left)', file: 'chair-handle-left.3mf' },
  { id: 'chair-handle-right', name: 'Handle (right)', file: 'chair-handle-right.3mf' },
  { id: 'chair-storage-left', name: 'Storage (left)', file: 'chair-storage-left.3mf' },
  { id: 'chair-storage-right', name: 'Storage (right)', file: 'chair-storage-right.3mf' },
  { id: 'chair-wing-left', name: 'Fender (left)', file: 'chair-wing-left.3mf' },
  { id: 'chair-wing-right', name: 'Fender (right)', file: 'chair-wing-right.3mf' },
  { id: 'chair-wheel-mount-left', name: 'Wheel mount (left)', file: 'chair-wheel-mount-left.3mf' },
  { id: 'chair-wheel-mount-right', name: 'Wheel mount (right)', file: 'chair-wheel-mount-right.3mf' },
  { id: 'chair-seat-center', name: 'Seat center', file: 'chair-seat-center.3mf', noDesign: true },
  { id: 'chair-seat-back-bottom', name: 'Seat back (bottom)', file: 'chair-seat-back-bottom.3mf' },
  { id: 'chair-seat-back-top', name: 'Seat back (top)', file: 'chair-seat-back-top.3mf' },
  { id: 'chair-caster-std-left', name: 'Caster mount, Standard (left)', file: 'chair-caster-std-left.3mf', variant: 'standard', noDesign: true },
  { id: 'chair-caster-std-right', name: 'Caster mount, Standard (right)', file: 'chair-caster-std-right.3mf', variant: 'standard', noDesign: true },
  { id: 'chair-caster-kit-left', name: 'Caster mount, Kit (left)', file: 'chair-caster-kit-left.3mf', variant: 'kit', noDesign: true },
  { id: 'chair-caster-kit-right', name: 'Caster mount, Kit (right)', file: 'chair-caster-kit-right.3mf', variant: 'kit', noDesign: true },
];

// Chair frame, read off the meshes: +X is the chair's left, +Y up, +Z the front.
export const KINDS: KindDef[] = [
  {
    kind: 'wheel',
    name: 'Wheel',
    pieces: [{ id: 'wheel-half', name: 'Wheel half', file: 'wheel-half.3mf' }],
    surfaces: [{ id: 'face', name: 'Wheel face', normal: [0, 1, 0], up: [0, 0, 1], pieces: ['wheel-half'] }],
    fill: true,
  },
  {
    kind: 'hubcap',
    name: 'Hubcap',
    pieces: [{ id: 'hubcap', name: 'Hubcap', file: 'wheel-hub-cap.3mf' }],
    surfaces: [{ id: 'face', name: 'Hubcap face', normal: [0, 1, 0], up: [0, 0, 1], origin: [0, 27.3, 0], pieces: ['hubcap'] }],
    fill: true,
  },
  {
    kind: 'footrest',
    name: 'Footrest',
    pieces: [{ id: 'footrest', name: 'Footrest', file: 'footrest.3mf' }],
    surfaces: [{ id: 'face', name: 'Footrest face', normal: [0, -1, 0], up: [0, 0, 1], pieces: ['footrest'] }],
    fill: true,
  },
  {
    kind: 'chair',
    name: 'Chair body',
    pieces: chairPieces,
    variants: [
      { id: 'standard', name: 'Standard casters' },
      { id: 'kit', name: 'Kit casters' },
    ],
    surfaces: [
      { id: 'left', name: 'Left side', normal: [1, 0, 0], pieces: ['chair-handle-left', 'chair-storage-left', 'chair-wheel-mount-left'], mirrorOf: 'right' },
      { id: 'right', name: 'Right side', normal: [-1, 0, 0], pieces: ['chair-handle-right', 'chair-storage-right', 'chair-wheel-mount-right'], mirrorOf: 'left' },
      { id: 'back', name: 'Back', normal: [0, 0, -1], pieces: ['chair-seat-back-top', 'chair-seat-back-bottom'] },
      { id: 'front', name: 'Front', normal: [0, 0, 1], pieces: ['chair-seat-back-top', 'chair-seat-back-bottom'] },
      { id: 'seat-left', name: 'Seat side (left)', normal: [-1, 0, 0], pieces: ['chair-handle-left'], mirrorOf: 'seat-right' },
      { id: 'seat-right', name: 'Seat side (right)', normal: [1, 0, 0], pieces: ['chair-handle-right'], mirrorOf: 'seat-left' },
      { id: 'fender-left', name: 'Fender (left)', normal: [1, 0, 0], pieces: ['chair-wing-left'], mirrorOf: 'fender-right' },
      { id: 'fender-right', name: 'Fender (right)', normal: [-1, 0, 0], pieces: ['chair-wing-right'], mirrorOf: 'fender-left' },
    ],
    fill: false,
  },
];

export function kindDef(kind: PartKind): KindDef {
  const k = KINDS.find((d) => d.kind === kind);
  if (!k) throw new Error(`unknown part ${kind}`);
  return k;
}

export function piecesFor(kind: KindDef, variant?: string): PieceDef[] {
  const v = variant ?? kind.variants?.[0].id;
  return kind.pieces.filter((p) => !p.variant || p.variant === v);
}

/** The wheel is 280mm across; nothing on it may reach past that. */
export const WHEEL_DIAMETER_MM = 280;
export const HUBCAP_THICKNESS_MM = 3;
export const HUBCAP_CHAMFER_MM = 1;
