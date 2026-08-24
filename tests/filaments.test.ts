import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Filament } from '../src/types';

/**
 * `filaments` is module-level and loadFilaments() mutates it, so each case needs a fresh registry —
 * otherwise a test that successfully swaps the palette leaks into the ones after it.
 */
async function freshModule() {
  vi.resetModules();
  return import('../src/state/filaments');
}

const stubFetch = (impl: () => unknown): void => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(impl));
};

const PALETTE: Filament[] = [
  { id: 'mine-a', name: 'Shop Black', hex: '#000000' },
  { id: 'mine-b', name: 'Shop White', hex: '#ffffff' },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the shipped fallback palette', () => {
  it('is in use before anything is loaded', async () => {
    const { getFilaments } = await freshModule();

    expect(getFilaments().length).toBeGreaterThan(0);
    expect(getFilaments().map((f) => f.id)).toContain('black');
  });

  it('gives every entry the id/name/hex the UI reads', async () => {
    const { getFilaments } = await freshModule();

    for (const f of getFilaments()) {
      expect(f.id, JSON.stringify(f)).toBeTruthy();
      expect(f.name, JSON.stringify(f)).toBeTruthy();
      expect(f.hex, JSON.stringify(f)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('has no duplicate ids, which would make getFilament ambiguous', async () => {
    const { getFilaments } = await freshModule();

    const ids = getFilaments().map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('loadFilaments', () => {
  it('replaces the palette with a valid filaments.json', async () => {
    stubFetch(() => ({ ok: true, json: async () => PALETTE }));
    const { loadFilaments, getFilaments } = await freshModule();

    const returned = await loadFilaments();

    expect(returned).toEqual(PALETTE);
    expect(getFilaments()).toEqual(PALETTE);
  });

  it('keeps the fallback when the file is missing', async () => {
    stubFetch(() => ({ ok: false, status: 404 }));
    const { loadFilaments, getFilaments } = await freshModule();

    const returned = await loadFilaments();

    expect(returned.map((f) => f.id)).toContain('black');
    expect(getFilaments().map((f) => f.id)).toContain('black');
  });

  it('keeps the fallback when the fetch throws', async () => {
    stubFetch(() => {
      throw new Error('offline');
    });
    const { loadFilaments } = await freshModule();

    await expect(loadFilaments()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'black' })]),
    );
  });

  it('keeps the fallback when the JSON is unparseable', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    const { loadFilaments } = await freshModule();

    await expect(loadFilaments()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'black' })]),
    );
  });

  it.each([
    ['not an array', { nope: true }],
    ['an empty array', []],
    ['an entry missing hex', [{ id: 'a', name: 'A' }]],
    ['an entry missing id', [{ name: 'A', hex: '#fff000' }]],
    ['an entry missing name', [{ id: 'a', hex: '#fff000' }]],
    ['a null entry', [{ id: 'a', name: 'A', hex: '#fff000' }, null]],
  ])('rejects a malformed palette that is %s, keeping the fallback', async (_label, data) => {
    stubFetch(() => ({ ok: true, json: async () => data }));
    const { loadFilaments, getFilaments } = await freshModule();

    await loadFilaments();

    expect(getFilaments().map((f) => f.id)).toContain('black');
  });
});

describe('getFilament', () => {
  it('finds a loaded filament by id', async () => {
    stubFetch(() => ({ ok: true, json: async () => PALETTE }));
    const { loadFilaments, getFilament } = await freshModule();
    await loadFilaments();

    expect(getFilament('mine-b')?.name).toBe('Shop White');
  });

  it('is undefined for an id no longer in the palette, so callers fall back', async () => {
    const { getFilament } = await freshModule();

    expect(getFilament('retired')).toBeUndefined();
  });

  it('is undefined for no id at all', async () => {
    const { getFilament } = await freshModule();

    expect(getFilament(null)).toBeUndefined();
  });
});

describe('nearestFilamentName', () => {
  it('picks the exact match when the artwork color is one you own', async () => {
    const { nearestFilamentName } = await freshModule();

    expect(nearestFilamentName('#c1272d')).toBe('Red');
  });

  it('picks the perceptually closest owned filament for a color you do not', async () => {
    stubFetch(() => ({ ok: true, json: async () => PALETTE }));
    const { loadFilaments, nearestFilamentName } = await freshModule();
    await loadFilaments();

    expect(nearestFilamentName('#111111')).toBe('Shop Black');
    expect(nearestFilamentName('#eeeeee')).toBe('Shop White');
  });

  it('names something rather than crashing when the palette is a single color', async () => {
    stubFetch(() => ({ ok: true, json: async () => [PALETTE[0]] }));
    const { loadFilaments, nearestFilamentName } = await freshModule();
    await loadFilaments();

    expect(nearestFilamentName('#00ff00')).toBe('Shop Black');
  });

  it('matches a saturated mid-brightness color by hue, not by brightness', async () => {
    // #4eb8ca is a saturated cyan roughly as bright as the shipped Grey (#8a8f94). Squared RGB
    // distance ranked Grey closer (8197 vs Blue's 11381) because it conflates brightness with
    // hue; Lab deltaE separates them and picks the actual hue family instead.
    const { nearestFilamentName } = await freshModule();

    expect(nearestFilamentName('#4eb8ca')).toBe('Cyan');
  });
});
