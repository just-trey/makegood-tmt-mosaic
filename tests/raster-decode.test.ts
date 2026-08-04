import { describe, expect, it } from 'vitest';
import { MAX_WORKING_EDGE, MEASURE_EDGE, isRasterBuffer, workingSize } from '../src/raster/decode';
import { isPhotographic } from '../src/raster/stats';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('isRasterBuffer', () => {
  it('recognises PNG, JPEG and WebP from their leading bytes', () => {
    expect(isRasterBuffer(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
    expect(isRasterBuffer(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    const webp = new Uint8Array(12);
    webp.set(ascii('RIFF'), 0);
    webp.set(ascii('WEBP'), 8);
    expect(isRasterBuffer(webp)).toBe(true);
  });

  it('leaves SVG text to the SVG parser', () => {
    expect(isRasterBuffer(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(false);
    expect(isRasterBuffer(ascii('<?xml version="1.0"?><svg/>'))).toBe(false);
  });

  it('does not read past a short buffer', () => {
    expect(isRasterBuffer(bytes())).toBe(false);
    expect(isRasterBuffer(bytes(0x89, 0x50))).toBe(false);
    // RIFF with nothing after it is not a WebP — the container tag is 8 bytes in.
    expect(isRasterBuffer(ascii('RIFF'))).toBe(false);
  });

  // These three mirror the cases the old drag-drop rejection guarded (PR #110, isRasterImage),
  // which sniffed File.type and the extension. Both of those can lie and neither is consulted now;
  // the bytes decide, so a PNG named .svg routes to the decoder instead of to the XML parser.
  it('routes a PNG named .svg to the decoder, not the SVG parser', () => {
    expect(isRasterBuffer(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
  });

  it('routes a JPEG dropped with no MIME type at all', () => {
    expect(isRasterBuffer(bytes(0xff, 0xd8, 0xff, 0xdb))).toBe(true);
  });

  it('leaves a real SVG on the SVG path however it is labelled', () => {
    expect(isRasterBuffer(ascii('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'))).toBe(
      false,
    );
  });
});

describe('workingSize', () => {
  it('caps the long edge and keeps the aspect ratio', () => {
    expect(workingSize(4000, 3000, MAX_WORKING_EDGE)).toEqual({
      w: MAX_WORKING_EDGE,
      h: (MAX_WORKING_EDGE * 3) / 4,
    });
    expect(workingSize(1000, 4000, MAX_WORKING_EDGE)).toEqual({
      w: MAX_WORKING_EDGE / 4,
      h: MAX_WORKING_EDGE,
    });
  });

  it('never upscales a small image', () => {
    expect(workingSize(64, 32, MAX_WORKING_EDGE)).toEqual({ w: 64, h: 32 });
  });

  it('keeps a degenerate edge at one pixel rather than zero', () => {
    expect(workingSize(4000, 1, MAX_WORKING_EDGE).h).toBe(1);
  });

  it('takes the size it is given, which is how flat art and photographs diverge', () => {
    expect(workingSize(4000, 2000, MEASURE_EDGE).w).toBe(MEASURE_EDGE);
    expect(workingSize(4000, 2000, MAX_WORKING_EDGE).w).toBe(MAX_WORKING_EDGE);
    expect(MEASURE_EDGE).toBeLessThan(MAX_WORKING_EDGE);
  });
});

describe('isPhotographic', () => {
  it('sends flat art to the detail pass and photographs to the smaller one', () => {
    // Same fixtures the threshold pair in stats.ts was calibrated against.
    expect(isPhotographic(0.02)).toBe(false);
    expect(isPhotographic(0.05)).toBe(false);
    expect(isPhotographic(0.6)).toBe(true);
    expect(isPhotographic(0.8)).toBe(true);
  });

  it('puts the switch inside the band the trace params blend across', () => {
    // Below the flat endpoint and above the photo endpoint the answer must not be in doubt.
    expect(isPhotographic(0.12)).toBe(false);
    expect(isPhotographic(0.45)).toBe(true);
  });
});
