import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsgFaultPoint } from '../src/geometry/csgFault';
import type { Notice } from '../src/warnings';

/**
 * `armed()` runs once at import, off `location.search`, so each arming case needs its own fresh
 * module registry. Warnings come from that same registry — importing the top-level one would read
 * a different WARNINGS array than the module under test just pushed to.
 */
async function loadArmed(search: string | null) {
  vi.resetModules();
  if (search === null) {
    vi.stubGlobal('location', undefined);
  } else {
    vi.stubGlobal('location', { search });
  }
  const csgFault = await import('../src/geometry/csgFault');
  const warnings = await import('../src/warnings');
  return { ...csgFault, WARNINGS: warnings.WARNINGS as Notice[] };
}

const messages = (w: Notice[]): string => w.map((n) => n.message).join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('csgFault arming', () => {
  it('is inert with no ?csgfault, and says nothing', async () => {
    const { csgFault, WARNINGS } = await loadArmed('');

    expect(() => csgFault('difference')).not.toThrow();
    expect(WARNINGS).toHaveLength(0);
  });

  it('is inert in node, where there is no location to read (the bake scripts)', async () => {
    const { csgFault, WARNINGS } = await loadArmed(null);

    expect(() => csgFault('difference')).not.toThrow();
    expect(WARNINGS).toHaveLength(0);
  });

  it('throws at the armed point and nowhere else', async () => {
    const { csgFault } = await loadArmed('?csgfault=difference');

    expect(() => csgFault('difference')).toThrow(/forced CSG fault: difference/);
    expect(() => csgFault('intersection')).not.toThrow();
    expect(() => csgFault('color-union')).not.toThrow();
  });

  it('announces an armed fault, so a rigged build cannot be mistaken for a broken one', async () => {
    const { WARNINGS } = await loadArmed('?csgfault=difference');

    expect(messages(WARNINGS)).toMatch(/fault injection is armed/i);
    expect(messages(WARNINGS)).toContain('difference');
    expect(messages(WARNINGS)).toContain('on every part');
  });

  it('arms every documented fault point', async () => {
    const points: CsgFaultPoint[] = [
      'color-union',
      'part-union',
      'difference',
      'body-mesh',
      'intersection',
    ];
    for (const point of points) {
      const { csgFault } = await loadArmed(`?csgfault=${point}`);
      expect(() => csgFault(point), point).toThrow(/forced CSG fault/);
    }
  });
});

describe('csgFault budget', () => {
  it('without a count, fires on every call', async () => {
    const { csgFault } = await loadArmed('?csgfault=part-union');

    for (let i = 0; i < 5; i++) expect(() => csgFault('part-union')).toThrow();
  });

  it('with :N, fires exactly N times then goes quiet', async () => {
    const { csgFault } = await loadArmed('?csgfault=intersection:2');

    expect(() => csgFault('intersection')).toThrow();
    expect(() => csgFault('intersection')).toThrow();
    expect(() => csgFault('intersection')).not.toThrow();
  });

  it('states the count in the announcement', async () => {
    const { WARNINGS } = await loadArmed('?csgfault=intersection:2');

    expect(messages(WARNINGS)).toContain('2×');
  });

  it('resetCsgFaults refills the budget, so the count is per rebuild not per session', async () => {
    const { csgFault, resetCsgFaults } = await loadArmed('?csgfault=intersection:1');

    expect(() => csgFault('intersection')).toThrow();
    expect(() => csgFault('intersection')).not.toThrow();

    resetCsgFaults();

    expect(() => csgFault('intersection')).toThrow();
  });

  it('resetCsgFaults re-states the notice after an artwork load cleared it', async () => {
    const { resetCsgFaults, WARNINGS } = await loadArmed('?csgfault=difference');
    expect(WARNINGS.length).toBeGreaterThan(0);

    WARNINGS.length = 0; // what clearWarnings() does when an SVG lands
    resetCsgFaults();

    expect(messages(WARNINGS)).toMatch(/fault injection is armed/i);
  });
});

describe('csgFault rejects bad input rather than silently doing nothing', () => {
  it('names the valid points for an unknown one, and stays inert', async () => {
    const { csgFault, WARNINGS } = await loadArmed('?csgfault=nonesuch');

    expect(() => csgFault('difference')).not.toThrow();
    expect(messages(WARNINGS)).toContain('Unknown ?csgfault=nonesuch');
    expect(messages(WARNINGS)).toContain('color-union');
    expect(messages(WARNINGS)).toContain('intersection');
  });

  it.each(['difference:0', 'difference:-1', 'difference:abc'])(
    'asks for a positive count and stays inert for ?csgfault=%s',
    async (raw) => {
      const { csgFault, WARNINGS } = await loadArmed(`?csgfault=${raw}`);

      expect(() => csgFault('difference')).not.toThrow();
      expect(messages(WARNINGS)).toContain('needs a positive count after the colon');
    },
  );

  it('is inert for a valid point that is not the armed one, even with a count', async () => {
    const { csgFault } = await loadArmed('?csgfault=body-mesh:3');

    expect(() => csgFault('part-union')).not.toThrow();
    expect(() => csgFault('body-mesh')).toThrow();
  });
});
