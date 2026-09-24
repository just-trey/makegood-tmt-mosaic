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

// A keyed push replaces its standing entry; nothing else about push() changes. The first block pins
// what broke the reverted attempt's first round (unkeyed callers overwritten, `build` flipped); the
// by-reference dismiss that broke its second is in warningsView.test.ts.
describe('push: unkeyed callers keep skip-if-present', () => {
  beforeEach(() => clearWarnings());

  it('a second unkeyed push of the same message is skipped, whatever its level', () => {
    warn('same text');
    notice('same text');
    expect(WARNINGS).toEqual([{ message: 'same text', level: 'warn' }]);
  });

  it("a build-scoped push never makes a standing entry build-scoped, so a rebuild can't clear it", () => {
    warn('standing fact');
    warnBuild('standing fact');
    notice('standing info');
    noticeBuild('standing info');
    clearBuildWarnings();
    expect(WARNINGS.map((w) => w.message)).toEqual(['standing fact', 'standing info']);
  });

  it('a standing push never makes a build-scoped entry standing, so a rebuild still clears it', () => {
    warnBuild('build diagnostic');
    warn('build diagnostic');
    noticeBuild('build info');
    notice('build info');
    clearBuildWarnings();
    expect(WARNINGS).toHaveLength(0);
  });

  it('a keyed push does not overwrite an unkeyed entry whose message equals the key', () => {
    warn('source-1');
    notice('something else', 'source-1');
    expect(WARNINGS).toEqual([{ message: 'source-1', level: 'warn' }]);
  });
});

// Mirrors src/ui/artworkListPanel.ts's rasterControls().apply(): a source's capped, traced and
// empty-trace entries share its id as key. push() used to skip a taken key, so a flip only worked
// with dismissNotice() called first; without it the old, now-false text stayed standing.
describe('push: a keyed push replaces the standing entry', () => {
  beforeEach(() => clearWarnings());

  it('flips capped to traced and back with no dismiss in between', () => {
    notice('"img.png" is capped', 'source-1');
    notice('"img.png" traced', 'source-1');
    expect(WARNINGS).toEqual([{ message: '"img.png" traced', level: 'info', key: 'source-1' }]);

    notice('"img.png" is capped', 'source-1');
    expect(WARNINGS).toEqual([{ message: '"img.png" is capped', level: 'info', key: 'source-1' }]);
  });

  it('takes the new level, and keeps its place among the other entries', () => {
    notice('"a.png" traced', 'source-1');
    notice('"b.png" traced', 'source-2');
    warn('No color regions survived tracing "a.png"', 'source-1');
    expect(WARNINGS.map((w) => [w.key, w.level])).toEqual([
      ['source-1', 'warn'],
      ['source-2', 'info'],
    ]);
  });

  it('takes the new scope, so a replaced standing fact does not outlive the build that replaced it', () => {
    notice('standing', 'k');
    noticeBuild('this build only', 'k');
    clearBuildWarnings();
    expect(WARNINGS).toHaveLength(0);

    noticeBuild('this build only', 'k');
    notice('standing', 'k');
    clearBuildWarnings();
    expect(WARNINGS.map((w) => w.message)).toEqual(['standing']);
  });

  it('leaves other keys alone', () => {
    notice('"img.png" traced', 'source-1');
    notice('"img.png" traced', 'source-2');
    notice('"img.png" is capped', 'source-2');
    expect(WARNINGS.map((w) => w.message)).toEqual(['"img.png" traced', '"img.png" is capped']);
  });
});
