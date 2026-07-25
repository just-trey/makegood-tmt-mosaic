import type { AssemblyKind } from '../types';
import { state } from '../state/store';

/**
 * An assembly is a fixed, small set of part *roles* (e.g. a wheel is exactly Top + Cap, where
 * Top additionally allows rotated-copy instances — the same physical STL reused at a different
 * position, not a separate upload). This is deliberately inline data, not a fetched manifest
 * like stl/parts.json: it defines what UI even renders, so a fetch dependency here would break
 * Assembly mode's whole UI when the manifest is unreachable instead of just losing an
 * auto-load convenience. Adding a future assembly (other TMT parts) is one array entry.
 */
export const ASSEMBLY_KINDS: AssemblyKind[] = [
  {
    id: 'wheel',
    name: 'Wheel (Top ×2 + Cap)',
    templateFile: 'wheel-cover-circle.svg',
    // `copies` = how many rotated copies "load full assembly" auto-adds beyond the primary
    // (so top = 1 primary + 1 rotated copy = 2 physical tops); copyDefaults seed each copy's
    // pivot/angle (same values the manual "+ Add rotated copy" button uses).
    roles: [
      {
        id: 'wheel-half',
        name: 'Top',
        libraryPartId: 'wheel-half',
        allowRotatedCopies: true,
        copies: 1,
        copyDefaults: { pivotX: 0, pivotZ: 0, angleDeg: 180 },
        copyName: 'Bottom',
      },
      {
        id: 'wheel-hub-cap',
        name: 'Cap',
        libraryPartId: 'wheel-hub-cap',
        allowRotatedCopies: false,
        cutThrough: true,
        // the cap's shell is 3mm thick above its mounting boss — cut only that far so the
        // rest prints in base color without extra filament swaps, and the boss stays intact.
        cutThroughDepth: 3,
      },
    ],
  },
  {
    id: 'footrest',
    name: 'Footrest',
    // rectangular design face — no circle/radius to anchor on, so the SVG maps 1:1 in mm
    // and centers on the detected face instead.
    designFit: 'rect',
    templateFile: 'footrest-template.svg',
    roles: [
      {
        id: 'footrest',
        name: 'Footrest',
        libraryPartId: 'footrest',
        allowRotatedCopies: false,
        // the flat back of the shell outsizes the seat face by area, so patch auto-detect
        // needs a nudge toward the +Y-facing (up, seat-side) patch instead of the largest one.
        preferFaceNormal: [0, 1, 0],
      },
    ],
  },
  {
    id: 'wheel-mount-left',
    name: 'Wheel mount (left)',
    // rectangular design face, same as the footrest — the artwork maps 1:1 in mm.
    designFit: 'rect',
    templateFile: 'wheel-mount-left-template.svg',
    roles: [
      {
        id: 'wheel-mount-left',
        name: 'Wheel mount (left)',
        libraryPartId: 'wheel-mount-left',
        allowRotatedCopies: false,
        // no preferFaceNormal: the design face is this part's largest flat patch by a wide
        // margin (36,054mm², next is 9,761mm²), so the default largest-patch pick is correct.
      },
    ],
  },
  {
    id: 'storage-left',
    name: 'Storage (left)',
    // rectangular design face — the prominent outer panel (with the debossed logo). Maps 1:1 in mm.
    designFit: 'rect',
    templateFile: 'storage-left-template.svg',
    // preview spins the render -90° about the design-face normal so the panel reads upright with
    // its base resting at the origin (logo at the bottom); cosmetic only — see previewSpinDeg.
    previewSpinDeg: -90,
    roles: [
      {
        id: 'storage-left',
        name: 'Storage (left)',
        libraryPartId: 'storage-left',
        allowRotatedCopies: false,
        // no preferFaceNormal: the design face is the prominent +Y outer panel, which is also the
        // largest flat patch (22,318mm²) — a smooth panel with a shallow debossed logo stays one
        // big coplanar patch, while the -Y structural back shatters into fragments (largest only
        // 6,666mm²). So the largest-patch default already lands on the right face.
      },
    ],
  },
  {
    id: 'storage-right',
    name: 'Storage (right)',
    designFit: 'rect',
    templateFile: 'storage-right-template.svg',
    previewSpinDeg: -90,
    roles: [
      {
        id: 'storage-right',
        name: 'Storage (right)',
        libraryPartId: 'storage-right',
        allowRotatedCopies: false,
        // mirror of storage-left; the prominent +Y outer panel is the largest patch (21,384mm²),
        // so the largest-patch default is correct — no preferFaceNormal needed.
      },
    ],
  },
  {
    id: 'wing-left',
    name: 'Wing (left)',
    // rectangular design face — the outer face of the wing. Maps the SVG 1:1 in mm.
    designFit: 'rect',
    templateFile: 'wing-left-template.svg',
    previewSpinDeg: -90,
    roles: [
      {
        id: 'wing-left',
        name: 'Wing (left)',
        libraryPartId: 'wing-left',
        allowRotatedCopies: false,
        // The design face is the OUTER face (the top layer in the diagonal print pose), which is
        // NOT the largest patch — the inner face (29,825mm²) outsizes it (16,978mm²) — so nudge to
        // the +Y-facing (outer) patch, which the mesh ships face up.
        preferFaceNormal: [0, 1, 0],
        // The outer face is domed: its main flat region sits at the anchor plane, with a raised
        // step and curved edges falling away. cutThrough skips the flat-patch clip so the design
        // spreads across the whole main face rather than only the detected patch; 4mm is a shallow
        // inlay that stays well clear of the 50mm-thick part's inner face. The raised step and steep
        // curves are out of a flat down-projection's reach — a true surface wrap is a future item.
        cutThrough: true,
        cutThroughDepth: 4,
      },
    ],
  },
  {
    id: 'wing-right',
    name: 'Wing (right)',
    designFit: 'rect',
    templateFile: 'wing-right-template.svg',
    previewSpinDeg: -90,
    roles: [
      {
        id: 'wing-right',
        name: 'Wing (right)',
        libraryPartId: 'wing-right',
        allowRotatedCopies: false,
        // mirror of wing-left; same outer-face design target and cut-through inlay.
        preferFaceNormal: [0, 1, 0],
        cutThrough: true,
        cutThroughDepth: 4,
      },
    ],
  },
];

export function currentAssemblyKind(): AssemblyKind | null {
  return ASSEMBLY_KINDS.find((k) => k.id === state.assembly.kindId) || null;
}

/**
 * True when every library-linked role for this assembly has a manifest entry available
 * (i.e. stl/parts.json loaded).
 */
export function asmKindCanAutoLoad(kind: AssemblyKind | null): boolean {
  return (
    !!kind &&
    kind.roles.every(
      (r) => !r.libraryPartId || !!state.assembly.library.find((e) => e.id === r.libraryPartId),
    )
  );
}
