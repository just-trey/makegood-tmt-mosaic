import type { AssemblyPart } from '../types';
import { currentAssemblyKind } from '../assembly/kinds';
import { meshFingerprint } from '../geometry/zoneCharts';
import { PART_FINGERPRINTS } from './partFingerprints';
import {
  WHEEL_TOP_ROT_DEG,
  WHEEL_TOP_POS,
  WHEEL_CAP_ROT_DEG,
  WHEEL_CAP_POS,
  WHEEL_PRIME_TOWER_DELTA,
  FOOTREST_OBJECT_SETTINGS,
  FOOTREST_PLATE_R,
  FOOTREST_PRIME_TOWER_DELTA,
  type ExportPart,
} from './threemf';
import { CHAIR_PLACEMENT } from './chairPlacement';

// "Verified on all three registered plates" (WHEEL_TOP_POS, threemf.ts).
const WHEEL_VERIFIED_BEDS = ['256x256', '270x270', '350x320'];
// The two tower passes chairPlacement.ts was baked from. Kept here, not there: that file is
// generated from stubs not in the repo. The verify-new-bed-size skill adds a bed to this list.
const CHAIR_VERIFIED_BEDS = ['256x256', '270x270'];

/** The placement fields a part can have baked; the rest of ExportPart comes from the build. */
export type PartPlacement = Pick<
  ExportPart,
  | 'plateHint'
  | 'rotZdeg'
  | 'plateR'
  | 'fixedPos'
  | 'fixedPosByPlate'
  | 'primeTowerDelta'
  | 'primeTowerDeltaByPlate'
  | 'objectSettings'
  | 'projectSettings'
  | 'verifiedBeds'
>;

/**
 * Slicer-verified plate placement, never computed here; provenance sits on the constants in
 * threemf.ts and in chairPlacement.ts (generated) for the chair's 15. Keyed by library part, not
 * role: the chair's caster roles resolve to a different mesh, on a different plate, per variant.
 * Roles whose id is their library part id (wheel, footrest) also resolve a user-dropped mesh via
 * the roleId fallback. Either key applies only to a mesh matching its PART_FINGERPRINTS seal.
 * `verifiedBeds` is required so a newly registered printer fails closed: noted until someone checks it.
 */
export const PLACEMENT: Record<string, PartPlacement & { verifiedBeds: readonly string[] }> = {
  'wheel-half': {
    plateHint: 1,
    rotZdeg: WHEEL_TOP_ROT_DEG,
    fixedPos: WHEEL_TOP_POS,
    primeTowerDelta: WHEEL_PRIME_TOWER_DELTA,
    verifiedBeds: WHEEL_VERIFIED_BEDS,
  },
  'wheel-hub-cap': {
    plateHint: 1,
    rotZdeg: WHEEL_CAP_ROT_DEG,
    fixedPos: WHEEL_CAP_POS,
    verifiedBeds: WHEEL_VERIFIED_BEDS,
  },
  // No fixedPos: the reference translation is just the U1's bed center, so it centers via
  // placeHintedGroup with the tower held relative (see FOOTREST_PLATE_R).
  footrest: {
    plateHint: 1,
    plateR: FOOTREST_PLATE_R,
    primeTowerDelta: FOOTREST_PRIME_TOWER_DELTA,
    objectSettings: FOOTREST_OBJECT_SETTINGS,
    // Only the U1 reference (stubs/footrest reference tower.3mf) has been opened in a slicer.
    verifiedBeds: ['270x270'],
  },
  ...Object.fromEntries(
    Object.entries(CHAIR_PLACEMENT).map(([id, p]) => [
      id,
      { ...p, verifiedBeds: CHAIR_VERIFIED_BEDS },
    ]),
  ),
};

/**
 * 'unknown-part' / 'mesh-mismatch': our own ids/assets drifted from verified constants. A defect
 * tests/placement.test.ts refuses to ship, so a loud warning if one escapes.
 */
// Trap: reopening custom-mesh uploads needs back the removed 'unverified-upload' reason ("user
// brought their own mesh", quiet info); 'mesh-mismatch' would report every user mesh as a defect.
export type PlacementReason =
  | 'unknown-part'
  | 'mesh-mismatch'
  /** Generated mesh (AssemblyRole.buildMesh), built to vary, so no seal can match. Its own reason
   * so it doesn't report 'mesh-mismatch', which means our assets drifted. */
  | 'generated-part';

export type PlacementResolution =
  /** `key` is the id the lookup actually used — worth reporting, since a rename is what breaks it */
  | { placement: PartPlacement; verified: true; key: string }
  | { placement: undefined; verified: false; reason: PlacementReason; key: string };

/**
 * Baked placement for a loaded part, refused when verified against a *different* mesh (the guard
 * fingerprintMatches in src/geometry/zoneCharts.ts applies to charts). Pure: returns a reason, and
 * exportPanel.ts decides the message.
 */
export function resolvePlacement(part: AssemblyPart): PlacementResolution {
  const key = part.libraryPartId ?? part.roleId;
  // First: a generated part (`assetPositions` is set only for a role's buildMesh) can never match
  // a seal. It can still have a verified plate: buildPlacement says whether the current build
  // parameters are inside the one arrangement a human checked, else returns undefined.
  if (part.assetPositions) {
    const role = currentAssemblyKind()?.roles.find((r) => r.id === part.roleId);
    const built = role?.buildPlacement?.() as PartPlacement | undefined;
    if (built) return { placement: { plateHint: 1, ...built }, verified: true, key };
    return { placement: undefined, verified: false, reason: 'generated-part', key };
  }
  const placement = PLACEMENT[key];
  // Fails closed on a missing seal: an unsealed constant is what this guards against
  // (tests/placement.test.ts pins the two tables together).
  const seal = PART_FINGERPRINTS[key];
  if (placement && seal && part.positions) {
    const got = meshFingerprint(part.positions, part.positions.length / 9);
    if (got.triangleCount === seal.triangleCount && got.bboxHash === seal.bboxHash)
      return { placement, verified: true, key };
  }

  return {
    placement: undefined,
    verified: false,
    reason: placement ? 'mesh-mismatch' : 'unknown-part',
    key,
  };
}

/**
 * Message for a resolution, or null. Distinct wording per reason (and the id named) separates
 * hunting a rename from hunting a re-pack. Every message ends with the same sentence so
 * exportPanel's PLACEMENT_WARNING_SUFFIXES can clear a stale one.
 */
export function placementNotice(
  partName: string,
  resolution: PlacementResolution,
): { message: string; level: 'warn' | 'info' } | null {
  if (resolution.verified) return null;
  const tail = 'so it was placed automatically. Check it in your slicer before printing.';
  switch (resolution.reason) {
    case 'unknown-part':
      return {
        message: `Part "${partName}" has no verified print placement under its part id "${resolution.key}", ${tail}`,
        level: 'warn',
      };
    case 'mesh-mismatch':
      return {
        message: `Part "${partName}" doesn't match the mesh its verified print placement was baked against, ${tail}`,
        level: 'warn',
      };
    // Info, not a warning: a supported situation, and warning would erode the two defects above.
    case 'generated-part':
      return {
        message: `Part "${partName}" is generated to the size you chose. No pre-verified print placement applies, ${tail}`,
        level: 'info',
      };
  }
}
