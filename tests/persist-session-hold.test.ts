// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/ui/dialogs', () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));
vi.mock('../src/assembly/parts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/assembly/parts')>();
  return { ...actual, asmLoadFullAssembly: vi.fn(async () => {}) };
});
import {
  applyRestoredSession,
  holdSavedSessionUntilAnswered,
  markSavedSessionAnswered,
  saveSession,
  schedulePersist,
  type PersistedSession,
} from '../src/state/persist';
import { state } from '../src/state/store';
import { asmLoadFullAssembly } from '../src/assembly/parts';
import { firstOfferedKind } from '../src/assembly/kinds';

const STORAGE_KEY = 'tmt-mosaic:session:v1';

// The hold is armed and released here through the paths a page actually takes: arriving with a
// session, writing over it, and the banner's own release. tests/persist-hidden-kind.test.ts owns
// the separate hidden-kind hold.

/** Real SVG text, so a session built from this can actually be restored (parseSVGDocument
 * rejects a document with no flat-filled shapes, which would fail these tests for a reason that
 * has nothing to do with what they assert). */
const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
  '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>';

/** Enough loaded work for saveSession to write a session at all. */
function withLoadedWork(): void {
  state.sources = [
    { id: 's1', kind: 'upload', name: 'a.svg', svgText: SQUARE_SVG, parsed: null },
  ] as unknown as typeof state.sources;
  state.artworks = [{ id: 'a1', sourceId: 's1' }] as unknown as typeof state.artworks;
}

// svg/parse.ts normalizes colors through a canvas 2D context, which jsdom does not have.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => {
    let fillStyle = '#000000';
    return {
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(v: string) {
        fillStyle = v;
      },
    };
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

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

  // Arming reads storage, so a boot that finds nothing must not hold. Asserted on the flag's own
  // effect — an empty save with nothing else in between — because any successful save clears the
  // flag anyway: routing through one made this pass with the whole feature stubbed out.
  it('does not arm when the user arrives with nothing', () => {
    holdSavedSessionUntilAnswered(); // storage is empty at this point
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, savedAt: 1, artworks: [] }));

    saveSession(); // nothing loaded, and nothing was armed to protect it

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

/**
 * `restoring` exists to stop a save overwriting the very session being restored, and
 * `schedulePersist` checked it only when *arming* the timer. A save armed a moment before the user
 * clicked Restore therefore fired in the middle of the restore and wrote an empty snapshot over
 * it — losing the work through the one path this whole area was meant to protect.
 *
 * The restore is held open on a promise this test resolves, because that window is the whole
 * subject: let it close on its own and the timer fires after `restoring` is back to false, with
 * the artwork already restored, so the assertion passes whatever the source does.
 */
describe('a save already armed when a restore starts', () => {
  it('does not fire while the restore is still running', async () => {
    vi.useFakeTimers();
    let releaseLoad: () => void = () => {};
    vi.mocked(asmLoadFullAssembly).mockImplementation(
      () => new Promise<void>((r) => (releaseLoad = r)),
    );
    try {
      withLoadedWork();
      saveSession();
      const stored = localStorage.getItem(STORAGE_KEY)!;
      expect(stored).not.toBeNull();

      schedulePersist(); // armed by the rebuild that was already in flight
      markSavedSessionAnswered(); // the user clicks Restore
      state.sources = [];
      state.artworks = [];

      const restore = applyRestoredSession(JSON.parse(stored) as PersistedSession);
      await Promise.resolve(); // let the restore reach its await, so `restoring` is set
      await vi.advanceTimersByTimeAsync(1000); // the armed save comes due mid-restore

      expect(
        localStorage.getItem(STORAGE_KEY),
        'the session being restored was cleared',
      ).not.toBeNull();

      releaseLoad();
      await restore;
    } finally {
      vi.useRealTimers();
    }
  });
});
