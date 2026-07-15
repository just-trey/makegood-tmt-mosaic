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
    // `copies` = how many rotated copies "load full assembly" auto-adds beyond the primary
    // (so top = 1 primary + 1 rotated copy = 2 physical tops); copyDefaults seed each copy's
    // pivot/angle (same values the manual "+ Add rotated copy" button uses).
    roles: [
      {
        id: 'top',
        name: 'Top',
        libraryPartId: 'top',
        allowRotatedCopies: true,
        copies: 1,
        copyDefaults: { pivotX: 0, pivotZ: 0, angleDeg: 180 },
      },
      {
        id: 'cap',
        name: 'Cap',
        libraryPartId: 'cap',
        allowRotatedCopies: false,
        cutThrough: true,
        // the cap's shell is 3mm thick above its mounting boss — cut only that far so the
        // rest prints in base color without extra filament swaps, and the boss stays intact.
        cutThroughDepth: 3,
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
