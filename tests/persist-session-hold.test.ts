// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { holdSavedSessionUntilAnswered, saveSession } from '../src/state/persist';
import { state } from '../src/state/store';
import { firstOfferedKind } from '../src/assembly/kinds';

const STORAGE_KEY = 'tmt-mosaic:session:v1';

// This file must never call markSavedSessionAnswered(): that is the banner's release, and
// tests/persist-hidden-kind.test.ts owns the answered side. The hold here is armed and released
// through the two paths a page actually takes — arriving with a session, and writing over it.

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

  // The hold ends the moment the user's own work reaches storage — what is there is then theirs
  // from this page life, not the session they arrived with. Without that release it never ended on
  // a boot where the banner is never answered (a `?kind=` link, or a banner simply ignored), and
  // deleting the last design left the *earlier* work in storage to be offered back next visit.
  it('ends once the user\u2019s own work overwrites what they arrived with', () => {
    withLoadedWork();
    saveSession();
    holdSavedSessionUntilAnswered(); // a later page load arrives with that session, banner ignored

    state.artworks = [{ id: 'a2', sourceId: 's1' }] as unknown as typeof state.artworks;
    saveSession(); // the user works anyway, overwriting it

    state.sources = [];
    state.artworks = [];
    saveSession(); // then deletes their only design

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // Arming reads storage, so a boot that finds nothing must not hold: a visitor who arrives with
  // no session, loads a design and deletes it should not leave an emptied session behind.
  it('does not arm when the user arrives with nothing', () => {
    holdSavedSessionUntilAnswered(); // storage is empty at this point
    withLoadedWork();
    saveSession();

    state.sources = [];
    state.artworks = [];
    saveSession();

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
