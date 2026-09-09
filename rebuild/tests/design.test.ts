import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flattenPath } from '../src/design/path';
import { mpArea, ringsToMp, simplifyRing, type Ring } from '../src/design/poly';
import { resolveRegions } from '../src/design/regions';
import { normalizeColor, parseSvg, parseTransform } from '../src/design/svg';

const art = (f: string) => readFileSync(new URL(`../reference/artwork/${f}`, import.meta.url), 'utf8');

describe('path', () => {
  it('flattens lines and closes', () => {
    const s = flattenPath('M0 0 L10 0 L10 10 Z');
    expect(s).toHaveLength(1);
    expect(s[0].closed).toBe(true);
    expect(s[0].points).toEqual([[0, 0], [10, 0], [10, 10]]);
  });
  it('flattens a cubic to within tolerance', () => {
    const s = flattenPath('M0 0 C 0 10, 10 10, 10 0', 0.05);
    expect(s[0].points.length).toBeGreaterThan(8);
    for (const [x, y] of s[0].points) {
      expect(x).toBeGreaterThanOrEqual(-0.01);
      expect(y).toBeLessThanOrEqual(7.6);
    }
  });
  it('flattens arcs to a near-circle', () => {
    const s = flattenPath('M10 0 A10 10 0 1 1 -10 0 A10 10 0 1 1 10 0 Z', 0.02);
    const a = Math.abs(mpArea([[s[0].points]]));
    expect(Math.abs(a - Math.PI * 100) / (Math.PI * 100)).toBeLessThan(0.005);
  });
  it('handles relative and implicit commands', () => {
    const s = flattenPath('m1 1 2 0 0 2 -2 0z');
    expect(s[0].points).toEqual([[1, 1], [3, 1], [3, 3], [1, 3]]);
  });
});

describe('poly', () => {
  const sq = (x: number, y: number, w: number): Ring => [[x, y], [x + w, y], [x + w, y + w], [x, y + w]];
  it('evenodd makes a nested ring a hole', () => {
    const mp = ringsToMp([sq(0, 0, 10), sq(2, 2, 4)], 'evenodd');
    expect(mpArea(mp)).toBeCloseTo(100 - 16, 6);
  });
  it('nonzero fills a same-direction nested ring and holes a reversed one', () => {
    expect(mpArea(ringsToMp([sq(0, 0, 10), sq(2, 2, 4)], 'nonzero'))).toBeCloseTo(100, 6);
    const rev = sq(2, 2, 4).slice().reverse();
    expect(mpArea(ringsToMp([sq(0, 0, 10), rev], 'nonzero'))).toBeCloseTo(84, 6);
  });
  it('simplifies a dense ring', () => {
    const r: Ring = [];
    for (let i = 0; i < 360; i++) r.push([10 * Math.cos((i * Math.PI) / 180), 10 * Math.sin((i * Math.PI) / 180)]);
    const s = simplifyRing(r, 0.1);
    expect(s.length).toBeLessThan(80);
    expect(s.length).toBeGreaterThan(12);
  });
});

describe('svg', () => {
  it('reads the cow pattern at 60 x 60 mm with two colors', () => {
    const d = parseSvg(art('cow.svg'));
    expect(d.widthMm).toBe(60);
    expect(d.heightMm).toBe(60);
    expect(new Set(d.shapes.map((s) => s.color)).size).toBe(2);
    const r = resolveRegions(d.shapes);
    const total = r.regions.reduce((a, c) => a + c.areaMm2, 0);
    expect(total).toBeCloseTo(3600, 0);
    expect(r.warnings).toEqual([]);
  });
  it('skips a gradient fill with a warning and keeps the flat shape', () => {
    const d = parseSvg(art('gradient.svg'));
    expect(d.shapes).toHaveLength(1);
    expect(d.shapes[0].color).toBe('#c1272d');
    expect(d.warnings.some((w) => w.includes('gradient'))).toBe(true);
  });
  it('applies transforms and inherits fill', () => {
    const d = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20"><g fill="red" transform="translate(5 5)"><rect width="10" height="10"/></g></svg>');
    expect(d.shapes[0].color).toBe('#ff0000');
    expect(d.shapes[0].rings[0][0]).toEqual([5, 5]);
  });
  it('scales px documents to mm', () => {
    const d = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#123456"/></svg>');
    expect(d.widthMm).toBeCloseTo(25.4, 5);
    const r = resolveRegions(d.shapes);
    expect(r.regions[0].areaMm2).toBeCloseTo(25.4 * 25.4, 3);
  });
  it('warns when there is no mm size', () => {
    const d = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 50 40"><rect width="50" height="40" fill="#000"/></svg>');
    expect(d.widthMm).toBe(50);
    expect(d.warnings[0]).toContain('50 × 40 mm');
  });
  it('resolves paint order: a later shape hides an earlier one', () => {
    const d = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><rect width="10" height="10" fill="#000"/></svg>');
    const r = resolveRegions(d.shapes);
    expect(r.regions.map((c) => c.color)).toEqual(['#000000']);
    expect(r.hidden).toEqual(['#ffffff']);
  });
  it('normalises colors', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc');
    expect(normalizeColor('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(normalizeColor('url(#g)')).toBeNull();
    expect(normalizeColor('none')).toBeNull();
  });
  it('parses rotate about a point', () => {
    const m = parseTransform('rotate(90 10 10)');
    expect(m[4]).toBeCloseTo(20, 6);
    expect(m[5]).toBeCloseTo(0, 6);
  });
});
