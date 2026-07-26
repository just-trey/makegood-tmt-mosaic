import { describe, expect, it, beforeEach } from 'vitest';
import {
  activeArtworkInstance,
  clearArtwork,
  loadArtworkSource,
  syncActiveArtworkPlacement,
} from '../src/state/artwork';
import { state } from '../src/state/store';
import type { ParsedSVG } from '../src/types';

function fakeParsed(): ParsedSVG {
  return {
    shapes: [],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: null,
  };
}

beforeEach(() => {
  state.parsed = null;
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  state.offsetX = 0;
  state.offsetY = 0;
  state.scalePct = 100;
  state.rotationDeg = 0;
  state.flipX = false;
  state.flipY = false;
  state.colorSettings = {};
  state.mergeGroups = [];
  state.baseColorKey = null;
  state.baseColorMembers = [];
  state.keptApart = [];
});

describe('loadArtworkSource', () => {
  it('creates one source and one auto-instance on the implicit default zone', () => {
    const parsed = fakeParsed();
    const instance = loadArtworkSource(parsed, 'test.svg');

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].name).toBe('test.svg');
    expect(state.sources[0].kind).toBe('upload');
    expect(state.sources[0].parsed).toBe(parsed);

    expect(state.artworks).toHaveLength(1);
    expect(state.artworks[0]).toBe(instance);
    expect(instance.sourceId).toBe(state.sources[0].id);
    expect(instance.zone).toBeNull();
    expect(instance.mode).toBe('sticker');
    expect(state.activeArtworkId).toBe(instance.id);
  });

  it('seeds instance placement from the current global fit fields', () => {
    state.offsetX = 3;
    state.offsetY = -4;
    state.scalePct = 150;
    state.rotationDeg = 30;
    state.flipX = true;
    state.flipY = true;

    const instance = loadArtworkSource(fakeParsed(), 'a.svg');

    expect(instance.offsetU).toBe(3);
    expect(instance.offsetV).toBe(-4);
    expect(instance.scalePct).toBe(150);
    expect(instance.rotationDeg).toBe(30);
    expect(instance.flipX).toBe(true);
    expect(instance.flipY).toBe(true);
  });

  it('replaces (not accumulates) sources/instances on a second load — one design at a time today', () => {
    loadArtworkSource(fakeParsed(), 'first.svg');
    const second = loadArtworkSource(fakeParsed(), 'second.svg');

    expect(state.sources).toHaveLength(1);
    expect(state.artworks).toHaveLength(1);
    expect(state.sources[0].name).toBe('second.svg');
    expect(state.activeArtworkId).toBe(second.id);
  });

  it('assigns each instance a distinct id across loads', () => {
    const first = loadArtworkSource(fakeParsed(), 'first.svg');
    const second = loadArtworkSource(fakeParsed(), 'second.svg');
    expect(first.id).not.toBe(second.id);
  });
});

describe('activeArtworkInstance', () => {
  it('returns null when nothing is loaded', () => {
    expect(activeArtworkInstance()).toBeNull();
  });

  it('returns the instance matching activeArtworkId', () => {
    const instance = loadArtworkSource(fakeParsed(), 'a.svg');
    expect(activeArtworkInstance()).toBe(instance);
  });
});

describe('syncActiveArtworkPlacement', () => {
  it('mirrors current global fit fields onto the active instance', () => {
    const instance = loadArtworkSource(fakeParsed(), 'a.svg');
    state.offsetX = 7;
    state.offsetY = 8;
    state.scalePct = 80;
    state.rotationDeg = 90;
    state.flipX = true;
    state.flipY = false;

    syncActiveArtworkPlacement();

    expect(instance.offsetU).toBe(7);
    expect(instance.offsetV).toBe(8);
    expect(instance.scalePct).toBe(80);
    expect(instance.rotationDeg).toBe(90);
    expect(instance.flipX).toBe(true);
    expect(instance.flipY).toBe(false);
  });

  it('is a no-op when there is no active instance', () => {
    expect(() => syncActiveArtworkPlacement()).not.toThrow();
  });
});

describe('clearArtwork', () => {
  it('drops parsed/sources/artworks/activeArtworkId and artwork-specific settings', () => {
    state.parsed = fakeParsed();
    loadArtworkSource(state.parsed, 'a.svg');
    state.colorSettings = { '#fff': { depth: 1 } };
    state.mergeGroups = [['#fff', '#000']];
    state.baseColorKey = '#fff';
    state.baseColorMembers = ['#fff'];
    state.keptApart = ['#000'];

    clearArtwork();

    expect(state.parsed).toBeNull();
    expect(state.sources).toEqual([]);
    expect(state.artworks).toEqual([]);
    expect(state.activeArtworkId).toBeNull();
    expect(state.colorSettings).toEqual({});
    expect(state.mergeGroups).toEqual([]);
    expect(state.baseColorKey).toBeNull();
    expect(state.baseColorMembers).toEqual([]);
    expect(state.keptApart).toEqual([]);
  });

  it('leaves placement fields (offset/scale/rotation/flip) untouched — a preference, not artwork data', () => {
    state.offsetX = 5;
    state.scalePct = 150;
    state.rotationDeg = 45;
    state.flipX = true;
    loadArtworkSource(fakeParsed(), 'a.svg');

    clearArtwork();

    expect(state.offsetX).toBe(5);
    expect(state.scalePct).toBe(150);
    expect(state.rotationDeg).toBe(45);
    expect(state.flipX).toBe(true);
  });
});
