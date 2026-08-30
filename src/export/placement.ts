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
>;

/**
 * Verified plate placement per part, keyed by library part id. Every entry traces back to a
 * project file whose print pose a human checked in the slicer — never computed here. See the
 * constants' own provenance comments in src/export/threemf.ts, and chairPlacement.ts (generated)
 * for the chair's 15.
 *
 * Keyed by library part rather than role because the chair's two caster roles resolve to a
 * different mesh per hardware variant, and Standard and Kit sit on different plates. Roles whose
 * id and library part id coincide (the wheel's and the footrest's) also resolve for a mesh the user
 * dropped in themselves, via the roleId fallback in resolvePlacement — but every entry here, by
 * either key, only applies to a mesh matching the fingerprint it was verified against
 * (PART_FINGERPRINTS).
 */
export const PLACEMENT: Record<string, PartPlacement> = {
  'wheel-half': {
    plateHint: 1,
    rotZdeg: WHEEL_TOP_ROT_DEG,
    fixedPos: WHEEL_TOP_POS,
    primeTowerDelta: WHEEL_PRIME_TOWER_DELTA,
  },
  'wheel-hub-cap': { plateHint: 1, rotZdeg: WHEEL_CAP_ROT_DEG, fixedPos: WHEEL_CAP_POS },
  // Support off per the user's verified reference (brim is off globally — see brim_type in
  // bambuProjectSettings). No fixedPos: the reference's own translation is just the Snapmaker U1's
  // bed center and isn't portable, so plateHint routes it through placeHintedGroup's centering
  // branch with the tower held relative.
  footrest: {
    plateHint: 1,
    plateR: FOOTREST_PLATE_R,
    primeTowerDelta: FOOTREST_PRIME_TOWER_DELTA,
    objectSettings: FOOTREST_OBJECT_SETTINGS,
  },
  ...CHAIR_PLACEMENT,
};

/**
 * Why a part didn't get baked placement.
 *
 *   - 'unknown-part' / 'mesh-mismatch' — a library part (our asset) whose id has no PLACEMENT entry,
 *     or whose mesh no longer matches its seal. Both mean the repo's own ids/assets drifted out of
 *     sync with constants a human verified, which tests/placement.test.ts refuses to let ship —
 *     loud warning if one ever escapes anyway.
 */
// Before the custom-mesh upload path was removed (no way left to check an arbitrary mesh is the
// part it claims to be), 'unverified-upload' and 'no-baked-placement' split "the user brought
// their own mesh" (a supported case, quiet info) from "our own asset drifted" (a defect, warned).
// Reopening uploads without restoring that split would report every user mesh as a repo defect —
// 'mesh-mismatch' below is not a safe stand-in for it.
export type PlacementReason =
  | 'unknown-part'
  | 'mesh-mismatch'
  /**
   * The part's mesh was *generated* (AssemblyRole.buildMesh), so no baked pose can exist for it:
   * a seal pins one exact mesh, and this one is built to vary. Its own category because the
   * fingerprint failing here means nothing has gone wrong — without it a generated part reports
   * 'mesh-mismatch', whose documented meaning is that our own assets have drifted.
   */
  | 'generated-part';

export type PlacementResolution =
  /** `key` is the id the lookup actually used — worth reporting, since a rename is what breaks it */
  | { placement: PartPlacement; verified: true; key: string }
  | { placement: undefined; verified: false; reason: PlacementReason; key: string };

/**
 * Resolves a loaded part's baked export placement, refusing to hand back constants that were
 * verified against a *different* mesh than the one actually loaded — the same guard
 * fingerprintMatches (src/geometry/zoneCharts.ts) applies to zone charts, reused here for placement.
 *
 * Pure and DOM-free: emits no warnings, just says why. The caller (exportPanel.ts) turns the reason
 * into the right kind of user-facing message, or none.
 */
export function resolvePlacement(part: AssemblyPart): PlacementResolution {
  const key = part.libraryPartId ?? part.roleId;
  // Checked before anything else: a generated part's mesh is built to vary, so it can never match
  // a seal, and every reason below would be reporting a failure that hasn't happened. The signal
  // is `assetPositions` — set only when the loader handed the fetched asset to a role's buildMesh.
  //
  // Such a part can still have a *verified* plate, just not one a fingerprint can vouch for: a
  // human checks one arrangement at one size, and the role's buildPlacement says whether the
  // current build parameters are inside what was checked. When they aren't it returns undefined
  // and this reports 'generated-part', exactly as before.
  if (part.assetPositions) {
    const role = currentAssemblyKind()?.roles.find((r) => r.id === part.roleId);
    const built = role?.buildPlacement?.() as PartPlacement | undefined;
    if (built) return { placement: { plateHint: 1, ...built }, verified: true, key };
    return { placement: undefined, verified: false, reason: 'generated-part', key };
  }
  const placement = PLACEMENT[key];
  // A missing seal for a real PLACEMENT key can't ship (tests/placement.test.ts pins the two
  // tables together), and an unsealed constant is exactly what this guard exists to distrust — so
  // it fails closed here rather than being treated as "nothing to check".
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
 * The user-facing message for a resolution, or null when there's nothing to say. Lives here rather
 * than in exportPanel.ts so it's testable without a DOM, and so the reason -> severity mapping sits
 * next to the reasons themselves.
 *
 * Each reason gets its own wording deliberately: telling "this id has no baked placement" apart
 * from "this id's mesh changed" is the difference between hunting a rename and hunting a re-pack,
 * and the id is named for exactly that reason. Every message ends with the same sentence so
 * exportPanel's PLACEMENT_WARNING_SUFFIXES can clear a stale one on the next attempt.
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
    // Nothing was withheld and nothing drifted — this part has no fixed mesh to verify a pose
    // against, by design. An info rather than a warning: it reports a supported situation, and
    // warning about it would erode the two reasons above, which are defects.
    case 'generated-part':
      return {
        message: `Part "${partName}" is generated to the size you chose. No pre-verified print placement applies, ${tail}`,
        level: 'info',
      };
  }
}
