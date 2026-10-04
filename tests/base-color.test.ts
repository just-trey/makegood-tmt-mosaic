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
  removeFromBase,
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
