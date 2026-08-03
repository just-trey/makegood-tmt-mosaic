import { describe, expect, it } from 'vitest';
import { MAX_WORKING_EDGE, isRasterBuffer, workingSize } from '../src/raster/decode';

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
    expect(workingSize(4000, 3000)).toEqual({ w: MAX_WORKING_EDGE, h: (MAX_WORKING_EDGE * 3) / 4 });
    expect(workingSize(1000, 4000)).toEqual({ w: MAX_WORKING_EDGE / 4, h: MAX_WORKING_EDGE });
  });

  it('never upscales a small image', () => {
    expect(workingSize(64, 32)).toEqual({ w: 64, h: 32 });
  });

  it('keeps a degenerate edge at one pixel rather than zero', () => {
    expect(workingSize(4000, 1).h).toBe(1);
  });
});
