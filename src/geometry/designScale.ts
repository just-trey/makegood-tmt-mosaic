import type { AssemblyPart, ParsedSVG } from '../types';
import { faceXZBBox } from './zones';

/**
 * Anchor for a `designFit: 'rect'` design: the document canvas centre (viewBox or declared mm box),
 * never the drawn content's. Templates span the surface 1:1 (`zoneTemplateSVG`,
 * `gen-templates.mjs`), so a shape in a sheet corner wants that corner of the surface. Null when no
 * canvas is declared.
 */
export function canvasAnchor(
  parsed: Pick<ParsedSVG, 'canvas'>,
): { cx: number; cy: number; r: number } | null {
  const c = parsed.canvas;
  if (!c || !(c.w > 0) || !(c.h > 0)) return null;
  return { cx: c.w / 2, cy: c.h / 2, r: Math.max(c.w, c.h) / 2 };
}

/**
 * Whether a `<circle>` is a template's boundary marker (the circle the drawing sits inside) or part
 * of the drawing. Taking the largest circle blindly scaled one of four r=18 corner dots to the full
 * 276mm face and threw the rest clear, silently (docs/findings/2026-08-16-maker-ease-review.md).
 *
 * Compared as bounding boxes: no circle contains its own bbox corners, so a strict test rejects
 * public/templates/wheel-cover-circle.svg (r=140, bbox corners 198 units out). Not by fill: that
 * template's boundary is a filled disc and its only unfilled circle is the centre-cap ring, which a
 * fill filter picks, blowing every template-drawn design up 7.6x.
 */
function enclosesArtwork(
  circle: { cx: number; cy: number; r: number },
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  // Slack for artwork drawn up to or a hair over the rim; relative to r so it is scale-free.
  const slack = circle.r * 0.02;
  return (
    circle.cx - circle.r - slack <= bbox.minX &&
    circle.cy - circle.r - slack <= bbox.minY &&
    circle.cx + circle.r + slack >= bbox.maxX &&
    circle.cy + circle.r + slack >= bbox.maxY
  );
}

/**
 * A rejected circle that still looks meant as the boundary: it holds some of the drawing, and what
 * escaped is small enough to be a stray. Without this, one stray mark silently drops a template to
 * the bbox fit, a fraction of the intended size and off-centre. Judged by the escapers' size, not a
 * shape-count share: template plus one stray is one in, one out, which no majority rule catches.
 */
function looksLikeAnEscapedBoundary(
  circle: { cx: number; cy: number; r: number },
  parsed: ParsedSVG,
): boolean {
  const dist = (p: { x: number; y: number }) => Math.hypot(p.x - circle.cx, p.y - circle.cy);
  // Excluded, or a decorative filled circle qualifies on its own body.
  const isTheCircle = (sh: (typeof parsed.shapes)[number]) =>
    sh.loops.every((l) => l.every((p) => Math.abs(dist(p) - circle.r) <= circle.r * 0.02));
  const others = parsed.shapes.filter((sh) => !isTheCircle(sh));
  const held = others.filter((sh) =>
    sh.loops.every((l) => l.every((p) => dist(p) <= circle.r * 1.02)),
  );
  if (!held.length || held.length === others.length) return false;
  const escaped = others.filter((sh) => !held.includes(sh));
  // A fifth of the diameter: bigger than any speck, smaller than a drawing placed outside.
  const strayLimit = circle.r * 0.4;
  return escaped.every((sh) => {
    const pts = sh.loops.flat();
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return (
      Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) <= strayLimit
    );
  });
}

/**
 * Design anchor per artwork: the SVG's <circle> when it encloses the drawing, else a pseudo-circle
 * on the artwork bbox; rect parts anchor on the canvas (canvasAnchor). Only a circle that held most
 * of the drawing and lost some gets a notice; the other branches behave and stay silent.
 * Shared with the gizmo (src/scene/faceFrame.ts), which passes no `notice`: it re-resolves on every
 * refresh and would refill the warnings panel from a mouse-move.
 */
export function designAnchor(
  parsed: ParsedSVG,
  isRect: boolean,
  notice?: (msg: string) => void,
): { cx: number; cy: number; r: number } {
  const circle = isRect ? null : parsed.rawSVGCircle;
  if (circle && enclosesArtwork(circle, parsed.bbox)) return circle;
  // `notice &&` first: the scan walks every vertex, and the sinkless gizmo calls this on every
  // refresh and pointerdown.
  if (notice && circle && looksLikeAnEscapedBoundary(circle, parsed))
    notice(
      'This SVG has a circle around most of the artwork, but some falls outside. It was fitted ' +
        'by overall size, so it may print smaller than the template intends. Remove stray marks ' +
        'outside the circle.',
    );
  // A raster anchors on its frame on every kind, wheel included, and says nothing: an image cannot
  // contain a boundary circle, so the notice below would ask every image for the impossible.
  const isRaster = parsed.origin === 'raster';
  if (isRect || isRaster) {
    const canvas = canvasAnchor(parsed);
    if (canvas) return canvas;
  }
  // No notice: centring on the bbox is what a file not drawn over a template wants.
  const bbox = parsed.bbox;
  return {
    cx: (bbox.minX + bbox.maxX) / 2,
    cy: (bbox.minY + bbox.maxY) / 2,
    r: Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) / 2 || 1,
  };
}

/**
 * Largest flat design face across *loaded* parts, lazily memoized: the size reference for a rect
 * SVG with no mm size. A part still fetching would drop callers to the 1:1 branch.
 *
 * Known limit, harmless today: one scale for the whole assembly, while `FlatZoneMapper.placer`
 * centres on each part's own face. The footrest has one face; a rect kind mixing face sizes would
 * crop oversized artwork on the smaller faces. A fix must keep `designMmPerUnit`'s two callers
 * (build and gizmo) agreeing, since that is what makes the selection frame match the cut.
 */
export function memoLargestDesignFace(
  parts: AssemblyPart[],
): () => { w: number; h: number } | null {
  let memo: { w: number; h: number } | null | undefined;
  return () => {
    if (memo !== undefined) return memo;
    let found: { w: number; h: number } | null = null;
    for (const p of parts) {
      if (!p.loaded) continue;
      const bb = faceXZBBox(p.boundaryLoops);
      if (bb && bb.w > 0 && bb.h > 0 && (!found || bb.w * bb.h > found.w * found.h))
        found = { w: bb.w, h: bb.h };
    }
    return (memo = found);
  };
}

/** What `designMmPerUnit` needs about the assembly the design is being placed on. */
export interface DesignScaleContext {
  isRect: boolean;
  /** the wheel's Design radius in mm; unused on a rect kind */
  radius: number;
  /** lazy `memoLargestDesignFace(parts)`, read only on the no-declared-size rect branch */
  designFace: () => { w: number; h: number } | null;
  /**
   * Extra shrink a *generated* part applied to its own shape, which the artwork must follow (1 or
   * absent otherwise). Separate from `designFace` because an SVG with an absolute mm size returns
   * before the face is consulted: folded in there, the hubcap's wheel cap was a silent no-op for
   * this app's own templates.
   */
  generatedFit?: () => number;
}

/**
 * SVG user units to mm for one placed artwork. Wheel: circle radius maps to the mm Design radius.
 * Rect: via the declared physical size (userUnitMM), so a template lands life-size whatever
 * resolution an editor re-exported it at.
 *
 * With no mm size, the document canvas is meet-fit to the design face (the template's sheet *is*
 * the face); 1:1 only with no canvas either. Canvas, not viewBox: an Affinity export can drop the
 * viewBox and state the sheet in px alone. viewBox stays the fill tile period. `forceRect` is the
 * fill path, where a tile is a real-world period, not a radius-driven scale. Every shipped artwork
 * declares `width="100%"`, so auto-fit is the normal path, shared with the gizmo like
 * `designAnchor`. Reads only the document (content arrives as `anchorR`), so the raster stage can
 * ask a trace's scale before tracing (state/artwork.ts).
 *
 * **Known gap: a Fill tile with no mm size still auto-fits.** A 60-unit tile on the footrest's
 * 266x185mm face reads 3.0833 mm/unit under `width="100%"` + viewBox or `width="60px"` — a 185mm
 * period, one repeat per face; `width="60mm"` reads 1.0000. The four fixture patterns all declare
 * 60mm; a user's tile can hit it. What it should repeat at is a product call: docs/roadmap.md.
 */
export function designMmPerUnit(
  parsed: Pick<ParsedSVG, 'userUnitMM' | 'canvas' | 'origin'>,
  scaleMult: number,
  anchorR: number,
  ctx: DesignScaleContext,
  forceRect = false,
  notice: (msg: string) => void = () => {},
): number {
  // Applied to every branch below, deliberately: see DesignScaleContext.generatedFit.
  const fit = ctx.generatedFit?.() ?? 1;
  if (!ctx.isRect && !forceRect) return (ctx.radius / anchorR) * scaleMult * fit;
  if (parsed.userUnitMM != null) return parsed.userUnitMM * scaleMult * fit;
  const sheet = parsed.canvas;
  const designFace = ctx.designFace();
  if (designFace && sheet && sheet.w > 0 && sheet.h > 0) {
    // Two strings, not one format-neutral one: setting the document size in mm is the real fix for
    // an SVG and impossible for an image, so a shared message loses the actionable half of each.
    // The sample fits the same way, but it is ours: nothing for the user to fix in it.
    if (parsed.origin !== 'sample')
      notice(
        parsed.origin === 'raster'
          ? 'This image has no real-world size, so it was auto-fit to the part face. Use Scale to fine-tune.'
          : 'This SVG has no size in millimeters, so it was auto-fit to the part face. Set the document size in millimeters for an exact fit, or fine-tune with Scale.',
      );
    return Math.min(designFace.w / sheet.w, designFace.h / sheet.h) * scaleMult * fit;
  }
  if (designFace)
    notice(
      'This SVG has no size in millimeters, so its true print size is unknown. It was placed 1:1 with its coordinate units. Set the document size in millimeters, or use Scale to correct the fit.',
    );
  return scaleMult * fit;
}

/**
 * Axis-aligned extent in zone mm of a design's placed content. Translation and mirroring don't
 * change an extent, so no mapper: `designMmPerUnit` and rotation (45° covers a bigger box than
 * square-on) are the whole story. Zero on an axis with no extent or under a non-finite scale
 * (degenerate anchor radius), never NaN.
 */
export function placedFootprintMM(
  parsed: ParsedSVG,
  scaleMult: number,
  rotationDeg: number,
  ctx: DesignScaleContext,
): { w: number; h: number } {
  const mm = designMmPerUnit(parsed, scaleMult, designAnchor(parsed, ctx.isRect).r, ctx);
  const b = parsed.bbox;
  const w = (b.maxX - b.minX) * mm,
    h = (b.maxY - b.minY) * mm;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) return { w: 0, h: 0 };
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t)),
    sn = Math.abs(Math.sin(t));
  return { w: c * w + sn * h, h: sn * w + c * h };
}
