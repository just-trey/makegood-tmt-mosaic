import type { AssemblyPart } from '../types';
import type { ManifoldAPI } from './manifold';
import { ConformalZoneMapper } from './conformal';
import { implicitZoneFor, type ZoneMapper } from './zones';

/**
 * Which surfaces of one part take artwork, as the mappers that cut them. This is the single
 * dispatch point between the two zone models, and it lives in its own module because
 * `conformal.ts` already imports `zones.ts` — putting the dispatch in either would close a
 * runtime import cycle around a class declaration.
 *
 * A part of a kind with no zone sidecar keeps the original behavior exactly: one implicit flat
 * zone from its chosen design patch. A part of a sidecar-backed kind is driven entirely by what
 * was baked for it — including "nothing", which is why an empty `zones` array must NOT fall back
 * to the flat patch (see AssemblyPart.zones): a chair caster mount has no design surface, and
 * stamping the artwork on its largest flat face would be worse than leaving it plain.
 *
 * `wasm` may be null only for read-only use (the gizmo's frameAt); cutting needs the engine.
 */
export function zoneMappersFor(
  part: AssemblyPart,
  parts: AssemblyPart[],
  isRect: boolean,
  wasm: ManifoldAPI | null,
): ZoneMapper[] {
  if (!part.zones) return [implicitZoneFor(part, parts, isRect)];
  // A baked zone always carries its chart (the sidecar loader only attaches resolved ones), so a
  // chartless entry means the chart failed to reconstruct — skip it rather than silently cutting
  // that zone's artwork onto the part's unrelated flat patch.
  return part.zones.flatMap((z) => (z.chart ? [new ConformalZoneMapper(wasm, z.chart, z.id)] : []));
}

/** The mapper the on-face gizmo reads its frame from: a part's first (or only) design zone. */
export function primaryZoneMapper(
  part: AssemblyPart,
  parts: AssemblyPart[],
  isRect: boolean,
): ZoneMapper | null {
  return zoneMappersFor(part, parts, isRect, null)[0] ?? null;
}
