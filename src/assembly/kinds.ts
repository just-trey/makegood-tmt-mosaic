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
} from '../geometry/assembly';
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
    id: 'hubcap',
    name: 'Hubcap',
    // 1:1 mm, auto-centered on the face — NOT the wheel's circle/Design-radius model, even though
    // today's disc is a circle. designFit is fixed per kind and can't switch per part, and a
    // Design radius stops meaning anything as soon as the outline is a user-supplied silhouette
    // rather than a circle. Choosing rect now is what keeps that from being a breaking change.
    designFit: 'rect',
    // Built, not fetched: a static file would be true-to-size at one diameter and wrong at every
    // other. See hubcapTemplateSvg.
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
        // Deliberately no cutThrough, unlike wheel-hub-cap: that part pierces its 3mm shell for
        // every color, and this one has an identical 3mm shell, so the difference is a choice and
        // not an omission. A recess keeps a 220mm disc rigid, and inherits the 1mm
        // state.globalDepth default. The edge of a silhouette is the one place that isn't true —
        // see GeneratedMesh.edgeCutThroughDepth in buildMesh below, which is per-region rather
        // than kind-wide precisely so the interior stays a recess.
        // The verified plate for the size currently set, when there is one — see hubcapPlacement.
        // A generated part gets no fingerprint-sealed placement, so this is how the one thing a
        // human *did* check (a specific arrangement at a specific diameter) reaches the export.
        //
        // That check was a ROUND disc. Once "cut to artwork shape" is on, hubcapDiameterMm is a
        // longest-side reading of a shape that isn't a circle, and a silhouette can reach further
        // off-axis than a circle of the same longest side does — an arrangement verified with 7mm
        // of tower clearance on a round part is not verified for whatever shape a photo traces to.
        // Withholding here whenever the toggle is on, rather than only when the built shape ends up
        // a silhouette, is deliberately conservative: it also covers the moment between the toggle
        // going on and a fallback-to-circle warning resolving, which this synchronous call has no
        // way to look ahead to (hubcapShapeFromState needs the wasm module and runs async).
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
            // Manifold's own index for the mesh it just built, so display shading reads the vertex
            // sharing instead of rehashing every corner. Forwarding it is the whole point of
            // GeneratedMesh.indexed: dropping it here silently leaves this part on the slow path.
            indexed: built.indexed,
            // Only a silhouette. It is cut FLAT (see HubcapShape) so its design face IS its
            // outline, and a region touching that boundary is one standing on the part's real
            // outer wall — cutting it the shell's full 3mm puts the rim in the artwork's color
            // instead of leaving 2mm of base color around the picture. The circle is chamfered:
            // its face is inset 1mm from the rim, so the same cut would still leave a base-color
            // ring and the rule would be a lie. Reading shape.shape rather than
            // state.hubcapSilhouette also covers every fallback-to-circle path for free.
            edgeCutThroughDepth:
              shape.shape.kind === 'silhouette' ? HUBCAP_THICKNESS_MM : undefined,
            // Loose pieces wins over everything, because it is the only one of these that comes
            // off the plate broken. It used to lose: `shape.warning ?? …` dropped it whenever the
            // shape ALSO had something cosmetic to say, and the two co-occur — clipCoverage only
            // samples the clip annulus, so a detached island elsewhere passes it and can be
            // reported as merely thin, or as capped to the wheel, while the part falls apart.
            warning:
              built.components > 1
                ? HUBCAP_DISCONNECTED_WARNING
                : // Otherwise the generator's own complaint: "your silhouette misses the clips"
                  // says what to do about it, where a component count only says what happened.
                  shape.warning,
          };
        },
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
    hidden: true,
    // per-zone rect semantics: each zone's template maps its SVG 1:1 in mm, centered on the chart.
    designFit: 'rect',
    withholdFill: true,
    // The chair is packed in its CAD frame (up is +Y, the front where the wings/footrest sit is
    // +Z), not design-face-up like the wheel and footrest — a body with seven design surfaces has
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
 * What `designMmPerUnit` needs about the part currently loaded, read off live state.
 *
 * One definition because the gizmo (scene/faceFrame.ts) and the stacked-instance cascade
 * (state/artwork.ts) both have to agree with the cut about how big a design is placed, and a scale
 * restated per caller is exactly how the frame once came out several times the size of the cut.
 * The hubcap silhouette builds its own context deliberately, and says why.
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

/**
 * Whether to *show* Fill for the part currently loaded: only the assembly cut pipeline implements
 * it, and the kind must not withhold it. Drives the controls (mode select, pattern strip), not what
 * state may hold — see fillWithheld() for that distinction.
 */
export function fillModeOffered(): boolean {
  if (state.shapeKind !== 'assembly') return false;
  return !fillWithheld();
}

/**
 * Whether Fill is withheld on the current kind because it would misbehave, as opposed to merely
 * being unimplemented (flat modes). Only this warrants rewriting a mode the user already chose:
 * a flat part just ignores Fill, so clamping there would quietly discard the setting on a
 * round-trip out to a disc and back.
 */
export function fillWithheld(): boolean {
  if (currentAssemblyKind()?.withholdFill) return true;
  // Cutting the part to the artwork's own outline and then repeating that artwork across it tiles
  // a shape with copies of itself. Withheld rather than merely unoffered, for the reason the doc
  // above gives: it would misbehave, so it is worth rewriting a mode already chosen.
  return state.hubcapSilhouette && !!currentAssemblyKind()?.buildParam;
}

/**
 * The kind to fall back to whenever the app has to pick one for the user: boot with no `?kind=`,
 * and a restore whose saved kind has been retired. It has to be one the Part dropdown actually
 * lists, or the select holds a value with no matching option and renders blank.
 */
export function firstOfferedKind(): AssemblyKind {
  return ASSEMBLY_KINDS.find((k) => !k.hidden) ?? ASSEMBLY_KINDS[0];
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
  const round = (warning?: string): { shape: HubcapShape; warning?: string } => {
    lastSilhouetteFit = 1;
    lastBuiltOutline = null;
    silhouetteOffset = null;
    return { shape: circle, warning };
  };
  if (!state.hubcapSilhouette) return round();

  // One design only. Two make an outline of two islands, and there is no answer to which one's
  // scale sizes the part.
  if (state.artworks.length > 1) return round(HUBCAP_SILHOUETTE_TOO_MANY);

  const art = state.artworks[0];
  const parsed = art
    ? (state.sources.find((s) => s.id === art.sourceId)?.parsed ?? state.parsed)
    : state.parsed;
  const shapes = parsed?.shapes ?? [];
  if (!parsed || !shapes.length) return round(HUBCAP_SILHOUETTE_NO_ARTWORK);

  // The placement the CUT will use, read from the same two helpers the cut reads it from. Not a
  // parallel "fit the outline to a size" rule: that is what let the shape and the picture drift
  // apart, since one measured the traced content and the other the document canvas. designFace is
  // passed explicitly rather than through generatedDesignFaceOverride because the override reports
  // the wheel-capped size derived *below*, and reading it here would be circular.
  //
  // **Offset is deliberately zero here, and is then derived rather than read.** With the part cut
  // to the artwork, moving the artwork relative to it is not a meaningful thing to ask for — and
  // trying to honour it cannot be made consistent: the cut's own placer finishes with
  // `+ faceCx`, the design face's bbox centre, which for a silhouette IS the outline being
  // placed. Every offset therefore moved the face it was being measured against. So the part
  // centres on its mounting axis and the artwork's offset is solved for below to put the picture
  // on it.
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
    // The design face points +Y and is seen from above, so it reads mirrored; the user's own
    // horizontal flip layers on top. Same expression as DesignPlacement's xMul at nsign > 0.
    xMul: (art?.flipX ?? state.flipX) ? 1 : -1,
    zMul: (art?.flipY ?? state.flipY) ? 1 : -1,
    rotationDeg: art?.rotationDeg ?? state.rotationDeg,
    offX: 0,
    offZ: 0,
  };

  const wasm = await getManifold();
  const raw = silhouetteFromShapes(wasm, shapes, pl);
  if (!raw.length) return round(HUBCAP_SILHOUETTE_NO_ARTWORK);

  // Centre the shape on the mounting axis, so the clips sit in the middle of it and the cut's
  // `faceCx` is zero by construction rather than by luck.
  const [rx0, rz0, rx1, rz1] = outlineBounds(raw);
  const mx = (rx0 + rx1) / 2;
  const mz = (rz0 + rz1) / 2;
  const placed = raw.map((r) => r.map((p) => ({ x: p.x - mx, z: p.z - mz })));

  // Nothing may overhang the wheel it mounts on. Shrinking the whole placement rather than
  // clamping a "size" number, so the same factor can be handed to the artwork and the picture
  // stays exactly on the shape cut for it. A plain ratio, not a search: the shape is centred on
  // the axis now, so every point's distance from it scales by exactly k.
  const reach = outlineReach(placed);
  const fit = reach > 0 ? Math.min(1, HUBCAP_WHEEL_DIAMETER_MM / 2 / reach) : 1;
  const outline = fit < 1 ? scaleOutlineAbout(placed, 0, 0, fit) : placed;

  // Solve the artwork's offset so the picture lands on the shape. The cut computes
  // `T(p)*fit + off + faceCx`, and faceCx is 0 because the outline above is centred, while the
  // outline itself is `(T(p) - m)*fit`. Equal exactly when off = -m*fit.
  silhouetteOffset = { x: -mx * fit, z: -mz * fit };

  // The one hard gate. A shape that misses the clips exports, looks like a hubcap, and comes off
  // the plate in pieces — so it is refused up front rather than discovered after the boolean.
  const covered = clipCoverage(outline, HUBCAP_CLIP_FACE_INNER_R_MM, HUBCAP_CLIP_FACE_OUTER_R_MM);
  if (covered < HUBCAP_MIN_CLIP_COVERAGE) return round(HUBCAP_SILHOUETTE_MISSES_CLIPS);

  const shape: HubcapShape = { kind: 'silhouette', outline };
  const keep = (warning?: string): { shape: HubcapShape; warning?: string } => {
    lastSilhouetteFit = fit;
    lastBuiltOutline = shape;
    return { shape, warning };
  };

  // Capping is silent otherwise, and the symptom — the size control stops doing anything — reads
  // as a bug rather than as the wheel being the limit.
  if (fit < 1) return keep(HUBCAP_SILHOUETTE_CAPPED_TO_WHEEL);

  // An outline that fills its own bounding box is a rectangle, which on a raster means the image
  // had no transparency to cut around. Said rather than refused: a rectangular hubcap is a
  // legitimate thing to want, and this is the far more likely reading of it.
  const [bx0, bz0, bx1, bz1] = outlineBounds(outline);
  const boxArea = (bx1 - bx0) * (bz1 - bz0);
  if (boxArea > 0 && outlineArea(outline) / boxArea > 0.98)
    return keep(HUBCAP_SILHOUETTE_NO_TRANSPARENCY);

  // Printability, not correctness: a 0.5mm spike is a valid solid and one nozzle of plastic.
  const narrow = narrowFeatureArea(wasm, outline, HUBCAP_MIN_FEATURE_MM);
  return keep(narrow > 1 ? HUBCAP_SILHOUETTE_THIN_DETAIL : undefined);
}

/**
 * What the part was last actually built to, and by how much the wheel cap shrank it.
 *
 * Both exist because two synchronous callers — the design-face override below and the 1:1 template
 * — have to describe the mesh that is on screen, and the only function that knows it is async (it
 * needs the boolean engine). The rebuild runs the generator before either is read
 * (`rebuildAssemblyScene`), so this is a cache of the current answer rather than a guess at it.
 */
let lastSilhouetteFit = 1;
let lastBuiltOutline: HubcapShape | null = null;
let silhouetteOffset: { x: number; z: number } | null = null;

/**
 * The artwork offset that puts the picture on the silhouette, or null when the part isn't one.
 *
 * Derived, never read from the user: see the note in hubcapShapeFromState. The rebuild applies
 * this to the active instance and to the legacy globals right after regenerating, so the Fit
 * sliders show the value actually in force rather than one that gets quietly overruled.
 */
export function hubcapSilhouetteOffset(): { x: number; z: number } | null {
  return state.hubcapSilhouette && lastBuiltOutline ? silhouetteOffset : null;
}

/**
 * The shape the hubcap template should be drawn for: whatever the part currently is.
 *
 * Only the silhouette comes from the cache. A circle is derived live from the diameter, because
 * the control changes it and the template link is re-read immediately — reading a cached circle
 * there served the previous diameter's drawing, which is exactly the quietly-wrong template
 * hubcapTemplateSvg's comment is about.
 */
export function hubcapTemplateShape(): HubcapShape {
  if (state.hubcapSilhouette && lastBuiltOutline?.kind === 'silhouette') return lastBuiltOutline;
  return { kind: 'circle', diameterMm: state.hubcapDiameterMm };
}

/**
 * The box a no-declared-size artwork is fitted into, when the part's own shape follows it.
 *
 * Normally `designMmPerUnit` fits such an artwork to the largest design face — but with the
 * silhouette toggle on, that face IS the artwork, and an artwork sized from a face sized from the
 * artwork has no fixed point. It showed up as the part and the picture on it coming out at two
 * different sizes.
 *
 * A square of the size the user asked for breaks it: meet-fit puts the artwork's longer axis on
 * that side, which is the same rule the silhouette's own placement uses, so the shape and the
 * picture agree by construction — and scaling the artwork scales both, because the scale
 * multiplier applies to this exactly as it applies to a real face.
 *
 * The wheel cap is NOT folded in here — it rides on `generatedFitFactor` below, because it has to
 * apply on every one of designMmPerUnit's branches and this face is consulted on only one of them.
 *
 * Null whenever the toggle is off, and equally once the shape has fallen back to a circle: the
 * disc's own face is 2mm smaller than its diameter (the chamfer), so reporting the diameter here
 * auto-fits artwork about 1% oversized, onto the bevel where it gets cut away. `lastBuiltOutline`
 * is what distinguishes "cut to shape" from "asked for it and got a circle".
 */
export function generatedDesignFaceOverride(): { w: number; h: number } | null {
  const kind = currentAssemblyKind();
  if (!kind?.buildParam || !state.hubcapSilhouette || !lastBuiltOutline) return null;
  return { w: state.hubcapDiameterMm, h: state.hubcapDiameterMm };
}

/**
 * How much the wheel cap shrank the generated part, for the artwork to follow.
 *
 * Separate from the face above so it survives every sizing branch — an SVG declaring an absolute
 * mm size never consults the face at all, and folding the cap in there made it a silent no-op for
 * exactly the files this app hands out as design templates.
 */
export function generatedFitFactor(): number {
  const kind = currentAssemblyKind();
  if (!kind?.buildParam || !state.hubcapSilhouette || !lastBuiltOutline) return 1;
  return lastSilhouetteFit;
}
