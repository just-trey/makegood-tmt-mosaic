// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadSavedSession, saveSession, type PersistedSession } from '../src/state/persist';
import { state } from '../src/state/store';

const STORAGE_KEY = 'tmt-mosaic:session:v1';

/** Enough loaded work for saveSession to consider the session worth keeping. */
function withLoadedWork(): void {
  state.sources = [
    { id: 's1', kind: 'upload', name: 'a.svg', svgText: '<svg/>', parsed: null },
  ] as unknown as typeof state.sources;
  state.artworks = [{ id: 'a1', sourceId: 's1' }] as unknown as typeof state.artworks;
}

beforeEach(() => {
  localStorage.clear();
  state.colorSettings = {};
  state.globalDepth = 1;
});

describe('session depth overrides', () => {
  it('marks a saved session as carrying only deliberate depth overrides', () => {
    withLoadedWork();
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    saveSession();

    const saved = loadSavedSession();
    expect(saved?.explicitDepths).toBe(true);
    expect(saved?.colorSettings).toEqual({ '#ff0000': { depth: 2.5 } });
  });

  it('a session saved before that guarantee is not treated as explicit', () => {
    // Sessions written by the build that seeded every row from the built (clamped) depth. Restoring
    // those verbatim reinstates the pinning bug: the global Depth field moves nothing and an
    // out-of-range depth stops warning, because the stored value already equals its own clamp.
    const legacy = {
      version: 1,
      savedAt: Date.now(),
      sources: [],
      artworks: [],
      colorSettings: { '#ff0000': { depth: 3.95 } },
    } as unknown as PersistedSession;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));

    const saved = loadSavedSession();
    expect(saved).not.toBeNull();
    expect(saved?.explicitDepths).toBeUndefined();
    // what applyRestoredSession keys off — see the colorSettings line there
    expect(saved?.explicitDepths ? saved.colorSettings : {}).toEqual({});
  });
});
