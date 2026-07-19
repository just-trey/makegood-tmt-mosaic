import * as THREE from 'three';
import * as turf from '@turf/turf';
import type {
  AssemblyBuild,
  AssemblyPaletteEntry,
  AssemblyPart,
  AssemblyPartOutput,
  ColorSettings,
  DetectedColor,
  IndexedMesh,
  ParsedSVG,
  PolyFeature,
} from '../types';
import {
  applyColorMerges,
  computeNetRegionsByColor,
  planarArea,
  safeIntersect,
  YIELD_BUDGET_MS,
  yieldToBrowser,
} from './regions';
import {
  extrudeRegionToSoup,
  getManifold,
  manifoldDelete,
  manifoldIsValid,
  manifoldToMeshes,
  mapFeatureCoords,
  repairSelfIntersections,
  soupToManifold,
  type ManifoldSolid,
} from './manifold';
import { notice, warn } from '../warnings';
import { reportProgress } from '../progress';

/** How far each cutter pokes above the face so the pocket opens cleanly at the surface. */
export const OVERSHOOT_MM = 0.5;

export function rotatePointY(
  x: number,
  z: number,
  pivotX: number,
  pivotZ: number,
  angleDeg: number,
): [number, number] {
  const r = (angleDeg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  const dx = x - pivotX,
    dz = z - pivotZ;
  return [pivotX + dx * c - dz * s, pivotZ + dx * s + dz * c];
}

export function asmPartFaceNormal(part: AssemblyPart, parts: AssemblyPart[]): number[] | null {
  if (part.patchNormal) return part.patchNormal;
  if (part.isDuplicateOf) {
    const src = parts.find((p) => p.id === part.isDuplicateOf);
    if (src && src.patchNormal) return src.patchNormal;
  }
  return null;
}

/** X/Z bounding box (mm) of a part's flat-face boundary loop; null when the loop is empty. */
function faceXZBBox(
  loop: number[][] | null | undefined,
): { cx: number; cz: number; w: number; h: number } | null {
  if (!loop || !loop.length) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of loop) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, h: maxZ - minZ };
}

/**
 * Visual counterpart to rotatePointY: a duplicate part's rendered meshes need an actual 3D
 * transform (rotatePointY only remaps *which design slice* lands where, never moves geometry),
 * so a rotated copy renders at its own real position instead of overlapping its source part.
 * Three.js's rotation.y sign convention is opposite rotatePointY's, hence the negation.
 */
export function asmPartTransformGroup(part: AssemblyPart): {
  outer: THREE.Group;
  add(mesh: THREE.Object3D): void;
} {
  if (!part.isDuplicateOf) {
    const outer = new THREE.Group();
    return {
      outer,
      add(mesh) {
        outer.add(mesh);
      },
    };
  }
  const outer = new THREE.Group();
  outer.position.set(part.pivotX, 0, part.pivotZ);
  outer.rotation.y = (-part.angleDeg * Math.PI) / 180;
  const inner = new THREE.Group();
  inner.position.set(-part.pivotX, 0, -part.pivotZ);
  outer.add(inner);
  return {
    outer,
    add(mesh) {
      inner.add(mesh);
    },
  };
}

export interface AssemblyBuildInput {
  parsed: ParsedSVG;
  parts: AssemblyPart[];
  mergeGroups: string[][];
  colorSettings: ColorSettings;
  globalDepth: number;
  /** design radius in mm — the SVG boundary circle maps to this (ignored when designFit==='rect') */
  radius: number;
  /** how artwork maps onto the face; 'rect' scales the SVG 1:1 in mm and centers on the face */
  designFit?: 'wheel' | 'rect';
  scaleMult: number;
  offX: number;
  offZ: number;
  /** user horizontal mirror (fixes artwork that reads back-to-front on the face) */
  flipX: boolean;
  /** user vertical mirror, on top of the built-in SVG y-down correction */
  flipY: boolean;
  autoMergeLevel?: number;
  baseColorKey?: string | null;
  /** every raw hex the base assignment excludes from cutting (see state/store.ts addToBase) */
  baseColorMembers?: string[];
  keptApart?: string[];
}

/**
 * Vector + mesh-boolean assembly build. For each part: take the SVG's real per-color net
 * regions, place them onto the part's flat face in the part's own native coordinates, extrude
 * each to a prism, then use Manifold to (a) subtract all prisms from the real part mesh -> the
 * FULL modified body, and (b) intersect each prism with the part -> a flush inlay solid per
 * color.
 */
export async function buildAssemblyGeometry(
  input: AssemblyBuildInput,
): Promise<AssemblyBuild | null> {
  const {
    parsed,
    parts,
    mergeGroups,
    colorSettings,
    globalDepth,
    radius,
    designFit,
    scaleMult,
    offX,
    offZ,
    flipX,
    flipY,
    autoMergeLevel,
    baseColorKey,
    baseColorMembers,
    keptApart,
  } = input;
  if (!parsed) return null;

  const isRect = designFit === 'rect';

  // Design anchor: the SVG's largest <circle> when there is one (the design's intended outer
  // boundary), otherwise a pseudo-circle around the artwork's bounding box — centered on the
  // artwork, radius = half its larger dimension — so circle-less SVGs still auto-center on the
  // hub and span the design diameter instead of refusing to build. Rect parts always anchor on
  // the artwork bbox center (a template circle is meaningless there) and skip the wheel notice.
  const bbox = parsed.bbox;
  let svgC = isRect ? null : parsed.rawSVGCircle;
  if (!svgC) {
    svgC = {
      cx: (bbox.minX + bbox.maxX) / 2,
      cy: (bbox.minY + bbox.maxY) / 2,
      r: Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) / 2 || 1,
    };
    if (!isRect)
      notice(
        'This SVG has no <circle> marking the design boundary — the artwork was auto-centered on the hub using its bounding box. Use Design radius / Scale / Offset to adjust the fit.',
      );
  }

  // Split like flat.ts: the per-color net regions are ~0-40%, then the per-part Manifold CSG
  // loop below (the actual heavy work in assembly mode) covers ~40-100%.
  const { byColor } = await computeNetRegionsByColor(parsed.shapes, (f) => reportProgress(f * 0.4));
  if (!Object.keys(byColor).length) return null; // no fills at all — nothing to place

  const totalRawArea = Object.values(byColor).reduce((s, f) => s + planarArea(f), 0) || 1;
  const detectedColors: DetectedColor[] = Object.keys(byColor)
    .map((hex) => ({ hex, areaPct: (100 * planarArea(byColor[hex])) / totalRawArea }))
    .sort((a, b) => b.areaPct - a.areaPct);
  // baseColorMembers covers a whole merged group when a merged slot was sent to base; falls back
  // to just the dominant hex for older callers/plain-color assignments.
  const baseMembers =
    baseColorMembers && baseColorMembers.length
      ? baseColorMembers
      : baseColorKey
        ? [baseColorKey]
        : [];
  const baseArea = baseMembers.reduce((s, h) => s + planarArea(byColor[h] ?? null), 0);
  // the body prints the base's dominant (largest-area) member, same as a merged cut slot would
  const dominantBaseMember = baseMembers.reduce<{ hex: string; area: number } | null>((best, h) => {
    const area = planarArea(byColor[h] ?? null);
    return !best || area > best.area ? { hex: h, area } : best;
  }, null);
  const baseAssigned =
    baseColorKey && baseArea > 0
      ? {
          hex: dominantBaseMember?.hex ?? baseColorKey,
          areaPct: (100 * baseArea) / totalRawArea,
        }
      : null;

  // Honor "merge colors" here too — merged colors become one region / one AMS slot / one depth.
  // `key` doubles as the per-region depth key. A base-assigned color is excluded here, so an
  // all-base design legitimately resolves to an empty palette (uncut body) rather than failing.
  const resolved = applyColorMerges(byColor, mergeGroups, {
    autoMergeLevel,
    baseColors: baseMembers,
    keptApart,
  });
  const palette: AssemblyPaletteEntry[] = resolved.map((r) => ({
    hex: r.previewColor,
    key: 'asm:' + r.key,
    members: r.members,
    isMerge: r.isMerge,
    feature: r.feature,
  }));

  // Wheel: SVG circle radius maps to the mm Design radius. Rect: convert SVG units to mm via the
  // file's declared physical size (userUnitMM) so a template lands life-size even if an editor
  // re-exported it at a different internal resolution.
  //
  // When a rect SVG declares no absolute mm size, fit its viewBox to the design face rather than
  // assuming 1 unit = 1 mm. The template's viewBox *is* the face, so any template trace then lands
  // life-size at Scale 100% even when the editor dropped the physical size (e.g. Affinity exports
  // `width="100%"` and rescales the viewBox to its own resolution). Meet-fit (the smaller axis
  // ratio) matches SVG's default fitting. Genuine 1:1 fallback only when there's no viewBox either.
  let rectFallbackMmPerUnit = 1;
  if (isRect && parsed.userUnitMM == null) {
    const vb = parsed.viewBox;
    // Only a *loaded* part has a face to measure. A part still fetching from the library would
    // otherwise leave designFace null, drop us to the 1:1 branch, and report a size the rebuild
    // its own load triggers immediately contradicts — so when nothing is loaded yet, say nothing
    // (there's no geometry to place either; the per-part loop below skips it).
    let designFace: { w: number; h: number } | null = null;
    for (const p of parts) {
      if (!p.loaded) continue;
      const bb = faceXZBBox(p.boundaryLoop);
      if (bb && bb.w > 0 && bb.h > 0 && (!designFace || bb.w * bb.h > designFace.w * designFace.h))
        designFace = { w: bb.w, h: bb.h };
    }
    if (designFace && vb && vb.w > 0 && vb.h > 0) {
      rectFallbackMmPerUnit = Math.min(designFace.w / vb.w, designFace.h / vb.h);
      notice(
        'This SVG has no absolute width/height in mm, so it was auto-fit to the part face. Set the document size in millimeters for an exact size, or use Scale to fine-tune.',
      );
    } else if (designFace) {
      notice(
        'This SVG has no absolute width/height in mm, so its true print size is unknown — placing it 1:1 with its coordinate units. Set the document size in millimeters, or use Scale to correct the fit.',
      );
    }
  }
  const mmPerUnit = isRect
    ? (parsed.userUnitMM ?? rectFallbackMmPerUnit) * scaleMult
    : (radius / svgC.r) * scaleMult;

  let wasm;
  try {
    wasm = await getManifold();
  } catch (e) {
    warn(
      'Could not load the Manifold boolean engine — assembly cutting is unavailable. ' +
        (e as Error).message,
    );
    return null;
  }
  const { Manifold } = wasm;

  // User-requested mirrors, layered on top of the automatic per-face correction inside
  // placeOnPart. Base Z is -1 because SVG Y runs top-down while the viewport is Z-up (keeps the
  // artwork right-side up on the face); the user's vertical flip toggles that.
  const userXFlip = flipX ? -1 : 1;
  const zMul = flipY ? 1 : -1;
  // Place an SVG-space point onto a part's native face frame (mm). Rotated copies get the
  // inverse of their assembly rotation, so the design slice that lands on the copy is baked
  // into the part's native (unrotated) print orientation. A +Y-facing design is viewed from the
  // +Y side, which reads the artwork mirrored left-to-right, so negate X on those faces to keep
  // it right-reading by default; a -Y face is viewed from -Y and already reads correctly. Flip H
  // then mirrors relative to that corrected orientation.
  const placeOnPart = (part: AssemblyPart, nsign: number) => {
    // Rect parts center the design on the detected face (its native X/Z bbox center), so artwork
    // lands on the face even when the face is offset from the part origin. Wheel parts anchor on
    // the hub at the origin.
    let faceCx = 0,
      faceCz = 0;
    const faceBB = isRect ? faceXZBBox(part.boundaryLoop) : null;
    if (faceBB) {
      faceCx = faceBB.cx;
      faceCz = faceBB.cz;
    }
    return (pt: number[]): number[] => {
      const xMul = userXFlip * (nsign > 0 ? -1 : 1);
      let x = (pt[0] - svgC.cx) * mmPerUnit * xMul + offX + faceCx;
      let z = (pt[1] - svgC.cy) * mmPerUnit * zMul + offZ + faceCz;
      if (part.isDuplicateOf) {
        const r = rotatePointY(x, z, part.pivotX, part.pivotZ, -part.angleDeg);
        x = r[0];
        z = r[1];
      }
      return [x, z];
    };
  };

  // Per-part Manifold CSG is the actual heavy work here (turf's part is done above) — yield to
  // the browser on the same time budget flat.ts's boolean passes use, and report progress across
  // parts so the "Rebuilding…" curtain climbs instead of freezing for the whole loop.
  const totalParts = parts.filter((p) => p.loaded && p.boundaryLoop && p.positions).length || 1;
  let partsDone = 0;
  let lastYield = performance.now();
  const maybeYield = async (): Promise<void> => {
    if (performance.now() - lastYield > YIELD_BUDGET_MS) {
      await yieldToBrowser();
      lastYield = performance.now();
    }
  };
  const reportPartProgress = (subFraction: number): void => {
    reportProgress(0.4 + ((partsDone + subFraction) / totalParts) * 0.6);
  };
  const finishPart = (): void => {
    partsDone++;
    reportPartProgress(0);
  };

  const partOutputs: AssemblyPartOutput[] = [];
  let viewSign = 1,
    viewSignSet = false; // Y direction of the first real part's design face
  for (const part of parts) {
    if (!part.loaded || !part.boundaryLoop || !part.positions) continue;

    const nrm = asmPartFaceNormal(part, parts);
    if (nrm && Math.abs(nrm[1]) < 0.9) {
      warn(
        `Part "${part.name}": detected face normal (${nrm.map((v) => v.toFixed(2)).join(', ')}) isn't vertical. Assembly cutting assumes a horizontal face — pick a different face or the cut may be wrong.`,
      );
    }
    // Which way the face points along Y, and the actual Y of the face plane. topZ is the plane
    // offset (= nrm.y * faceY), so a face pointing -Y (e.g. the BACK of the wheel) needs the
    // pocket cut in the opposite direction — otherwise the inlay lands on the wrong side.
    const nsign = nrm && nrm[1] < 0 ? -1 : 1;
    const faceY = nrm && Math.abs(nrm[1]) > 0.1 ? part.topZ / nrm[1] : part.topZ;
    if (!part.isDuplicateOf && !viewSignSet) {
      viewSign = nsign;
      viewSignSet = true;
    }

    // face boundary as a turf polygon in native X/Z, to clip regions to the actual face. A
    // cut-through part (e.g. a domed cap) has a design meant to span the whole curved surface,
    // not just the small flat patch used to place it, so skip the clip — the boolean subtract
    // against the real mesh below is what actually bounds the cut.
    let boundaryPoly: PolyFeature | null = null;
    if (!part.cutThrough) {
      const bRing = part.boundaryLoop.map((p) => [p[0], p[2]]);
      if (bRing.length >= 3) {
        if (
          bRing[0][0] !== bRing[bRing.length - 1][0] ||
          bRing[0][1] !== bRing[bRing.length - 1][1]
        )
          bRing.push(bRing[0]);
        try {
          boundaryPoly = turf.polygon([bRing]) as PolyFeature;
        } catch {
          boundaryPoly = null;
        }
      }
    }

    // A cut-through part ignores the normal depth setting: either it cuts a fixed mm depth
    // straight down from the face (e.g. the cap's 3mm shell above its mounting boss — deeper
    // would breach it), or, with no configured depth, pierces the part's whole vertical extent
    // (plus overshoot past the far surface) regardless of local curvature/thickness.
    let throughDepth = 0;
    if (part.cutThrough) {
      if (part.cutThroughDepth != null) {
        throughDepth = part.cutThroughDepth;
      } else {
        let yMin = Infinity,
          yMax = -Infinity;
        for (let i = 1; i < part.positions.length; i += 3) {
          const y = part.positions[i];
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
        throughDepth = (nsign > 0 ? faceY - yMin : yMax - faceY) + OVERSHOOT_MM;
      }
    }

    const place = placeOnPart(part, nsign);
    const colorPrisms: Record<number, ManifoldSolid> = {};
    // Extracted to a plain function (rather than inlined in the loop below) purely so its
    // early `return`s mean "skip this color" without fighting the surrounding for-loop/await.
    const buildColorPrism = (c: AssemblyPaletteEntry, ci: number): void => {
      if (!c.feature) return;
      let feat: PolyFeature | null = mapFeatureCoords(c.feature, place);
      if (boundaryPoly) {
        feat = safeIntersect(feat, boundaryPoly, `color ${c.hex} on ${part.name}`);
        if (!feat) return;
      }
      const depthSetting = (colorSettings[c.key] && colorSettings[c.key].depth) || globalDepth;
      if (depthSetting <= 0) return;
      const depth = part.cutThrough ? throughDepth : depthSetting;
      const soup = extrudeRegionToSoup(feat, faceY, depth, OVERSHOOT_MM, nsign);
      if (!soup || !soup.length) return;
      try {
        const man = soupToManifold(wasm, soup);
        if (!manifoldIsValid(man)) throw new Error('empty manifold');
        colorPrisms[ci] = man;
        return;
      } catch {
        /* retry below with self-intersections repaired */
      }
      // Clipping dense/overlapping line-work to the part boundary can leave the region
      // self-touching in a way turf doesn't flag as invalid but Manifold rejects as non-watertight
      // — repair it with Manifold's own 2D boolean engine and retry once before giving up.
      try {
        const repaired = repairSelfIntersections(wasm, feat);
        const soup2 = repaired && extrudeRegionToSoup(repaired, faceY, depth, OVERSHOOT_MM, nsign);
        if (soup2 && soup2.length) {
          const man2 = soupToManifold(wasm, soup2);
          if (manifoldIsValid(man2)) {
            colorPrisms[ci] = man2;
            return;
          }
        }
      } catch {
        /* fall through to warn */
      }
      warn(`Couldn't build the cut solid for color ${c.hex} on "${part.name}".`);
    };
    // +1 reserved for the body/inlay CSG stage below, so this part's progress reaches 1 only
    // once everything (colors + final cuts) is actually done.
    const partUnits = palette.length + 1;
    for (let ci = 0; ci < palette.length; ci++) {
      buildColorPrism(palette[ci], ci);
      reportPartProgress((ci + 1) / partUnits);
      await maybeYield();
    }

    const prismEntries = Object.entries(colorPrisms);
    if (!prismEntries.length) {
      // no cuts land on this part — emit the untouched body so the assembly still exports whole
      partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
      finishPart();
      continue;
    }

    let partMan: ManifoldSolid;
    try {
      partMan = soupToManifold(wasm, part.positions);
    } catch {
      warn(`Part "${part.name}" mesh couldn't be read by the boolean engine.`);
      prismEntries.forEach(([, p]) => manifoldDelete(p));
      finishPart();
      continue;
    }
    if (!manifoldIsValid(partMan)) {
      warn(
        `Part "${part.name}" isn't a watertight/manifold mesh, so it can't be cut cleanly — repair it (close holes, fix flipped faces) and retry. Exporting it uncut for now.`,
      );
      partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
      manifoldDelete(partMan);
      prismEntries.forEach(([, p]) => manifoldDelete(p));
      finishPart();
      continue;
    }

    // full modified body = part - union(all color pockets)
    const prismList = prismEntries.map(([, p]) => p);
    const cutter = prismList.length === 1 ? prismList[0] : Manifold.union(prismList);
    let bodySoup: Float32Array;
    let bodyIndexed: AssemblyPartOutput['bodyIndexed'];
    try {
      const body = Manifold.difference(partMan, cutter);
      const meshes = manifoldToMeshes(body);
      bodySoup = meshes.soup;
      bodyIndexed = meshes.indexed;
      manifoldDelete(body);
    } catch {
      warn(`Boolean cut failed on part "${part.name}".`);
      bodySoup = Float32Array.from(part.positions);
    }
    await maybeYield();

    // per-color inlay = part ∩ prism (the part caps the overshoot, so the inlay top is flush)
    const inlaySoups: Record<number, Float32Array> = {};
    const inlayIndexed: Record<number, IndexedMesh> = {};
    for (const [ci, prism] of prismEntries) {
      try {
        const inl = Manifold.intersection(partMan, prism);
        const { soup, indexed } = manifoldToMeshes(inl);
        if (soup.length) {
          inlaySoups[+ci] = soup;
          inlayIndexed[+ci] = indexed;
        }
        manifoldDelete(inl);
      } catch {
        warn(`Couldn't fit the inlay for a color on "${part.name}".`);
      }
      await maybeYield();
    }

    if (cutter !== prismList[0]) manifoldDelete(cutter);
    prismList.forEach((p) => manifoldDelete(p));
    manifoldDelete(partMan);

    partOutputs.push({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed });
    finishPart();
  }
  return { partOutputs, palette, viewSign, detectedColors, baseAssigned };
}
