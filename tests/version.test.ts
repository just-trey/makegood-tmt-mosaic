import { describe, expect, it } from 'vitest';
import { getAppVersion } from '../src/version';

describe('getAppVersion', () => {
  it('falls back to dev when no build-time version is available', () => {
    expect(getAppVersion(undefined)).toBe('dev');
  });

  it('uses the provided build-time version when available', () => {
    expect(getAppVersion('1.2.3')).toBe('1.2.3');
  });
});
