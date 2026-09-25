// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/warningsView', () => ({ renderWarnings: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({
  showOverlay: vi.fn(),
  hideOverlay: vi.fn(),
  updateOverlay: vi.fn(),
}));

import { rebuildSettled, scheduleRebuild, setRebuildHandler } from '../src/app/scheduler';

/**
 * A re-trace costs ~830ms on a photograph, so the rebuild runs one only on a pass the edits have
 * stopped feeding. "Settled" is the scheduler's own typed debounce having fired, not a second timer.
 */
describe('rebuildSettled', () => {
  const seen: boolean[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    seen.length = 0;
    setRebuildHandler(() => {
      seen.push(rebuildSettled());
    });
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('is false on a pass a live edit started', async () => {
    scheduleRebuild();
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([false]);
  });

  it('is true on a pass the typed debounce started', async () => {
    scheduleRebuild('typed');
    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual([true]);
  });

  it('gives a burst of edits one settled pass, after the last of them', async () => {
    // A held spinner or a slider drag: a live pass per step, each finding the floor stale and
    // asking for a settled pass, which the next step's own schedule call then pushes back.
    setRebuildHandler(() => {
      const settled = rebuildSettled();
      seen.push(settled);
      if (!settled) scheduleRebuild('typed');
    });
    for (let step = 0; step < 8; step++) {
      scheduleRebuild();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(seen.filter((s) => s)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600);
    expect(seen.filter((s) => s)).toHaveLength(1);
    expect(seen[seen.length - 1]).toBe(true);

    // And the settled pass does not arm another: nothing more runs however long it is left.
    const passes = seen.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toHaveLength(passes);
  });
});
