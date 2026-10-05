// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyRestoredSession,
  clearSavedSession,
  loadSavedSession,
  saveSession,
} from '../src/state/persist';
import { clearArtwork, loadArtworkSource } from '../src/state/artwork';
import { state } from '../src/state/store';
import type { ParsedSVG } from '../src/types';

const STORAGE_KEY = 'tmt-mosaic:session:v1';
const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>';

const parsed = {
  shapes: [
    {
      fill: '#ff0000',
      loops: [
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      ],
      order: 0,
    },
  ],
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  rawSVGCircle: null,
} as unknown as ParsedSVG;

beforeEach(() => {
  clearArtwork();
  clearSavedSession();
  state.assembly.parts = [];
  state.assembly.kindId = null;
});

describe('a session saved while the built-in pattern library existed', () => {
  it("restores a source of kind 'pattern' as an upload, design intact", async () => {
    const inst = loadArtworkSource(parsed, 'cow.svg', 'upload', 'fill', SVG_TEXT);
    saveSession();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    stored.sources[0].kind = 'pattern';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const session = loadSavedSession()!;
    expect(session.sources[0].kind).toBe('pattern' as never);
    clearArtwork();
    state.assembly.parts = [];
    await applyRestoredSession(session);

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].kind).toBe('upload');
    expect(state.sources[0].name).toBe('cow.svg');
    expect(state.artworks.map((a) => a.id)).toEqual([inst.id]);
  });
});
