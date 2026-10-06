import type { AssemblyPart } from '../types';
import type { ManifoldAPI } from './manifold';
import { ConformalZoneMapper } from './conformal';
import { implicitZoneFor, type ZoneMapper } from './zones';

/**
 * Which surfaces of one part take artwork, as the mappers that cut them: the single dispatch point
 * between the zone models, in its own module because `conformal.ts` imports `zones.ts` and either
 * would close a runtime import cycle. No sidecar: one implicit flat zone from the chosen patch. A
 * sidecar-backed part follows its bake entirely, including "nothing": an empty `zones` array must
 * NOT fall back to the flat patch (a chair caster mount has no design surface). `wasm` may be null
 * only for read-only use (the gizmo's frameAt).
 */
export function zoneMappersFor(
  part: AssemblyPart,
  parts: AssemblyPart[],
  isRect: boolean,
  wasm: ManifoldAPI | null,
): ZoneMapper[] {
  if (!part.zones) return [implicitZoneFor(part, parts, isRect, wasm)];
  // A baked zone always carries its chart (the sidecar loader only attaches resolved ones), so a
  // chartless entry means the chart failed to reconstruct — skip it rather than silently cutting
  // that zone's artwork onto the part's unrelated flat patch.
  return part.zones.flatMap((z) =>
    z.chart ? [new ConformalZoneMapper(wasm, z.chart, z.id, part.positions)] : [],
  );
}

/** The mapper the on-face gizmo reads its frame from: a part's first (or only) design zone. */
export function primaryZoneMapper(
  part: AssemblyPart,
  parts: AssemblyPart[],
  isRect: boolean,
): ZoneMapper | null {
  return zoneMappersFor(part, parts, isRect, null)[0] ?? null;
}
