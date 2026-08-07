import type { AssemblyKind, AssemblyRole } from '../types';
import { state } from '../state/store';
import {
  HUBCAP_CLIP_FACE_OUTER_R_MM,
  HUBCAP_DISCONNECTED_WARNING,
  HUBCAP_MIN_DIAMETER_MM,
  HUBCAP_MIN_FEATURE_MM,
  HUBCAP_SILHOUETTE_MISSES_CLIPS,
  HUBCAP_SILHOUETTE_NO_ARTWORK,
  HUBCAP_SILHOUETTE_THIN_DETAIL,
  buildHubcapBody,
  hubcapPlacement,
  hubcapTemplateSvg,
  maxSizeForWheel,
  type HubcapShape,
} from '../geometry/hubcap';
import { getManifold } from '../geometry/manifold';
import {
  coversClipDisc,
  fitOutline,
  narrowFeatureArea,
  silhouetteFromShapes,
} from '../geometry/hubcapOutline';
import { getPrinter } from '../export/printers';

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
    id: 'hubcap',
    name: 'Hubcap',
    // 1:1 mm, auto-centered on the face — NOT the wheel's circle/Design-radius model, even though
    // today's disc is a circle. designFit is fixed per kind and can't switch per part, and a
    // Design radius stops meaning anything as soon as the outline is a user-supplied silhouette
    // rather than a circle. Choosing rect now is what keeps that from being a breaking change.
    designFit: 'rect',
    // Built, not fetched: a static file would be true-to-size at one diameter and wrong at every
    // other. See hubcapTemplateSvg.
    buildTemplate: () => hubcapTemplateSvg(state.hubcapDiameterMm),
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
        // The library asset is the four mounting clips ALONE; buildMesh generates the disc they
        // carry at state.hubcapDiameterMm and unions it on. So this part's mesh is never the file
        // that was fetched — see AssemblyRole.buildMesh.
        libraryPartId: 'hubcap-clips',
        allowRotatedCopies: false,
        // The disc's underside (a full circle) outsizes its top face (inset 1mm by the chamfer),
        // so the largest patch is the BACK of the part and auto-detect lands there. The shipped
        // wheel-hub-cap needs no such nudge — on that part the top face wins — so this can't be
        // inferred from the small cap.
        preferFaceNormal: [0, 1, 0],
        // Deliberately no cutThrough, unlike wheel-hub-cap: that part pierces its 3mm shell, and
        // this one has an identical 3mm shell, so the difference is a choice and not an omission.
        // A recess keeps a 220mm disc rigid, and inherits the 1mm state.globalDepth default.
        // The verified plate for the size currently set, when there is one — see hubcapPlacement.
        // A generated part gets no fingerprint-sealed placement, so this is how the one thing a
        // human *did* check (a specific arrangement at a specific diameter) reaches the export.
        buildPlacement: () => {
          const plate = getPrinter(state.printerId).plate;
          return hubcapPlacement(state.hubcapDiameterMm, `${plate.w}x${plate.d}`);
        },
        buildMesh: async (asset) => {
          const shape = await hubcapShapeFromState();
          const built = await buildHubcapBody(shape.shape, asset);
          return {
            positions: built.positions,
            vertices: built.vertices,
            // The generator's own complaint wins: "your silhouette misses the clips" says what to
            // do about it, where "the disc came out in five pieces" only says what happened.
            warning:
              shape.warning ?? (built.components > 1 ? HUBCAP_DISCONNECTED_WARNING : undefined),
          };
        },
      },
    ],
  },
  {
    id: 'chair-body',
    name: 'Chair body',
    // per-zone rect semantics: each zone's template maps its SVG 1:1 in mm, centered on the chart.
    designFit: 'rect',
    withholdFill: true,
    // The chair is packed in its CAD frame (up is +Y, the front where the wings/footrest sit is
    // +Z), not design-face-up like the wheel and footrest — a body with five design surfaces has
    // no single face to point at the camera. Without this the Z-up viewport renders CAD +Y
    // horizontal and the chair lies on its back. Verified against the shipped meshes: wings and
    // casters are lowest in Y (15, 92), handles and seat back highest (562); wings sit at z ≈ −4
    // and the handles you push from behind at z ≈ −631.
    displayFrame: { up: [0, 1, 0], front: [0, 0, 1] },
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
 * Whether to *show* Fill for the part currently loaded: only the assembly cut pipeline implements
 * it, and the kind must not withhold it. Drives the controls (mode select, pattern strip), not what
 * state may hold — see fillWithheld() for that distinction.
 */
export function fillModeOffered(): boolean {
  if (state.shapeKind !== 'assembly') return false;
  return !currentAssemblyKind()?.withholdFill;
}

/**
 * Whether Fill is withheld on the current kind because it would misbehave, as opposed to merely
 * being unimplemented (flat modes). Only this warrants rewriting a mode the user already chose:
 * a flat part just ignores Fill, so clamping there would quietly discard the setting on a
 * round-trip out to a disc and back.
 */
export function fillWithheld(): boolean {
  return !!currentAssemblyKind()?.withholdFill;
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

/**
 * The shape the hubcap should be cut to right now, plus anything the user needs told about it.
 *
 * Lives here rather than in src/geometry/ because it is the one place that reads *state* — which
 * artwork is loaded, what size was asked for, whether the silhouette toggle is on. The geometry
 * modules stay pure and testable; this is the seam where the app's current situation becomes a
 * shape.
 *
 * Every refusal falls back to the circle rather than to nothing. A hubcap that is round when you
 * expected a character, with a line saying why, is a part you can still print and a problem you
 * can still fix; an empty scene is neither.
 */
export async function hubcapShapeFromState(): Promise<{
  shape: HubcapShape;
  warning?: string;
}> {
  const circle: HubcapShape = { kind: 'circle', diameterMm: state.hubcapDiameterMm };
  if (!state.hubcapSilhouette) return { shape: circle };

  const shapes = state.sources.flatMap((s) => s.parsed?.shapes ?? []);
  if (!shapes.length) return { shape: circle, warning: HUBCAP_SILHOUETTE_NO_ARTWORK };

  const wasm = await getManifold();
  const raw = silhouetteFromShapes(wasm, shapes);
  if (!raw.length) return { shape: circle, warning: HUBCAP_SILHOUETTE_NO_ARTWORK };

  // The size control means "longest side" in both modes, but a silhouette also has to fit the
  // wheel it mounts on, and its corners reach further than its longest side does.
  const size = Math.min(state.hubcapDiameterMm, maxSizeForWheel(raw));
  const outline = fitOutline(raw, size);

  // The one hard gate. A shape that misses the clips exports, looks like a hubcap, and comes off
  // the plate in pieces — so it is refused up front rather than discovered after the boolean.
  if (!coversClipDisc(outline, HUBCAP_CLIP_FACE_OUTER_R_MM))
    return { shape: circle, warning: HUBCAP_SILHOUETTE_MISSES_CLIPS };

  // Printability, not correctness: a 0.5mm spike is a valid solid and one nozzle of plastic.
  const narrow = narrowFeatureArea(wasm, outline, HUBCAP_MIN_FEATURE_MM);
  return {
    shape: { kind: 'silhouette', outline },
    warning: narrow > 1 ? HUBCAP_SILHOUETTE_THIN_DETAIL : undefined,
  };
}
