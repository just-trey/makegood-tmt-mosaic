import type { AssemblyKind, AssemblyRole } from '../types';
import { state } from '../state/store';
import {
  HUBCAP_CLIP_FACE_INNER_R_MM,
  HUBCAP_CLIP_FACE_OUTER_R_MM,
  HUBCAP_MIN_CLIP_COVERAGE,
  HUBCAP_DISCONNECTED_WARNING,
  HUBCAP_MIN_DIAMETER_MM,
  HUBCAP_MIN_FEATURE_MM,
  HUBCAP_SILHOUETTE_CAPPED_TO_WHEEL,
  HUBCAP_SILHOUETTE_MISSES_CLIPS,
  HUBCAP_SILHOUETTE_NO_ARTWORK,
  HUBCAP_SILHOUETTE_NO_TRANSPARENCY,
  HUBCAP_SILHOUETTE_TOO_MANY,
  HUBCAP_SILHOUETTE_THIN_DETAIL,
  HUBCAP_THICKNESS_MM,
  HUBCAP_WHEEL_DIAMETER_MM,
  buildHubcapBody,
  hubcapPlacement,
  hubcapTemplateSvg,
  type HubcapShape,
} from '../geometry/hubcap';
import { getManifold } from '../geometry/manifold';
import {
  clipCoverage,
  outlineArea,
  outlineReach,
  outlineBounds,
  narrowFeatureArea,
  scaleOutlineAbout,
  silhouetteFromShapes,
  type OutlinePlacement,
} from '../geometry/hubcapOutline';
import {
  designAnchor,
  designMmPerUnit,
  memoLargestDesignFace,
  type DesignScaleContext,
} from '../geometry/designScale';
import { getPrinter } from '../export/printers';

/**
 * Each assembly is a fixed set of part *roles* (wheel = Top + Cap; Top also allows rotated copies
 * of the same STL). Inline, not fetched like stl/parts.json: it defines what UI renders, so an
 * unreachable manifest would break Assembly mode instead of just losing auto-load.
 */
export const ASSEMBLY_KINDS: AssemblyKind[] = [
  {
    id: 'wheel',
    name: 'Wheel (Top ×2 + Cap)',
    templateFile: 'wheel-cover-circle.svg',
    // `copies`: rotated copies auto-added beyond the primary (1 + 1 = 2 tops); copyDefaults seed
    // each copy's pivot/angle, as the manual "+ Add rotated copy" button does.
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
        // the shell is 3mm above the mounting boss: cut only that far, so the boss stays intact
        // and the rest prints in base color without extra swaps.
        cutThroughDepth: 3,
      },
    ],
  },
  {
    id: 'hubcap',
    name: 'Hubcap',
    // rect, not the wheel's Design-radius model, though the disc is round: designFit is fixed per
    // kind, and a radius means nothing once the outline is a silhouette.
    designFit: 'rect',
    // Built, not fetched: a static file is true-to-size at one diameter only.
    buildTemplate: () => hubcapTemplateSvg(hubcapTemplateShape()),
    buildParam: {
      id: 'hubcapDiameterMm',
      label: 'Hubcap diameter',
      // below this the disc stops covering the clip tops it has to bond to
      minMm: HUBCAP_MIN_DIAMETER_MM,
    },
    roles: [
      {
        id: 'hubcap',
        name: 'Hubcap',
        // The asset is the four clips ALONE; buildMesh unions on a disc at state.hubcapDiameterMm,
        // so this part's mesh is never the fetched file.
        libraryPartId: 'hubcap-clips',
        allowRotatedCopies: false,
        // The underside outsizes the top face (inset 1mm by the chamfer), so auto-detect would land
        // on the BACK. wheel-hub-cap's top face wins, so this can't be inferred from it.
        preferFaceNormal: [0, 1, 0],
        // Deliberately no cutThrough, though the shell is the same 3mm as wheel-hub-cap's: a recess
        // (1mm state.globalDepth default) keeps a 220mm disc rigid. Only a silhouette's edge cuts
        // through, per region (edgeCutThroughDepth below), so the interior stays a recess.
        // The verified plate for the current size (hubcapPlacement): a generated part has no
        // fingerprint seal, so this is how the one human-checked arrangement reaches the export.
        // That check was a ROUND disc: a silhouette can reach further off-axis than a circle of the
        // same longest side, past the verified 7mm tower clearance. Withheld whenever the toggle is
        // on, conservatively: this sync call can't see an async fallback-to-circle resolving.
        buildPlacement: () => {
          if (state.hubcapSilhouette) return undefined;
          const plate = getPrinter(state.printerId).plate;
          return hubcapPlacement(state.hubcapDiameterMm, `${plate.w}x${plate.d}`);
        },
        buildMesh: async (asset) => {
          const shape = await hubcapShapeFromState();
          const built = await buildHubcapBody(shape.shape, asset);
          return {
            positions: built.positions,
            vertices: built.vertices,
            // Manifold's index, so shading skips rehashing; dropping it is a silent slow path.
            indexed: built.indexed,
            // Silhouette only: cut FLAT, its face IS its outline, so cutting an edge region the
            // full 3mm colors the rim instead of leaving 2mm of base color. The chamfered circle's
            // face is inset 1mm, so the rule would be a lie there. shape.shape covers fallbacks.
            edgeCutThroughDepth:
              shape.shape.kind === 'silhouette' ? HUBCAP_THICKNESS_MM : undefined,
            // Loose pieces wins: the only one that comes off the plate broken. It co-occurs with
            // cosmetic warnings (clipCoverage samples only the clip annulus), which hid it before.
            warning:
              built.components > 1
                ? HUBCAP_DISCONNECTED_WARNING
                : // The generator's complaint says what to do; a component count, what happened.
                  shape.warning,
          };
        },
      },
    ],
  },
  {
    id: 'footrest',
    name: 'Footrest',
    // no circle to anchor on: the SVG maps 1:1 in mm, centered on the detected face.
    designFit: 'rect',
    templateFile: 'footrest-template.svg',
    roles: [
      {
        id: 'footrest',
        name: 'Footrest',
        libraryPartId: 'footrest',
        allowRotatedCopies: false,
        // the flat back outsizes the seat face, so nudge auto-detect to the +Y (seat-side) patch.
        preferFaceNormal: [0, 1, 0],
      },
    ],
  },
  {
    id: 'chair-body',
    name: 'Chair body',
    // per-zone rect semantics: each zone's template maps its SVG 1:1 in mm, centered on the chart.
    designFit: 'rect',
    // Fill measured 93.6s to settle on one zone and "All zones" unfinished at 900s
    // (docs/tech-debt.md); Sticker is 4.0s for an auto-fit design across five zones.
    withholdFill: true,
    // Packed in its CAD frame (+Y up, +Z front), not design-face-up: seven design surfaces have no
    // single face for the camera. Without this the chair lies on its back. Verified on the shipped
    // meshes: wings and casters lowest in Y (15, 92), handles and seat back highest (562); wings at
    // z ≈ −4, the handles you push from behind at z ≈ −631.
    displayFrame: { up: [0, 1, 0], front: [0, 0, 1] },
    // baked design-zone sidecar (public/stl/): the conformal charts artwork wraps onto. The build
    // wiring lands with the per-zone cut refactor; src/geometry/zoneCharts.ts already loads it.
    zonesFile: 'chair-body-zones.json',
    // Standard vs Kit differ only in the caster roles, and a chair is never mixed.
    variants: [
      { id: 'standard', name: 'Standard' },
      { id: 'kit', name: 'Kit' },
    ],
    // One role per printed piece, all auto-loaded; each is a distinct mesh in the assembled pose.
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

/** The library part a role loads; undefined for a variant-dependent role and an unknown variant. */
export function roleLibraryPartId(
  role: AssemblyRole,
  variantId: string | null,
): string | undefined {
  if (role.libraryPartIdByVariant)
    return variantId ? role.libraryPartIdByVariant[variantId] : undefined;
  return role.libraryPartId;
}

/**
 * Generated-part clearance from the bed edge. Without it a 320mm disc fits a 320mm bed and passes
 * every check (the overhang warning's 0.5mm is float slop: 0.03mm inside slips under). Brims,
 * exclusion zones and nozzle reach live in the last few mm. A round usability margin, not measured.
 */
const PLATE_EDGE_MARGIN_MM = 5;

/**
 * A build parameter's ceiling on a printer. Takes `printerId` so the live control
 * (assemblyPanel.ts) and a session restore (persist.ts) agree: a restore deriving its own once
 * landed a hubcap up to 10mm larger than the field allows, inside PLATE_EDGE_MARGIN_MM.
 */
export function buildParamMax(
  param: NonNullable<AssemblyKind['buildParam']>,
  printerId: string,
): number {
  const plate = getPrinter(printerId).plate;
  return Math.min(
    param.maxMm ?? Infinity,
    plate.w - 2 * PLATE_EDGE_MARGIN_MM,
    plate.d - 2 * PLATE_EDGE_MARGIN_MM,
  );
}

/**
 * The user's variant if valid for the kind, else its first; null without variants. Defaulting here,
 * not trusting state, keeps part resolution correct before the variant UI runs.
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
 * `designMmPerUnit`'s context from live state, defined once so the gizmo (scene/faceFrame.ts) and
 * state/artwork.ts agree with the cut: a per-caller scale once drew the frame several times the
 * cut's size. The hubcap silhouette builds its own deliberately, and says why.
 */
export function currentDesignScaleContext(): DesignScaleContext {
  return {
    isRect: currentAssemblyKind()?.designFit === 'rect',
    radius: state.asmRadius || 138,
    designFace: () =>
      generatedDesignFaceOverride() ?? memoLargestDesignFace(state.assembly.parts)(),
    generatedFit: generatedFitFactor,
  };
}

/** Whether to *show* Fill (mode select, pattern strip); what state may hold is fillWithheld(). */
export function fillModeOffered(): boolean {
  return !fillWithheld();
}

/** Whether Fill is withheld on the current kind because it would misbehave there. */
export function fillWithheld(): boolean {
  if (currentAssemblyKind()?.withholdFill) return true;
  // A part cut to the artwork's outline, filled with that artwork, tiles a shape with itself.
  return state.hubcapSilhouette && !!currentAssemblyKind()?.buildParam;
}

/**
 * Fallback kind (no `?kind=`, or a retired saved kind). Must be one the Part dropdown lists, or the
 * select renders blank.
 */
export function firstOfferedKind(): AssemblyKind {
  return ASSEMBLY_KINDS.find((k) => !k.hidden) ?? ASSEMBLY_KINDS[0];
}

/** True when every library-linked role has a stl/parts.json entry. */
export function asmKindCanAutoLoad(kind: AssemblyKind | null): boolean {
  if (!kind) return false;
  const variantId = currentVariantId();
  return kind.roles.every((r) => {
    const partId = roleLibraryPartId(r, variantId);
    return !partId || !!state.assembly.library.find((e) => e.id === partId);
  });
}

/**
 * The hubcap's current shape plus any warning. Here, not src/geometry/, because it reads *state*.
 * Every refusal falls back to the circle with a reason: still printable and fixable, unlike an
 * empty scene.
 */
export async function hubcapShapeFromState(): Promise<{
  shape: HubcapShape;
  warning?: string;
}> {
  const circle: HubcapShape = { kind: 'circle', diameterMm: state.hubcapDiameterMm };
  const round = (warning?: string): { shape: HubcapShape; warning?: string } => {
    lastSilhouetteFit = 1;
    lastBuiltOutline = null;
    silhouetteOffset = null;
    return { shape: circle, warning };
  };
  if (!state.hubcapSilhouette) return round();

  // Two designs make two islands, and nothing says whose scale sizes the part.
  if (state.artworks.length > 1) return round(HUBCAP_SILHOUETTE_TOO_MANY);

  const art = state.artworks[0];
  const parsed = art
    ? (state.sources.find((s) => s.id === art.sourceId)?.parsed ?? state.parsed)
    : state.parsed;
  const shapes = parsed?.shapes ?? [];
  if (!parsed || !shapes.length) return round(HUBCAP_SILHOUETTE_NO_ARTWORK);

  // The CUT's placement, from the cut's own helpers: a parallel fit rule let shape and picture
  // drift (traced content vs document canvas). designFace is explicit because
  // generatedDesignFaceOverride reports the wheel-capped size derived *below* — circular.
  //
  // **Offset is zero here, then derived.** The cut's placer adds `faceCx`, the face's bbox centre,
  // which for a silhouette IS this outline, so any offset moved the face it was measured against.
  // The part centres on its axis and the artwork's offset is solved below.
  const scaleMult = (art?.scalePct ?? state.scalePct) / 100;
  const anchor = designAnchor(parsed, true);
  const pl: OutlinePlacement = {
    cx: anchor.cx,
    cy: anchor.cy,
    mmPerUnit: designMmPerUnit(parsed, scaleMult, anchor.r, {
      isRect: true,
      radius: 0,
      designFace: () => ({ w: state.hubcapDiameterMm, h: state.hubcapDiameterMm }),
    }),
    // A +Y face seen from above reads mirrored; the user's flip layers on top. Same as
    // DesignPlacement's xMul at nsign > 0.
    xMul: (art?.flipX ?? state.flipX) ? 1 : -1,
    zMul: (art?.flipY ?? state.flipY) ? 1 : -1,
    rotationDeg: art?.rotationDeg ?? state.rotationDeg,
    offX: 0,
    offZ: 0,
  };

  const wasm = await getManifold();
  const raw = silhouetteFromShapes(wasm, shapes, pl);
  if (!raw.length) return round(HUBCAP_SILHOUETTE_NO_ARTWORK);

  // Centred on the mounting axis, so the cut's `faceCx` is zero by construction.
  const [rx0, rz0, rx1, rz1] = outlineBounds(raw);
  const mx = (rx0 + rx1) / 2;
  const mz = (rz0 + rz1) / 2;
  const placed = raw.map((r) => r.map((p) => ({ x: p.x - mx, z: p.z - mz })));

  // No overhang past the wheel. Scale the whole placement, not a size number, so the artwork gets
  // the same factor. A plain ratio suffices: centred, every point's distance scales by exactly k.
  const reach = outlineReach(placed);
  const fit = reach > 0 ? Math.min(1, HUBCAP_WHEEL_DIAMETER_MM / 2 / reach) : 1;
  const outline = fit < 1 ? scaleOutlineAbout(placed, 0, 0, fit) : placed;

  // The cut computes `T(p)*fit + off + faceCx` with faceCx 0; the outline is `(T(p) - m)*fit`.
  // Equal exactly when off = -m*fit.
  silhouetteOffset = { x: -mx * fit, z: -mz * fit };

  // The one hard gate: a shape missing the clips exports fine and comes off the plate in pieces.
  const covered = clipCoverage(outline, HUBCAP_CLIP_FACE_INNER_R_MM, HUBCAP_CLIP_FACE_OUTER_R_MM);
  if (covered < HUBCAP_MIN_CLIP_COVERAGE) return round(HUBCAP_SILHOUETTE_MISSES_CLIPS);

  const shape: HubcapShape = { kind: 'silhouette', outline };
  const keep = (warning?: string): { shape: HubcapShape; warning?: string } => {
    lastSilhouetteFit = fit;
    lastBuiltOutline = shape;
    return { shape, warning };
  };

  // Otherwise the size control silently stops working, which reads as a bug.
  if (fit < 1) return keep(HUBCAP_SILHOUETTE_CAPPED_TO_WHEEL);

  // Filling its bbox means no transparency to cut around. Said, not refused: a rectangle is valid.
  const [bx0, bz0, bx1, bz1] = outlineBounds(outline);
  const boxArea = (bx1 - bx0) * (bz1 - bz0);
  if (boxArea > 0 && outlineArea(outline) / boxArea > 0.98)
    return keep(HUBCAP_SILHOUETTE_NO_TRANSPARENCY);

  // Printability, not correctness: a 0.5mm spike is a valid solid and one nozzle of plastic.
  const narrow = narrowFeatureArea(wasm, outline, HUBCAP_MIN_FEATURE_MM);
  return keep(narrow > 1 ? HUBCAP_SILHOUETTE_THIN_DETAIL : undefined);
}

/**
 * What the part was last built to, and the wheel cap's shrink. Cached for two sync callers (the
 * face override, the 1:1 template) because only the async generator knows; `rebuildAssemblyScene`
 * runs it before either reads, so this is current, not a guess.
 */
let lastSilhouetteFit = 1;
let lastBuiltOutline: HubcapShape | null = null;
let silhouetteOffset: { x: number; z: number } | null = null;

/**
 * The derived artwork offset for a silhouette (see hubcapShapeFromState), else null. The rebuild
 * writes it to the active instance and legacy globals so the Fit sliders show the value in force.
 */
export function hubcapSilhouetteOffset(): { x: number; z: number } | null {
  return state.hubcapSilhouette && lastBuiltOutline ? silhouetteOffset : null;
}

/**
 * The template's shape. Only a silhouette is cached: a circle is live, since the template link is
 * re-read right after the diameter changes and a cached one served the previous size.
 */
export function hubcapTemplateShape(): HubcapShape {
  if (state.hubcapSilhouette && lastBuiltOutline?.kind === 'silhouette') return lastBuiltOutline;
  return { kind: 'circle', diameterMm: state.hubcapDiameterMm };
}

/**
 * Fit box for a no-declared-size artwork when the part follows its shape: the face IS the artwork,
 * so sizing from it has no fixed point (part and picture came out at two sizes). A square of the
 * asked size meet-fits like the silhouette's placement, so they agree by construction.
 * The wheel cap rides on `generatedFitFactor`, which every designMmPerUnit branch applies.
 * Null when off or fallen back to a circle: its face is 2mm under the diameter (chamfer), so this
 * would fit artwork ~1% oversized onto the bevel. `lastBuiltOutline` tells the two apart.
 */
export function generatedDesignFaceOverride(): { w: number; h: number } | null {
  const kind = currentAssemblyKind();
  if (!kind?.buildParam || !state.hubcapSilhouette || !lastBuiltOutline) return null;
  return { w: state.hubcapDiameterMm, h: state.hubcapDiameterMm };
}

/**
 * The wheel cap's shrink, for the artwork to follow. Not folded into the face above: an SVG with an
 * absolute mm size (our own templates) never reads the face, so it was a silent no-op there.
 */
export function generatedFitFactor(): number {
  const kind = currentAssemblyKind();
  if (!kind?.buildParam || !state.hubcapSilhouette || !lastBuiltOutline) return 1;
  return lastSilhouetteFit;
}
