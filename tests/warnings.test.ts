import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBuildWarnings,
  clearWarnings,
  notice,
  noticeBuild,
  warn,
  warnBuild,
  WARNINGS,
} from '../src/warnings';

// The bug this pins: nothing cleared a rebuild's own diagnostics between rebuilds, so a
// cut-solid failure from a superseded build (an earlier zone/mode binding) stayed on screen next
// to a later, successful build's output — reading as artwork loss that never actually happened.
describe('clearBuildWarnings', () => {
  beforeEach(() => clearWarnings());

  it('drops build-scoped entries but leaves standing ones in place', () => {
    warn('part fingerprint mismatch');
    warnBuild('cut solid failed on build 1');
    clearBuildWarnings();

    expect(WARNINGS.map((w) => w.message)).toEqual(['part fingerprint mismatch']);
  });

  it("a later build only shows its own diagnostics, not a superseded build's", () => {
    warnBuild('cut solid failed on build 1');
    clearBuildWarnings(); // the next rebuild starts
    warnBuild('build 2 diagnostic');

    expect(WARNINGS.map((w) => w.message)).toEqual(['build 2 diagnostic']);
  });

  it('drops build-scoped infos the same way as build-scoped warnings', () => {
    notice('auto-fit to the part face');
    noticeBuild('would take more than 1024 tiles');
    clearBuildWarnings();

    expect(WARNINGS.map((w) => w.message)).toEqual(['auto-fit to the part face']);
  });

  it('a superseded build warning never reappears once the next build clears it', () => {
    warnBuild('Couldn\'t cut color #1e5fa8 into "Seat back (bottom)". It won\'t print there.');
    clearBuildWarnings(); // the next rebuild starts
    // ...and this time that color's cutter built fine, so nothing re-warns it.
    expect(WARNINGS).toHaveLength(0);
  });
});

describe('clearWarnings', () => {
  it('still resets both standing and build-scoped entries, unchanged from before', () => {
    warn('standing');
    warnBuild('build-scoped');
    clearWarnings();
    expect(WARNINGS).toHaveLength(0);
  });
});
