// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadSavedSession, saveSession } from '../src/state/persist';
import { state } from '../src/state/store';

/**
 * The hubcap's two build inputs both have to survive a reload, and only one of them did.
 *
 * `hubcapDiameterMm` was persisted from the day the control shipped; `hubcapSilhouette` was added
 * to the store beside it and not to the snapshot, so a session restored with a character-shaped
 * hubcap came back as a plain disc — with the artwork still on it, so nothing looked broken enough
 * to explain.
 */

/** Enough loaded work for saveSession to consider the session worth keeping. */
function withLoadedWork(): void {
  state.sources = [
    { id: 's1', kind: 'upload', name: 'a.svg', svgText: '<svg/>', parsed: null },
  ] as unknown as typeof state.sources;
  state.artworks = [{ id: 'a1', sourceId: 's1' }] as unknown as typeof state.artworks;
}

beforeEach(() => {
  localStorage.clear();
  state.hubcapSilhouette = false;
  state.hubcapDiameterMm = 220;
});

describe('the hubcap’s shape survives a reload', () => {
  it('saves the silhouette toggle alongside the diameter', () => {
    withLoadedWork();
    state.hubcapSilhouette = true;
    state.hubcapDiameterMm = 190;

    saveSession();

    const saved = loadSavedSession();
    expect(saved?.hubcapSilhouette).toBe(true);
    expect(saved?.hubcapDiameterMm).toBe(190);
  });

  it('saves it off as readily as on, so turning it off sticks too', () => {
    withLoadedWork();
    state.hubcapSilhouette = false;

    saveSession();

    // false, not absent: absent is how a pre-silhouette session reads, and those must not be
    // distinguishable from a user who deliberately turned it off.
    expect(loadSavedSession()?.hubcapSilhouette).toBe(false);
  });
});
