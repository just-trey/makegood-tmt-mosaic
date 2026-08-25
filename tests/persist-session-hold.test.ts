// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { holdSavedSessionUntilAnswered, saveSession } from '../src/state/persist';
import { state } from '../src/state/store';
import { firstOfferedKind } from '../src/assembly/kinds';

const STORAGE_KEY = 'tmt-mosaic:session:v1';

// This file must never call markSavedSessionAnswered(): the flag it tests is module state that
// only moves one way, so answering it anywhere here would disarm every case below.
// tests/persist-hidden-kind.test.ts owns the answered side.

/** Enough loaded work for saveSession to write a session at all. */
function withLoadedWork(): void {
  state.sources = [
    { id: 's1', kind: 'upload', name: 'a.svg', svgText: '<svg/>', parsed: null },
  ] as unknown as typeof state.sources;
  state.artworks = [{ id: 'a1', sourceId: 's1' }] as unknown as typeof state.artworks;
}

beforeEach(() => {
  localStorage.clear();
  state.shapeKind = 'assembly';
  state.assembly.kindId = firstOfferedKind().id;
  state.sources = [];
  state.artworks = [];
});

/**
 * The empty-snapshot clear fires about a second into any bare boot, which is *before* a user can
 * answer the restore banner. Three ways of losing work were measured on 2026-08-24 and all of them
 * were this: opening a `?kind=` link (the banner is never shown at all), reloading while the
 * banner sat unanswered on screen, and a restore that threw.
 */
describe('a saved session whose restore offer has not been answered', () => {
  it('survives the empty save the default boot performs', () => {
    withLoadedWork();
    saveSession();
    expect(localStorage.getItem(STORAGE_KEY), 'fixture did not persist').not.toBeNull();
    holdSavedSessionUntilAnswered(); // the next page load arrives with that session

    state.sources = [];
    state.artworks = [];
    saveSession(); // the bare boot's own rebuild, with nothing loaded

    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  // The hold protects the session the user *arrived* with. An earlier version defaulted to held,
  // so a visitor who arrived with nothing, loaded a design and then deleted it kept an emptied
  // session in storage and was offered it back next visit — the exact thing the clear exists to
  // prevent.
  it('does not hold a session created after a boot that found none', () => {
    holdSavedSessionUntilAnswered(); // storage is empty at this point
    withLoadedWork();
    saveSession();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    state.sources = [];
    state.artworks = [];
    saveSession(); // the user deleted their only design

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('is still overwritten by real work, so the hold cannot strand a stale session', () => {
    withLoadedWork();
    saveSession();

    state.artworks = [{ id: 'a2', sourceId: 's1' }] as unknown as typeof state.artworks;
    saveSession();

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.artworks.map((a: { id: string }) => a.id)).toEqual(['a2']);
  });
});
