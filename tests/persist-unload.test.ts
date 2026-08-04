// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initBeforeUnloadGuard, schedulePersist } from '../src/state/persist';
import { state } from '../src/state/store';

const STORAGE_KEY = 'tmt-mosaic:session:v1';

/** Enough loaded work for saveSession to consider the session worth keeping. */
function withLoadedWork(): void {
  state.sources = [
    { id: 's1', kind: 'upload', name: 'a.svg', svgText: '<svg/>', parsed: null },
  ] as unknown as typeof state.sources;
  state.artworks = [{ id: 'a1', sourceId: 's1' }] as unknown as typeof state.artworks;
}

/** Dispatches a real, cancelable beforeunload the way a browser would, and reports whether the
 * guard blocked it. */
function dispatchBeforeUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

// Registered once — the guard re-reads state at dispatch time, so one registration covers every
// test below the same way the app only calls initBeforeUnloadGuard() once at boot.
initBeforeUnloadGuard();

beforeEach(() => {
  localStorage.clear();
  state.sources = [];
  state.artworks = [];
});

describe('beforeunload guard', () => {
  it('does not prompt when nothing is loaded', () => {
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it('flushes a still-pending debounced save and does not prompt', () => {
    vi.useFakeTimers();
    try {
      withLoadedWork();
      schedulePersist(); // arms the 1s debounce; nothing written yet
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

      expect(dispatchBeforeUnload()).toBe(false);
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prompts when the write throws', () => {
    withLoadedWork();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      expect(dispatchBeforeUnload()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('prompts when the snapshot exceeds the size cap, and leaves no partial write behind', () => {
    withLoadedWork();
    state.sources = [
      { id: 's1', kind: 'upload', name: 'a.svg', svgText: 'x'.repeat(5_000_000), parsed: null },
    ] as unknown as typeof state.sources;

    expect(dispatchBeforeUnload()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // The mixed case: the save lands, so lastSaveFailed is false, but snapshotSession() drops the
  // image on the floor and nothing said so. Leaving here really does lose work — the SVG comes
  // back from the restore banner and the image has to be re-dropped.
  it('prompts when the save succeeded but left a loaded image out of it', () => {
    withLoadedWork();
    state.sources = [
      { id: 's1', kind: 'upload', name: 'a.svg', svgText: '<svg/>', parsed: null },
      { id: 's2', kind: 'raster', name: 'photo.png', svgText: '', parsed: null, raster: {} },
    ] as unknown as typeof state.sources;
    state.artworks = [
      { id: 'a1', sourceId: 's1' },
      { id: 'a2', sourceId: 's2' },
    ] as unknown as typeof state.artworks;

    expect(dispatchBeforeUnload()).toBe(true);
    // …and the SVG half genuinely did save, so this is not the write-failed case wearing a hat.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('goes quiet again once the image is the only thing removed', () => {
    withLoadedWork();
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it('flushes a pending save on visibilitychange to hidden, ahead of any unload', () => {
    vi.useFakeTimers();
    try {
      withLoadedWork();
      schedulePersist();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
