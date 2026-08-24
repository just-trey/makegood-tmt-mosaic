// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSession } from '../src/state/persist';
import { state } from '../src/state/store';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';

const STORAGE_KEY = 'tmt-mosaic:session:v1';

// Both kinds here are ones that ship *offered*, and `gated` is marked hidden for the duration of a
// test. Two reasons it is not simply whichever kind really carries `hidden`. Driving it off that
// made the suite go quiet the moment the chair was unhidden: the assertions still "passed" against
// a kind that no longer had the property. And the second case below needs `gated` to be genuinely
// offered, while `afterEach`'s `delete` would otherwise leave a withheld part unhidden for every
// later test in the worker.
const offeredKinds = ASSEMBLY_KINDS.filter((k) => !k.hidden);
const gated = offeredKinds[offeredKinds.length - 1];
const offered = offeredKinds[0];

/** Enough loaded work for saveSession to consider the session worth keeping (same shape as
 * tests/persist-unload.test.ts's withLoadedWork). */
function withLoadedWork(sourceId: string, artworkId: string): void {
  state.sources = [
    { id: sourceId, kind: 'upload', name: 'a.svg', svgText: '<svg/>', parsed: null },
  ] as unknown as typeof state.sources;
  state.artworks = [{ id: artworkId, sourceId }] as unknown as typeof state.artworks;
}

/** Writes a real saved session on `kindId` through the app's own save path, rather than
 * hand-rolling the persisted schema — a hand-written fixture that misses a field silently fails
 * isPersistedSession, and the guard under test then reads as absent when it is only unreached. */
function storeSessionOn(kindId: string): void {
  state.shapeKind = 'assembly';
  state.assembly.kindId = kindId;
  withLoadedWork('s1', 'a1');
  saveSession();
  expect(localStorage.getItem(STORAGE_KEY), 'fixture did not persist').not.toBeNull();
  state.sources = [];
  state.artworks = [];
}

beforeEach(() => {
  localStorage.clear();
  state.sources = [];
  state.artworks = [];
  state.shapeKind = 'assembly';
  state.assembly.kindId = offered.id;
});

afterEach(() => {
  delete gated.hidden;
});

// A session on a withheld part is never offered back (restoreBanner.ts), so without this guard
// the default boot's own empty rebuild would delete it about a second after load — silently, and
// for a part the maintainer intends to bring back.
describe('an empty save against a session stored on a hidden kind', () => {
  it('leaves the stored session in place instead of clearing it', () => {
    storeSessionOn(gated.id);
    gated.hidden = true;

    saveSession(); // state is empty now: the branch that would normally clear

    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('still clears a session stored on a kind that is offered', () => {
    storeSessionOn(gated.id); // same session, same code path — only `hidden` differs

    saveSession();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('is overwritten once there is real work to save', () => {
    storeSessionOn(gated.id);
    gated.hidden = true;
    state.assembly.kindId = offered.id;
    withLoadedWork('s2', 'a2');

    saveSession();

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.assembly.kindId).toBe(offered.id);
    expect(stored.artworks.map((a: { id: string }) => a.id)).toEqual(['a2']);
  });
});
