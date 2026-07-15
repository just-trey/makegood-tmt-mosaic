import * as THREE from 'three';
import * as turf from '@turf/turf';
import type {
  AssemblyBuild,
  AssemblyPaletteEntry,
  AssemblyPart,
  AssemblyPartOutput,
  ColorSettings,
  ParsedSVG,
  PolyFeature,
} from '../types';
import { applyColorMerges, computeNetRegionsByColor, safeIntersect } from './regions';
import {
  extrudeRegionToSoup,
  getManifold,
  manifoldDelete,
  manifoldIsValid,
  manifoldToSoup,
  mapFeatureCoords,
  soupToManifold,
  type ManifoldSolid,
} from './manifold';
import { warn } from '../warnings';

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
  /** design radius in mm — the SVG boundary circle maps to this */
  radius: number;
  scaleMult: number;
  offX: number;
  offZ: number;
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
  const { parsed, parts, mergeGroups, colorSettings, globalDepth, radius, scaleMult, offX, offZ } =
    input;
  if (!parsed) return null;

  // Design anchor: the SVG's largest <circle> when there is one (the design's intended outer
  // boundary), otherwise a pseudo-circle around the artwork's bounding box — centered on the
  // artwork, radius = half its larger dimension — so circle-less SVGs still auto-center on the
  // hub and span the design diameter instead of refusing to build.
  let svgC = parsed.rawSVGCircle;
  if (!svgC) {
    const b = parsed.bbox;
    svgC = {
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
      r: Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2 || 1,
    };
    warn(
      'This SVG has no <circle> marking the design boundary — the artwork was auto-centered on the hub using its bounding box. Use Design radius / Scale / Offset to adjust the fit.',
    );
  }

  const { byColor } = computeNetRegionsByColor(parsed.shapes);
  // Honor "merge colors" here too — merged colors become one region / one AMS slot / one depth.
  // `key` doubles as the per-region depth key.
  const resolved = applyColorMerges(byColor, mergeGroups);
  const palette: AssemblyPaletteEntry[] = resolved.map((r) => ({
    hex: r.previewColor,
    key: 'asm:' + r.key,
    members: r.members,
    isMerge: r.isMerge,
    feature: r.feature,
  }));
  if (!palette.length) return null;

  const mmPerUnit = (radius / svgC.r) * scaleMult;

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

  // Place an SVG-space point onto a part's native face frame (mm). Rotated copies get the
  // inverse of their assembly rotation, so the design slice that lands on the copy is baked
  // into the part's native (unrotated) print orientation.
  const placeOnPart =
    (part: AssemblyPart) =>
    (pt: number[]): number[] => {
      let x = (pt[0] - svgC.cx) * mmPerUnit + offX;
      // SVG Y runs top-down; the viewport is Z-up, so negate to keep the artwork right-side up
      // on the face (otherwise the whole design reads upside down).
      let z = -(pt[1] - svgC.cy) * mmPerUnit + offZ;
      if (part.isDuplicateOf) {
        const r = rotatePointY(x, z, part.pivotX, part.pivotZ, -part.angleDeg);
        x = r[0];
        z = r[1];
      }
      return [x, z];
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

    const place = placeOnPart(part);
    const colorPrisms: Record<number, ManifoldSolid> = {};
    palette.forEach((c, ci) => {
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
        colorPrisms[ci] = soupToManifold(wasm, soup);
      } catch {
        warn(`Couldn't build the cut solid for color ${c.hex} on "${part.name}".`);
      }
    });

    const prismEntries = Object.entries(colorPrisms);
    if (!prismEntries.length) {
      // no cuts land on this part — emit the untouched body so the assembly still exports whole
      partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
      continue;
    }

    let partMan: ManifoldSolid;
    try {
      partMan = soupToManifold(wasm, part.positions);
    } catch {
      warn(`Part "${part.name}" mesh couldn't be read by the boolean engine.`);
      prismEntries.forEach(([, p]) => manifoldDelete(p));
      continue;
    }
    if (!manifoldIsValid(partMan)) {
      warn(
        `Part "${part.name}" isn't a watertight/manifold mesh, so it can't be cut cleanly — repair it (close holes, fix flipped faces) and retry. Exporting it uncut for now.`,
      );
      partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
      manifoldDelete(partMan);
      prismEntries.forEach(([, p]) => manifoldDelete(p));
      continue;
    }

    // full modified body = part - union(all color pockets)
    const prismList = prismEntries.map(([, p]) => p);
    const cutter = prismList.length === 1 ? prismList[0] : Manifold.union(prismList);
    let bodySoup: Float32Array;
    try {
      const body = Manifold.difference(partMan, cutter);
      bodySoup = manifoldToSoup(body);
      manifoldDelete(body);
    } catch {
      warn(`Boolean cut failed on part "${part.name}".`);
      bodySoup = Float32Array.from(part.positions);
    }

    // per-color inlay = part ∩ prism (the part caps the overshoot, so the inlay top is flush)
    const inlaySoups: Record<number, Float32Array> = {};
    prismEntries.forEach(([ci, prism]) => {
      try {
        const inl = Manifold.intersection(partMan, prism);
        const s = manifoldToSoup(inl);
        if (s.length) inlaySoups[+ci] = s;
        manifoldDelete(inl);
      } catch {
        warn(`Couldn't fit the inlay for a color on "${part.name}".`);
      }
    });

    if (cutter !== prismList[0]) manifoldDelete(cutter);
    prismList.forEach((p) => manifoldDelete(p));
    manifoldDelete(partMan);

    partOutputs.push({ part, bodySoup, inlaySoups });
  }
  return { partOutputs, palette, viewSign };
}
