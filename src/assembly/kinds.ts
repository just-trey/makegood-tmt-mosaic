import type { AssemblyKind, AssemblyRole } from '../types';
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
    id: 'chair-body',
    name: 'Chair body',
    // per-zone rect semantics: each zone's template maps its SVG 1:1 in mm, centered on the chart.
    designFit: 'rect',
    // baked design-zone sidecar (public/stl/) — the conformal charts artwork wraps onto. The build
    // wiring that consumes it lands with the per-zone cut refactor; loading it is already covered by
    // src/geometry/zoneCharts.ts.
    zonesFile: 'chair-body-zones.json',
    // Standard vs Kit differ only in the caster mounts, but the whole chair must be one or the
    // other — never mixed. The two caster roles resolve per-variant; every other piece is shared.
    variants: [
      { id: 'standard', name: 'Standard' },
      { id: 'kit', name: 'Kit' },
    ],
    // One role per printed piece, all auto-loaded together (no rotated copies — every piece is a
    // distinct mesh in the shared assembled pose, unlike the wheel's mirrored halves).
    roles: [
      {
        id: 'handle-left',
        name: 'Handle (left)',
        libraryPartId: 'chair-handle-left',
        allowRotatedCopies: false,
      },
      {
        id: 'handle-right',
        name: 'Handle (right)',
        libraryPartId: 'chair-handle-right',
        allowRotatedCopies: false,
      },
      {
        id: 'storage-left',
        name: 'Storage (left)',
        libraryPartId: 'chair-storage-left',
        allowRotatedCopies: false,
      },
      {
        id: 'storage-right',
        name: 'Storage (right)',
        libraryPartId: 'chair-storage-right',
        allowRotatedCopies: false,
      },
      {
        id: 'wing-left',
        name: 'Wing (left)',
        libraryPartId: 'chair-wing-left',
        allowRotatedCopies: false,
      },
      {
        id: 'wing-right',
        name: 'Wing (right)',
        libraryPartId: 'chair-wing-right',
        allowRotatedCopies: false,
      },
      {
        id: 'wheel-mount-left',
        name: 'Wheel mount (left)',
        libraryPartId: 'chair-wheel-mount-left',
        allowRotatedCopies: false,
      },
      {
        id: 'wheel-mount-right',
        name: 'Wheel mount (right)',
        libraryPartId: 'chair-wheel-mount-right',
        allowRotatedCopies: false,
      },
      {
        id: 'seat-center',
        name: 'Seat center',
        libraryPartId: 'chair-seat-center',
        allowRotatedCopies: false,
      },
      {
        id: 'seat-back-bottom',
        name: 'Seat back (bottom)',
        libraryPartId: 'chair-seat-back-bottom',
        allowRotatedCopies: false,
      },
      {
        id: 'seat-back-top',
        name: 'Seat back (top)',
        libraryPartId: 'chair-seat-back-top',
        allowRotatedCopies: false,
      },
      {
        id: 'caster-left',
        name: 'Caster mount (left)',
        libraryPartIdByVariant: { standard: 'chair-caster-std-left', kit: 'chair-caster-kit-left' },
        allowRotatedCopies: false,
      },
      {
        id: 'caster-right',
        name: 'Caster mount (right)',
        libraryPartIdByVariant: {
          standard: 'chair-caster-std-right',
          kit: 'chair-caster-kit-right',
        },
        allowRotatedCopies: false,
      },
    ],
  },
];

/**
 * The library part a role loads, resolving a variant-dependent role against the chosen variant.
 * A `libraryPartIdByVariant` role returns the piece for `variantId` (or undefined if the variant
 * is unknown); a plain role ignores the variant and returns its `libraryPartId`.
 */
export function roleLibraryPartId(
  role: AssemblyRole,
  variantId: string | null,
): string | undefined {
  if (role.libraryPartIdByVariant)
    return variantId ? role.libraryPartIdByVariant[variantId] : undefined;
  return role.libraryPartId;
}

/**
 * The active variant for the current kind: the user's choice when it's valid for the kind,
 * otherwise the kind's first (default) variant. Null for a kind with no variants. Defaulting here
 * (rather than trusting state) keeps part resolution correct before the variant UI ever runs.
 */
export function currentVariantId(): string | null {
  const kind = currentAssemblyKind();
  if (!kind?.variants?.length) return null;
  const chosen = state.assembly.variantId;
  return chosen && kind.variants.some((v) => v.id === chosen) ? chosen : kind.variants[0].id;
}

export function currentAssemblyKind(): AssemblyKind | null {
  return ASSEMBLY_KINDS.find((k) => k.id === state.assembly.kindId) || null;
}

/**
 * True when every library-linked role for this assembly has a manifest entry available
 * (i.e. stl/parts.json loaded).
 */
export function asmKindCanAutoLoad(kind: AssemblyKind | null): boolean {
  if (!kind) return false;
  const variantId = currentVariantId();
  return kind.roles.every((r) => {
    const partId = roleLibraryPartId(r, variantId);
    return !partId || !!state.assembly.library.find((e) => e.id === partId);
  });
}
