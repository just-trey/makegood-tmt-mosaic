import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/state/filaments', () => ({
  getFilament: vi.fn((id: string | null) =>
    id === 'f-red' ? { id, name: 'Red', hex: '#cc0000' } : undefined,
  ),
}));

import {
  DEFAULT_BASE_COLOR,
  addToBase,
  baseColorHex,
  clearBaseColor,
  currentBaseParams,
  removeFromBase,
  replaceBase,
  state,
} from '../src/state/store';

beforeEach(() => {
  state.baseColorKey = null;
  state.baseColorMembers = [];
  state.keptApart = [];
  state.baseFilamentId = null;
});

describe('addToBase', () => {
  it('accumulates rather than replacing, so a second drop grows the slot', () => {
    addToBase(['#ff0000']);
    addToBase(['#00ff00', '#0000ff']);

    expect(state.baseColorMembers).toEqual(['#ff0000', '#00ff00', '#0000ff']);
  });

  it('seeds baseColorKey from the first hex, then leaves it for the build to re-derive', () => {
    addToBase(['#ff0000', '#00ff00']);
    expect(state.baseColorKey).toBe('#ff0000');

    // a later drop must not steal the key — the build owns which member is dominant
    addToBase(['#0000ff']);
    expect(state.baseColorKey).toBe('#ff0000');
  });

  it('de-duplicates, so dropping the same color twice does not double the members', () => {
    addToBase(['#ff0000']);
    addToBase(['#ff0000']);

    expect(state.baseColorMembers).toEqual(['#ff0000']);
  });

  it('releases each added hex from keptApart', () => {
    state.keptApart = ['#ff0000', '#00ff00', '#0000ff'];

    addToBase(['#ff0000', '#0000ff']);

    expect(state.keptApart).toEqual(['#00ff00']);
  });

  it('ignores empty input and empty hexes without disturbing the current base', () => {
    addToBase(['#ff0000']);

    addToBase([]);
    addToBase(['']);

    expect(state.baseColorMembers).toEqual(['#ff0000']);
    expect(state.baseColorKey).toBe('#ff0000');
  });
});

describe('replaceBase', () => {
  it('switches the base instead of growing it — a second "→ base" means "use this one"', () => {
    addToBase(['#ff0000', '#00ff00']);

    replaceBase(['#0000ff']);

    expect(state.baseColorMembers).toEqual(['#0000ff']);
    expect(state.baseColorKey).toBe('#0000ff');
  });

  it('leaves the existing base untouched when given nothing usable', () => {
    addToBase(['#ff0000']);

    replaceBase([]);
    replaceBase(['']);

    expect(state.baseColorMembers).toEqual(['#ff0000']);
    expect(state.baseColorKey).toBe('#ff0000');
  });
});

describe('removeFromBase', () => {
  it('drops one member and keeps the rest', () => {
    addToBase(['#ff0000', '#00ff00', '#0000ff']);

    removeFromBase('#00ff00');

    expect(state.baseColorMembers).toEqual(['#ff0000', '#0000ff']);
  });

  it('re-seeds the key from a survivor when the removed color was the key', () => {
    addToBase(['#ff0000', '#00ff00']);
    expect(state.baseColorKey).toBe('#ff0000');

    removeFromBase('#ff0000');

    expect(state.baseColorMembers).toEqual(['#00ff00']);
    expect(state.baseColorKey).toBe('#00ff00');
  });

  it('leaves the key alone when a non-key member is removed', () => {
    addToBase(['#ff0000', '#00ff00']);

    removeFromBase('#00ff00');

    expect(state.baseColorKey).toBe('#ff0000');
  });

  it('clears the base entirely when the last member goes', () => {
    addToBase(['#ff0000']);

    removeFromBase('#ff0000');

    expect(state.baseColorMembers).toEqual([]);
    expect(state.baseColorKey).toBeNull();
  });

  it('is a no-op for a hex that was never in the base', () => {
    addToBase(['#ff0000']);

    removeFromBase('#123456');

    expect(state.baseColorMembers).toEqual(['#ff0000']);
    expect(state.baseColorKey).toBe('#ff0000');
  });
});

describe('baseColorHex', () => {
  it('prefers an assigned artwork color over the chosen filament', () => {
    state.baseFilamentId = 'f-red';
    addToBase(['#00ff00']);

    expect(baseColorHex()).toBe('#00ff00');
  });

  it('falls back to the chosen filament once the base assignment is cleared', () => {
    state.baseFilamentId = 'f-red';
    addToBase(['#00ff00']);

    clearBaseColor();

    expect(baseColorHex()).toBe('#cc0000');
  });

  it('falls back to the neutral default when no color and no filament are chosen', () => {
    expect(baseColorHex()).toBe(DEFAULT_BASE_COLOR);
  });

  it('falls back to the neutral default when the saved filament id is no longer known', () => {
    state.baseFilamentId = 'retired-filament';

    expect(baseColorHex()).toBe(DEFAULT_BASE_COLOR);
  });
});

describe('currentBaseParams', () => {
  const fit = {
    marginPct: 7,
    scalePct: 120,
    offsetX: 1,
    offsetY: -2,
    flipX: true,
    flipY: false,
    rotationDeg: 45,
  };

  beforeEach(() => {
    Object.assign(state, fit);
  });

  it('carries the shared fit fields through for every shape kind', () => {
    for (const kind of ['disc', 'rect', 'round', 'stl'] as const) {
      state.shapeKind = kind;
      expect(currentBaseParams(), kind).toMatchObject({
        marginPct: 7,
        scaleMult: 1.2, // percent -> multiplier
        offsetX: 1,
        offsetY: -2,
        flipX: true,
        flipY: false,
        rotationDeg: 45,
      });
    }
  });

  it('reads disc dimensions for disc', () => {
    state.shapeKind = 'disc';
    state.disc = { diameter: 90, thickness: 5 };

    expect(currentBaseParams()).toMatchObject({ diameter: 90, thickness: 5 });
  });

  it('reads rect dimensions for rect', () => {
    state.shapeKind = 'rect';
    state.rect = { width: 100, height: 70, thickness: 3 };

    expect(currentBaseParams()).toMatchObject({ width: 100, height: 70, thickness: 3 });
  });

  it('reads round dimensions, including the corner radius, for round', () => {
    state.shapeKind = 'round';
    state.round = { width: 100, height: 70, corner: 12, thickness: 3 };

    expect(currentBaseParams()).toMatchObject({
      width: 100,
      height: 70,
      corner: 12,
      thickness: 3,
    });
  });

  it('reads the plate (not the mesh) dimensions for stl', () => {
    state.shapeKind = 'stl';
    state.stlPlate = { width: 120, height: 80, thickness: 6, faceZ: 2 };

    expect(currentBaseParams()).toMatchObject({ width: 120, height: 80, thickness: 6 });
  });

  it('is null in assembly mode, which has no flat base plate', () => {
    state.shapeKind = 'assembly';

    expect(currentBaseParams()).toBeNull();
  });
});
