import { describe, expect, it } from 'vitest';
import { toFiniteInt, toFiniteNumber } from '../src/util/number';

describe('toFiniteNumber', () => {
  it('parses a plain decimal', () => {
    expect(toFiniteNumber('3.5')).toBe(3.5);
  });

  it('returns null for empty, missing or non-numeric input', () => {
    expect(toFiniteNumber('')).toBeNull();
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(undefined)).toBeNull();
    expect(toFiniteNumber('abc')).toBeNull();
  });

  it('rejects Infinity — parseFloat accepts the literal string, a finite check should not', () => {
    expect(toFiniteNumber('Infinity')).toBeNull();
    expect(toFiniteNumber('-Infinity')).toBeNull();
  });
});

describe('toFiniteInt', () => {
  it('parses a whole number', () => {
    expect(toFiniteInt('42')).toBe(42);
  });

  it('defaults to base 10, so a leading zero is not read as octal', () => {
    expect(toFiniteInt('010')).toBe(10);
  });

  it('returns null for empty, missing or non-numeric input', () => {
    expect(toFiniteInt('')).toBeNull();
    expect(toFiniteInt(null)).toBeNull();
    expect(toFiniteInt(undefined)).toBeNull();
    expect(toFiniteInt('abc')).toBeNull();
  });
});
