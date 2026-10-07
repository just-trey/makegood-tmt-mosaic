// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({
  scheduleRebuild: vi.fn(),
  isRebuildLikelySlow: () => false,
}));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/scene/designGizmo', () => ({ refreshGizmo: vi.fn() }));
vi.mock('../src/app/rebuild', () => ({ refreshNetYieldOverlays: vi.fn() }));
vi.mock('../src/ui/fitPanel', () => ({
  refreshFitInputsFromState: vi.fn(),
  updateOffsetSliderRanges: vi.fn(),
}));

import { refreshFitInputsFromState } from '../src/ui/fitPanel';
import { applyParsedSVG, initArtworkPanel, SAMPLE_SVG } from '../src/ui/artworkPanel';
import { designAnchor, designMmPerUnit } from '../src/geometry/designScale';
import { parseSVGDocument } from '../src/svg/parse';
import { clearArtwork, removeArtworkInstance } from '../src/state/artwork';
import {
  applyRestoredSession,
  clearSavedSession,
  loadSavedSession,
  saveSession,
} from '../src/state/persist';
import { state } from '../src/state/store';

const STORAGE_KEY = 'tmt-mosaic:session:v1';

// Same stub as tests/artworkPanel.test.ts: jsdom has no 2d canvas for the parser's fill lookup.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () {
    let value = '#000000';
    return {
      get fillStyle() {
        return value;
      },
      set fillStyle(s: string) {
        const str = String(s).trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(str)) value = str;
      },
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  document.body.innerHTML =
    '<div id="dropzone"></div><input id="svg-input" type="file"><button id="btn-sample"></button><span id="svg-fname"></span><div id="artwork-list"></div>';
  initArtworkPanel();
});

beforeEach(() => {
  clearArtwork();
  clearSavedSession();
  state.assembly.parts = [];
  state.assembly.kindId = null;
});

const click = (): void => document.querySelector<HTMLButtonElement>('#btn-sample')!.click();

describe('Load sample artwork', () => {
  it('adds nothing on a second click, and selects the sample that is there', () => {
    click();
    click();
    expect(state.sources).toHaveLength(1);
    expect(state.artworks).toHaveLength(1);
    expect(state.activeArtworkId).toBe(state.artworks[0].id);
  });

  it('re-targets the fit inputs when another design was selected', () => {
    click();
    const sampleId = state.artworks[0].id;
    applyParsedSVG(SAMPLE_SVG, 'other.svg');
    expect(state.activeArtworkId).not.toBe(sampleId);
    vi.mocked(refreshFitInputsFromState).mockClear();
    click();
    expect(state.activeArtworkId).toBe(sampleId);
    expect(refreshFitInputsFromState).toHaveBeenCalled();
  });

  it('works again once the user has removed the sample', () => {
    click();
    removeArtworkInstance(state.artworks[0].id);
    click();
    expect(state.sources).toHaveLength(1);
    expect(state.artworks).toHaveLength(1);
  });
});

describe('the sample is exempt from the no-size notice, and nothing else is', () => {
  // Face sizes are the shape of each kind's design face, not measured parts: the claim is that the
  // fit is the same number with or without the origin, and the origin is not read for scale.
  const faces = {
    footrest: { w: 266, h: 185 },
    hubcap: { w: 180, h: 180 },
    chair: { w: 300, h: 220 },
  };

  function fit(
    origin: 'sample' | undefined,
    face: { w: number; h: number } | null,
    isRect: boolean,
  ): { mm: number; notices: string[] } {
    const parsed = parseSVGDocument(SAMPLE_SVG, origin);
    const notices: string[] = [];
    const mm = designMmPerUnit(
      parsed,
      1,
      designAnchor(parsed, isRect).r,
      { isRect, radius: 138, designFace: () => face },
      false,
      (m) => notices.push(m),
    );
    return { mm, notices };
  }

  for (const [kind, face] of Object.entries(faces)) {
    it(`${kind}: same mm per unit as an unmarked SVG, no notice`, () => {
      const plain = fit(undefined, face, true);
      const sample = fit('sample', face, true);
      expect(sample.mm).toBe(plain.mm);
      expect(sample.mm).toBeCloseTo(Math.min(face.w / 200, face.h / 200), 9);
      expect(plain.notices).toHaveLength(1);
      expect(sample.notices).toEqual([]);
    });
  }

  it('wheel: same mm per unit, no notice either way', () => {
    const plain = fit(undefined, null, false);
    const sample = fit('sample', null, false);
    expect(sample.mm).toBe(plain.mm);
    expect(sample.notices).toEqual([]);
  });

  it('a user SVG with no mm size still gets the notice', () => {
    const user = parseSVGDocument(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="50" height="50" fill="#ff0000"/></svg>',
    );
    const notices: string[] = [];
    designMmPerUnit(
      user,
      1,
      designAnchor(user, true).r,
      { isRect: true, radius: 0, designFace: () => faces.footrest },
      false,
      (m) => notices.push(m),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/no size in millimeters/);
  });

  it('a restored sample session stays quiet, and an old one (saved as an upload) still loads', async () => {
    click();
    saveSession();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.sources[0].kind).toBe('sample');

    clearArtwork();
    await applyRestoredSession(loadSavedSession()!);
    expect(state.sources[0].kind).toBe('sample');
    expect(state.sources[0].parsed.origin).toBe('sample');

    stored.sources[0].kind = 'upload';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    clearArtwork();
    await applyRestoredSession(loadSavedSession()!);
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].parsed.origin).toBeUndefined();
  });
});
