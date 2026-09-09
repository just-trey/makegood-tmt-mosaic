import { looksLikePhoto } from './raster';

export interface DecodedImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  photo: boolean;
}

/** Longest edge the trace works at: line art keeps its detail, a photo mostly keeps its noise. */
export const ART_PX = 1024;
export const PHOTO_PX = 512;

/** Decode any image the browser can, and bring it to working size. Browser only. */
export async function decodeImage(dataUrl: string): Promise<DecodedImage> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("This image couldn't be opened. Re-export it as a PNG and try again."));
    el.src = dataUrl;
  });
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error('This image is empty.');
  const probe = draw(img, Math.min(w0, 256), Math.min(h0, 256));
  const photo = looksLikePhoto(probe.data, probe.width, probe.height);
  const maxPx = photo ? PHOTO_PX : ART_PX;
  const k = Math.min(1, maxPx / Math.max(w0, h0));
  const out = draw(img, Math.max(1, Math.round(w0 * k)), Math.max(1, Math.round(h0 * k)));
  return { rgba: out.data, width: out.width, height: out.height, photo };
}

function draw(img: HTMLImageElement, w: number, h: number): ImageData {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No canvas available in this browser.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsDataURL(file);
  });
}

export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsText(file);
  });
}

/** Sniff the real format from the bytes; the extension is not trusted. */
export async function sniffKind(file: File): Promise<'svg' | 'image' | 'unknown'> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const text = new TextDecoder('latin1').decode(head);
  if (head[0] === 0x89 && head[1] === 0x50) return 'image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image';
  if (text.startsWith('GIF8')) return 'image';
  if (text.startsWith('BM')) return 'image';
  if (/<svg|<\?xml|<!DOCTYPE svg/i.test(text)) return 'svg';
  if (/^(II\*\x00|MM\x00\*)/.test(text)) return 'unknown';
  const name = file.name.toLowerCase();
  if (name.endsWith('.svg')) return 'svg';
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(name)) return 'image';
  return 'unknown';
}
