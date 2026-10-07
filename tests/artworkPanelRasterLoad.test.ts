// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({
  scheduleRebuild: vi.fn(),
  isRebuildLikelySlow: () => false,
}));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/fitPanel', () => ({
  refreshFitInputsFromState: vi.fn(),
  updateOffsetSliderRanges: vi.fn(),
}));
vi.mock('../src/ui/dialogs', () => ({ alertDialog: vi.fn(async () => {}) }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));

// The decode step needs a real canvas; hand the load path the pixels each fake file names.
const images = new Map<string, { data: Uint8ClampedArray; w: number; h: number }>();
vi.mock('../src/raster/decode', async (orig) => ({
  ...(await orig<typeof import('../src/raster/decode')>()),
  isRasterBuffer: () => true,
  decodeImageFile: async (f: File) => images.get(f.name)!,
}));

import { initArtworkPanel } from '../src/ui/artworkPanel';
import { state } from '../src/state/store';
import { WARNINGS, clearWarnings } from '../src/warnings';

function solid(rgba: [number, number, number, number]) {
  const w = 16;
  const h = 16;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { data, w, h };
}

async function load(name: string): Promise<void> {
  const el = document.querySelector<HTMLInputElement>('#svg-input')!;
  Object.defineProperty(el, 'files', {
    value: [new File([new Uint8Array(4)], name)],
    configurable: true,
  });
  el.dispatchEvent(new Event('change'));
  // FileReader and the async decode both settle on macrotasks.
  await new Promise((r) => setTimeout(r, 50));
}

const noOpaque = () => WARNINGS.some((w) => w.message.includes('No opaque pixels'));

describe('raster load after a failed raster load', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<span id="svg-fname"></span><div id="artwork-list"></div><div id="dropzone"></div>' +
      '<input id="svg-input" type="file"><button id="btn-sample"></button><div id="warnings"></div>';
    state.parsed = null;
    state.sources = [];
    state.artworks = [];
    state.activeArtworkId = null;
    state.colorSettings = {};
    clearWarnings();
    images.clear();
    images.set('clear.png', solid([0, 0, 0, 0]));
    images.set('red.png', solid([255, 0, 0, 255]));
    initArtworkPanel();
  });

  it('clears the "No opaque pixels" warning once a good image loads', async () => {
    await load('clear.png');
    expect(noOpaque()).toBe(true);
    await load('red.png');
    expect(state.sources).toHaveLength(1);
    expect(noOpaque()).toBe(false);
  });
});
