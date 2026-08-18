import { beforeEach, describe, expect, it } from 'vitest';
import {
  armCancel,
  cancelRequested,
  RebuildCancelled,
  requestCancel,
  throwIfCancelled,
} from '../src/cancel';

describe('rebuild cancellation', () => {
  beforeEach(() => armCancel());

  it('does nothing until asked', () => {
    expect(cancelRequested()).toBe(false);
    expect(() => throwIfCancelled()).not.toThrow();
  });

  it('throws a distinguishable error once asked', () => {
    requestCancel();
    expect(cancelRequested()).toBe(true);
    // Distinguishable is the point: the scheduler reports a real failure and stays quiet about a
    // cancel, so a bare Error here would put a "Rebuild failed" pill in front of someone who
    // pressed Cancel.
    expect(() => throwIfCancelled()).toThrow(RebuildCancelled);
  });

  it('is re-armed by the next rebuild, not left latched', () => {
    requestCancel();
    armCancel();
    expect(cancelRequested()).toBe(false);
    // A latched flag would abort every rebuild after the first cancel, at the first safe point,
    // leaving the app unable to build anything until reload.
    expect(() => throwIfCancelled()).not.toThrow();
  });
});
