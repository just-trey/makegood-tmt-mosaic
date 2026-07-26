import type { ArtworkInstance, DesignSource, ParsedSVG } from '../types';
import { state } from './store';

let nextSourceId = 1;
let nextArtworkId = 1;

/**
 * Register a freshly-parsed SVG as the (currently sole) design source, and auto-create its
 * instance on the default implicit zone — the migration bridge that keeps state.artworks in
 * lockstep with state.parsed until the artwork list panel (Phase 2b) lets a user load more than
 * one design. Placement fields seed from the current global offset/scale/rotation/flip, since
 * those remain the sliders' write target for now (see syncActiveArtworkPlacement).
 */
export function loadArtworkSource(
  parsed: ParsedSVG,
  name: string,
  kind: DesignSource['kind'] = 'upload',
): ArtworkInstance {
  const source: DesignSource = { id: `source-${nextSourceId++}`, kind, name, parsed };
  state.sources = [source];

  const instance: ArtworkInstance = {
    id: `artwork-${nextArtworkId++}`,
    sourceId: source.id,
    zone: null,
    offsetU: state.offsetX,
    offsetV: state.offsetY,
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
    flipX: state.flipX,
    flipY: state.flipY,
    mode: 'sticker',
  };
  state.artworks = [instance];
  state.activeArtworkId = instance.id;
  return instance;
}

/** The instance the gizmo/fit sliders/assembly build currently target. */
export function activeArtworkInstance(): ArtworkInstance | null {
  return state.artworks.find((a) => a.id === state.activeArtworkId) ?? null;
}

/**
 * Mirror the legacy global placement fields onto the active instance. Those globals are still
 * the fit sliders' and gizmo's write target until Phase 2b's instance-aware panel exists, so this
 * keeps the instance's placement fresh (called before assembly-mode code reads from it) without
 * requiring every slider handler to know about instances yet.
 */
export function syncActiveArtworkPlacement(): void {
  const a = activeArtworkInstance();
  if (!a) return;
  a.offsetU = state.offsetX;
  a.offsetV = state.offsetY;
  a.scalePct = state.scalePct;
  a.rotationDeg = state.rotationDeg;
  a.flipX = state.flipX;
  a.flipY = state.flipY;
}
