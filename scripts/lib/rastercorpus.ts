/**
 * Decodes a corpus of real image files through the app's own decode path, and caches the pixels.
 *
 * A library, not a script. `corpus`, `colors` and `curve` in scripts/bench-raster.ts call
 * `loadCorpus()`, which rebuilds whatever the cache is missing. `scale`, `render` and `alpha` bring
 * their own source. `sizes` is the odd one: it reads file paths out of CORPUS but decodes afresh
 * through `decodeAtEdges`, so it needs the files present and ignores the cache entirely.
 *
 * The `stock` half is fetched rather than committed: run scripts/fetch-raster-stock.mjs first.
 * Delete `stubs/raster-corpus/` to force a full rebuild of the cache.
 *
 * Why a browser is not optional here. Everything downstream of `decodeImageFile` takes a plain
 * RasterImage and runs happily in Node, but the decode itself is `createImageBitmap` plus a canvas
 * drawImage downscale, and `edgeDensity` counts precisely the pixels a resampler invents along a
 * colour boundary. Measuring through a different resampler would produce numbers that describe no
 * shipping code path. So the pixels come out of Chromium, and only the pixels: the statistic, the
 * quantizer and the tracer are the real modules, imported directly.
 *
 * The cache exists because the sweeps re-run far more often than the sources change. It keys on a
 * hash of the source bytes, so editing or replacing a file invalidates its entry and nothing else.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { MAX_WORKING_EDGE, MEASURE_EDGE, workingSize } from '../../src/raster/decode';
import { isPhotographic, measureImage } from '../../src/raster/stats';
import type { RasterImage } from '../../src/raster/types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(REPO, 'stubs', 'raster-corpus');

/**
 * What the file is, which is not the same as what it should read as.
 *
 * A 'middle' entry is allowed either answer. A 'flat' or 'photo' entry landing on the other side
 * is a **mismatch**, and the bench prints it as one. It is deliberately not called a defect: the
 * corpus photograph is a balloon against a clear sky, so its flat reading is a mismatch and the
 * correct treatment at once. One standing mismatch is expected and named in the bench footer, so a
 * second one is visible as new.
 */
export type CorpusGroup = 'flat' | 'photo' | 'middle';

/**
 * Where a source came from, kept separate from what it is.
 *
 * `stock` files are CC-licensed Commons originals fetched by scripts/fetch-raster-stock.mjs. They
 * are real photographs and fine for asking whether the statistic *can* score a busy image high.
 * They are not a sample of what a volunteer uploads, and curated photography skews toward shallow
 * depth of field and heavy noise reduction, both of which lower edge density. Reporting them
 * mixed with `real` files would let that skew masquerade as a result.
 */
export type Provenance = 'real' | 'stock' | 'authored';

export interface CorpusSource {
  name: string;
  provenance: Provenance;
  group: CorpusGroup;
  /** Repo-relative path, or a recipe when the file is derived from another source. */
  file?: string;
  /** Re-encode recipe. `quality` and the `.jpg` container are what `as` selects today. */
  derive?: { from: string; as: 'jpeg'; quality: number };
  /** Long edge to rasterize at. SVG only, where the file names millimetres and not pixels. */
  renderEdge?: number;
  /**
   * Palette size this source is actually right at, judged by eye against the file.
   *
   * The curve sweep needs it. Running every source at one blanket palette size measures whichever
   * of them that size happens to over-quantize: at 8 colors the cow pattern is 394 fringe specks,
   * and a sweep over those reports on speck outlines rather than on the artwork.
   */
  colors: number;
  note: string;
}

/**
 * The corpus.
 *
 * Provenance matters more than size here: `stubs/` is gitignored, so a clean checkout cannot
 * rebuild the half that came off a phone or out of a browser. Anything under `public/` is in the
 * repo and always reproducible, and the derived entries are recipes rather than files. What that
 * leaves unreproducible is named in the findings report rather than papered over.
 */
export const CORPUS: CorpusSource[] = [
  // Flat art. The end of the range the thresholds must never misread.
  {
    name: 'pattern-cow',
    provenance: 'real',
    colors: 4,
    group: 'flat',
    file: 'public/patterns/cow.svg',
    renderEdge: 1024,
    note: 'shipped pattern, two colors, large blobs',
  },
  {
    name: 'pattern-dalmatian',
    provenance: 'real',
    colors: 4,
    group: 'flat',
    file: 'public/patterns/dalmatian.svg',
    renderEdge: 1024,
    note: 'shipped pattern, two colors, many small spots',
  },
  {
    name: 'pattern-zebra',
    provenance: 'real',
    colors: 4,
    group: 'flat',
    file: 'public/patterns/zebra.svg',
    renderEdge: 1024,
    note: 'shipped pattern, two colors, thin stripes (densest of the four)',
  },
  {
    name: 'pattern-tiger',
    provenance: 'real',
    colors: 4,
    group: 'flat',
    file: 'public/patterns/tiger.svg',
    renderEdge: 1024,
    note: 'shipped pattern, two colors, tapered stripes',
  },
  {
    name: 'makegood-logo',
    provenance: 'real',
    colors: 3,
    group: 'flat',
    file: 'public/assets/makegood-logo.png',
    note: 'shipped logo, anti-aliased PNG with alpha',
  },
  {
    name: 'red-sox-logo',
    provenance: 'real',
    colors: 4,
    group: 'flat',
    file: 'stubs/raster test/Boston_Red_Sox.webp',
    note: 'three real colors, the halo case in the Colors section',
  },
  {
    name: 'cartoon',
    provenance: 'real',
    colors: 6,
    group: 'flat',
    file: 'stubs/raster test/cartoon cahrater.svg.webp',
    note: 'five-color cartoon, traces cleanly at 6',
  },
  {
    name: 'mario',
    provenance: 'real',
    colors: 8,
    group: 'flat',
    file: 'stubs/mario.png',
    note: '1588x1176 nine-color cartoon, the source the detail pass was tuned on',
  },

  // The hard middle. Each of these is here because it could plausibly land on either side.
  {
    name: 'ui-screenshot',
    provenance: 'real',
    colors: 6,
    group: 'middle',
    file: 'stubs/ux-review-shots/01-first-paint.png',
    note: 'the app itself at 1440x900: flat UI panels plus a shaded 3D viewport',
  },
  {
    name: 'kid-drawing',
    provenance: 'real',
    colors: 6,
    group: 'middle',
    file: 'stubs/raster test/kid-drawing.webp',
    note: 'scanned crayon, flat intent with paper texture under it',
  },
  {
    name: 'gradient-illustration',
    provenance: 'authored',
    colors: 6,
    group: 'middle',
    file: 'stubs/raster-corpus/src/gradient-illustration.svg',
    renderEdge: 1024,
    note: 'authored for this bench, smooth gradients with hard-edged shapes over them',
  },
  // The photograph. Ordered before the entry derived from it: a derived source is re-encoded from
  // the bytes of its parent, so the parent has to have been read by the time it is reached.
  {
    name: 'photo',
    provenance: 'real',
    colors: 8,
    group: 'photo',
    file: 'stubs/raster test/photo.webp',
    note: 'the corpus photograph',
  },

  // Licensed Commons photographs, fetched by scripts/fetch-raster-stock.mjs. Here to answer one
  // narrow question the single corpus photograph cannot: can edge density score a busy photograph
  // high at all? They cannot say where the photo cluster sits for this app's users.
  {
    name: 'stock-gravel',
    provenance: 'stock',
    colors: 8,
    group: 'photo',
    file: 'stubs/raster stock/gravel.jpg',
    note: 'pure high-frequency texture, the strongest test of the statistic',
  },
  {
    name: 'stock-foliage',
    provenance: 'stock',
    colors: 8,
    group: 'photo',
    file: 'stubs/raster stock/foliage.jpg',
    note: 'busy natural scene with no flat field anywhere',
  },
  {
    name: 'stock-brick',
    provenance: 'stock',
    colors: 8,
    group: 'photo',
    file: 'stubs/raster stock/brick.jpg',
    note: 'regular mid-frequency texture',
  },
  {
    name: 'stock-crowd',
    provenance: 'stock',
    colors: 8,
    group: 'photo',
    file: 'stubs/raster stock/crowd.jpg',
    note: 'busy real scene rather than a texture',
  },
  {
    name: 'stock-night',
    provenance: 'stock',
    colors: 8,
    group: 'photo',
    file: 'stubs/raster stock/night.jpg',
    note: 'low light, sensor noise across the frame',
  },
  {
    name: 'stock-bokeh-food',
    provenance: 'stock',
    colors: 8,
    group: 'photo',
    file: 'stubs/raster stock/bokeh-food.jpg',
    note: 'shallow depth of field, most of the frame defocused',
  },
  {
    name: 'photo-jpeg-q40',
    provenance: 'real',
    colors: 8,
    group: 'middle',
    derive: { from: 'photo', as: 'jpeg', quality: 0.4 },
    note: 'photo re-encoded at quality 40: block artifacts must not read as flat',
  },
];

export interface DecodedSource {
  name: string;
  provenance: Provenance;
  group: CorpusGroup;
  /** See CorpusSource.colors: the palette size this source is right at. */
  colors: number;
  note: string;
  srcW: number;
  srcH: number;
  /** The MEASURE_EDGE draw, which is what `edgeDensity` is measured on. */
  measure: RasterImage;
  /** What `decodeImageFile` would hand the pipeline: the 1024 draw, or the 512 one for a photo. */
  working: RasterImage;
  edgeDensity: number;
  photographic: boolean;
  /** Group says one thing, the statistic reads the other. See CorpusGroup: not a defect claim. */
  mismatchesGroup: boolean;
  /** Realised downscale from source to working size. 1 means the source was never shrunk. */
  downscale: number;
}

interface ManifestEntry {
  name: string;
  /**
   * Everything the *pixels* depend on: the source bytes, the two decode constants, and the SVG
   * render size. What was decided about those pixels is not in here; it is re-derived and compared
   * on every hit, which is exact where a key would have to sample.
   */
  key: string;
  hash: string;
  srcW: number;
  srcH: number;
  edgeDensity: number;
  photographic: boolean;
  downscale: number;
  measure: { w: number; h: number };
  working: { w: number; h: number };
}

const b64ToPixels = (b64: string) => new Uint8ClampedArray(Buffer.from(b64, 'base64'));

/**
 * Draw a source at a given long edge and hand back raw RGBA.
 *
 * Runs as one page function rather than several so a single bitmap decode serves both draws. SVG
 * goes through an <img> because `createImageBitmap` on an SVG blob is not reliable in Chromium,
 * and an SVG that names its size in millimetres has an intrinsic pixel size far below anything a
 * user would export, hence `renderEdge`.
 */
interface DrawArgs {
  b64: string;
  mime: string;
  edges: number[];
  renderEdge: number;
}

interface DrawResult {
  srcW: number;
  srcH: number;
  draws: Record<string, { w: number; h: number; b64: string }>;
}

/**
 * Draw a source at each requested long edge and hand back raw RGBA.
 *
 * One page function rather than several so a single bitmap decode serves every draw. SVG goes
 * through an <img> because `createImageBitmap` on an SVG blob is not reliable in Chromium, and an
 * SVG that names its size in millimetres has an intrinsic pixel size far below anything a user
 * would export, which is what `renderEdge` overrides.
 *
 * Everything it needs is inlined: Playwright serializes this with toString(), so a reference to
 * anything outside the body would arrive undefined in the browser.
 */
async function drawInPage({ b64, mime, edges, renderEdge }: DrawArgs): Promise<DrawResult> {
  const b64encode = (bytes: Uint8Array | Uint8ClampedArray) => {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK)
      s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(s);
  };
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });

  let source: CanvasImageSource & { close?: () => void };
  let srcW: number;
  let srcH: number;
  if (mime === 'image/svg+xml') {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('the browser could not render this SVG'));
      img.src = URL.createObjectURL(blob);
    });
    const natural = Math.max(img.naturalWidth, img.naturalHeight) || renderEdge;
    const k = renderEdge / natural;
    srcW = Math.round(img.naturalWidth * k);
    srcH = Math.round(img.naturalHeight * k);
    // Baked to pixels at renderEdge before anything downstream resamples it. Handing the <img>
    // straight to drawImage rasterizes the SVG at the *destination* size, which is crisp vector
    // output at every size and not what a user's exported PNG does. That made renderEdge affect
    // only the bookkeeping: every request at or above the draw size returned the same pixels.
    const baked = document.createElement('canvas');
    baked.width = srcW;
    baked.height = srcH;
    const bakedCtx = baked.getContext('2d', { willReadFrequently: true })!;
    bakedCtx.imageSmoothingEnabled = true;
    bakedCtx.imageSmoothingQuality = 'high';
    bakedCtx.drawImage(img, 0, 0, srcW, srcH);
    source = baked;
  } else {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    source = bitmap;
    srcW = bitmap.width;
    srcH = bitmap.height;
  }

  const draws: DrawResult['draws'] = {};
  for (const edge of edges) {
    const scale = Math.min(1, edge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    draws[String(edge)] = { w, h, b64: b64encode(ctx.getImageData(0, 0, w, h).data) };
  }
  source.close?.();
  return { srcW, srcH, draws };
}

/** Re-encode a source as a lossy JPEG, in the browser, and hand back the file bytes. */
async function reencodeInPage({
  b64,
  mime,
  quality,
}: {
  b64: string;
  mime: string;
  quality: number;
}): Promise<string> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), {
    imageOrientation: 'from-image',
  });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('the browser refused to encode a JPEG');
  const out = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < out.length; i += CHUNK)
    s += String.fromCharCode(...out.subarray(i, i + CHUNK));
  return btoa(s);
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
};

const hashOf = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

function sourceBytes(src: CorpusSource): Uint8Array {
  const abs = path.join(REPO, src.file!);
  if (!existsSync(abs)) throw new Error(`${src.name}: no such file ${src.file}`);
  return new Uint8Array(readFileSync(abs));
}

/**
 * The gradient illustration, authored here rather than sourced.
 *
 * Every other middle entry is a real file. This one is not, and the report says so: the corpus had
 * no gradient-heavy artwork and a smooth ramp under hard-edged shapes is the specific structure
 * the edge-density statistic has no answer for, since the gradient's banding reads as transitions
 * everywhere while the shapes over it read as flat art.
 */
const GRADIENT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2a6b"/><stop offset="0.55" stop-color="#e2578a"/>
      <stop offset="1" stop-color="#ffcf6b"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.62" r="0.42">
      <stop offset="0" stop-color="#fff6d8"/><stop offset="1" stop-color="#ffcf6b" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#20406e"/><stop offset="1" stop-color="#0a1730"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#sky)"/>
  <circle cx="512" cy="636" r="430" fill="url(#glow)"/>
  <circle cx="512" cy="600" r="132" fill="#fff3cf"/>
  <rect y="700" width="1024" height="324" fill="url(#sea)"/>
  <path d="M0 700 L210 470 L330 700 Z" fill="#141d33"/>
  <path d="M280 700 L520 400 L700 700 Z" fill="#1d2942"/>
  <path d="M640 700 L840 505 L1010 700 Z" fill="#141d33"/>
  <path d="M0 790 h1024 v14 h-1024 Z" fill="#f2f2f2" opacity="0.5"/>
</svg>
`;

const readBin = (stem: string) =>
  new Uint8ClampedArray(readFileSync(path.join(CACHE, `${stem}.bin`)));

const writeBin = (stem: string, data: Uint8ClampedArray) =>
  writeFileSync(
    path.join(CACHE, `${stem}.bin`),
    Buffer.from(data.buffer, data.byteOffset, data.length),
  );

/**
 * Expand a selection to include anything it derives from, keeping CORPUS order.
 *
 * A selection has to be honoured before decoding, not after: `sourceBytes` throws on the first
 * absent file, so filtering afterwards means a clean checkout cannot run even the sources that are
 * in the repo.
 */
function selected(only?: string[]): CorpusSource[] {
  if (!only?.length) return CORPUS;
  const unknown = only.filter((n) => !CORPUS.some((s) => s.name === n));
  if (unknown.length)
    throw new Error(
      `no corpus source named ${unknown.join(', ')}. Known: ${CORPUS.map((s) => s.name).join(', ')}`,
    );
  // Walked to a fixed point, not one level: a chain two deep would otherwise drop its grandparent
  // and then fail with an ordering error blaming an order that is correct.
  const want = new Set(only);
  for (let grew = true; grew;) {
    grew = false;
    for (const src of CORPUS)
      if (want.has(src.name) && src.derive && !want.has(src.derive.from)) {
        want.add(src.derive.from);
        grew = true;
      }
  }
  return CORPUS.filter((s) => want.has(s.name));
}

/**
 * Write the sources this file generates rather than reads.
 *
 * Exported because `sizes` reads the same path without going through `decodeAll`, and an
 * `existsSync` check there would happily measure a stale render after GRADIENT_SVG changed. Two
 * modes reporting on two different pictures is the hazard `renderEdge` was threaded through
 * `decodeAtEdges` to close, and this is the same hazard by another route.
 */
export function writeAuthoredSources(): void {
  mkdirSync(path.join(CACHE, 'src'), { recursive: true });
  writeFileSync(path.join(CACHE, 'src', 'gradient-illustration.svg'), GRADIENT_SVG);
}

async function decodeAll(only?: string[]): Promise<DecodedSource[]> {
  const asked = selected(only);
  // Before the existence check below, not after it: the authored source's `file` is a path this
  // module writes, so computing "missing" first classifies it as absent on a clean checkout. An
  // unfiltered run then dropped it for one run and healed on the next, and a filtered run threw
  // and never healed, because the throw came before the write.
  writeAuthoredSources();
  // Most of this corpus is not in the repo. `stubs/` is gitignored, so the stock half needs
  // fetching and the private half (a phone photo, a scan, a screenshot) cannot be recovered at
  // all. Only the `public/` sources and the authored SVG survive a clean checkout. So a missing
  // file is the normal state, not an error, and taking the whole run down for one of them would
  // make the bench unusable for anyone but this machine.
  //
  // Named explicitly, though, silence would be the wrong answer: that is someone asking for a
  // specific source and getting a different one's numbers.
  // Keyed on where the file lives, not on provenance: `real` covers both repo-tracked sources
  // under public/ and gitignored ones under stubs/, so a missing pattern would otherwise be
  // reported as unrecoverable when the checkout is simply incomplete.
  const advice = (s: CorpusSource) =>
    s.provenance === 'stock'
      ? 'fetched, not committed: run `node scripts/fetch-raster-stock.mjs`'
      : s.provenance === 'authored'
        ? 'generated by this module; delete stubs/raster-corpus/ and re-run to rebuild it'
        : s.file?.startsWith('stubs/')
          ? 'lives in gitignored stubs/ and cannot be rebuilt from a clean checkout'
          : 'should be committed under this path, so the checkout is incomplete';
  const missing = asked.filter((s) => s.file && !existsSync(path.join(REPO, s.file)));
  if (missing.length && only?.length)
    throw new Error(
      missing.map((s) => `${s.name} is missing at ${s.file}: ${advice(s)}.`).join('\n'),
    );
  // stdout, not stderr: these tables are redirected into findings reports, and a notice that the
  // corpus is incomplete has to travel with the numbers it qualifies. On stderr it survives on a
  // terminal and vanishes into a file, which is the case that matters.
  if (missing.length)
    console.log(
      `note: skipping ${missing.length} source(s) not present: ` +
        missing.map((s) => s.name).join(', ') +
        `\n      ${[...new Set(missing.map(advice))].join('\n      ')}`,
    );
  // A derived entry is re-encoded from its parent's bytes, so a skipped parent takes its children
  // with it. Walked to a fixed point for the same reason `selected` expands the other direction.
  const skip = new Set(missing.map((s) => s.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const s of asked)
      if (s.derive && skip.has(s.derive.from) && !skip.has(s.name)) {
        skip.add(s.name);
        grew = true;
      }
  }
  const orphaned = asked.filter((s) => s.derive && skip.has(s.name) && !missing.includes(s));
  if (orphaned.length)
    console.log(
      `      also skipping ${orphaned.map((s) => s.name).join(', ')}, derived from a skipped source`,
    );
  const corpus = asked.filter((s) => !skip.has(s.name));

  const manifestPath = path.join(CACHE, 'manifest.json');
  const cached: Record<string, ManifestEntry> = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {};

  // Launched on first use rather than from a predicate about what looks stale. The predicate is
  // the bug: it has to agree with every branch below about what counts as a cache hit, and when it
  // disagrees the result is a null-page crash rather than a slow run.
  const held: { browser: Browser | null; page: Page | null } = { browser: null, page: null };
  const getPage = async () => {
    if (!held.page) {
      held.browser = await chromium.launch();
      held.page = await held.browser.newPage();
    }
    return held.page;
  };

  const keyOf = (src: CorpusSource, hash: string) =>
    hashOf(
      Buffer.from(
        [hash, MEASURE_EDGE, MAX_WORKING_EDGE, src.renderEdge ?? MAX_WORKING_EDGE].join('|'),
      ),
    );

  const out: DecodedSource[] = [];
  // Seeded from what was already cached so a filtered run does not drop everyone else's entry.
  const manifest: Record<string, ManifestEntry> = { ...cached };
  const resolved = new Map<string, Uint8Array>();

  try {
    for (const src of corpus) {
      let bytes: Uint8Array;
      if (src.derive) {
        const from = resolved.get(src.derive.from);
        if (!from)
          throw new Error(
            `${src.name} derives from ${src.derive.from}, which must appear before it in CORPUS`,
          );
        const fromSrc = CORPUS.find((s) => s.name === src.derive!.from)!;
        // A derived parent has no file of its own, so it carries the JPEG type it was encoded as.
        const fromMime = fromSrc.file
          ? MIME[path.extname(fromSrc.file).toLowerCase()]
          : 'image/jpeg';
        // Named for the parent's hash, so re-encoding follows the source it was derived from
        // rather than surviving a change to it under a stable filename.
        const cachedFile = path.join(
          CACHE,
          'src',
          `${src.name}.${hashOf(from)}.q${Math.round(src.derive.quality * 100)}.jpg`,
        );
        if (existsSync(cachedFile)) {
          bytes = new Uint8Array(readFileSync(cachedFile));
        } else {
          const b64 = await (
            await getPage()
          ).evaluate(reencodeInPage, {
            b64: Buffer.from(from).toString('base64'),
            mime: fromMime,
            quality: src.derive.quality,
          });
          bytes = new Uint8Array(Buffer.from(b64, 'base64'));
          writeFileSync(cachedFile, bytes);
        }
      } else {
        bytes = sourceBytes(src);
      }
      resolved.set(src.name, bytes);

      const hash = hashOf(bytes);
      const key = keyOf(src, hash);
      const hit = cached[src.name];
      const onDisk =
        hit?.key === key &&
        existsSync(path.join(CACHE, `${src.name}.measure.bin`)) &&
        existsSync(path.join(CACHE, `${src.name}.working.bin`));

      // One object rather than four bindings so the two paths are provably exhaustive.
      let draws: { measure: RasterImage; working: RasterImage; srcW: number; srcH: number } | null =
        null;

      if (onDisk) {
        // Which draw was kept as `working` was decided by measureImage and isPhotographic at write
        // time, and neither is in the key: the key covers what the *pixels* depend on, not what was
        // decided about them. Recomputing the statistic on the cached measure pixels catches a
        // retune of either one exactly, with no constant to sample and no sampling step to be finer
        // than. Retuning EDGE_BUCKET_SHIFT is a change this bench argues for, and without this an
        // entry would stay "fresh" while `working` came off disk from the old decision.
        const cachedMeasure = { ...hit.measure, data: readBin(`${src.name}.measure`) };
        const nowDensity = measureImage(cachedMeasure).edgeDensity;
        if (nowDensity === hit.edgeDensity && isPhotographic(nowDensity) === hit.photographic)
          draws = {
            measure: cachedMeasure,
            working: { ...hit.working, data: readBin(`${src.name}.working`) },
            srcW: hit.srcW,
            srcH: hit.srcH,
          };
      }

      if (!draws) {
        const ext = src.derive ? '.jpg' : path.extname(src.file!).toLowerCase();
        const res = await (
          await getPage()
        ).evaluate(drawInPage, {
          b64: Buffer.from(bytes).toString('base64'),
          mime: MIME[ext],
          edges: [MEASURE_EDGE, MAX_WORKING_EDGE],
          renderEdge: src.renderEdge ?? MAX_WORKING_EDGE,
        });
        const m = res.draws[String(MEASURE_EDGE)];
        const drawn: RasterImage = { w: m.w, h: m.h, data: b64ToPixels(m.b64) };
        const big = res.draws[String(MAX_WORKING_EDGE)];
        const kept = isPhotographic(measureImage(drawn).edgeDensity)
          ? drawn
          : { w: big.w, h: big.h, data: b64ToPixels(big.b64) };
        writeBin(`${src.name}.measure`, drawn.data);
        writeBin(`${src.name}.working`, kept.data);
        draws = { measure: drawn, working: kept, srcW: res.srcW, srcH: res.srcH };
      }

      const { srcW, srcH } = draws;
      let { measure, working } = draws;

      const edgeDensity = measureImage(measure).edgeDensity;
      const photographic = isPhotographic(edgeDensity);
      // Carried the way decode.ts carries it: re-measuring the working image would read a
      // different number, which is the whole reason RasterImage has the field.
      measure = { ...measure, edgeDensity };
      working = { ...working, edgeDensity };
      const fit = workingSize(srcW, srcH, photographic ? MEASURE_EDGE : MAX_WORKING_EDGE);
      const downscale = Math.max(srcW, srcH) / Math.max(fit.w, fit.h);

      out.push({
        name: src.name,
        provenance: src.provenance,
        group: src.group,
        colors: src.colors,
        note: src.note,
        srcW,
        srcH,
        measure,
        working,
        edgeDensity,
        photographic,
        mismatchesGroup: src.group !== 'middle' && photographic !== (src.group === 'photo'),
        downscale,
      });
      manifest[src.name] = {
        name: src.name,
        key,
        hash,
        srcW,
        srcH,
        edgeDensity,
        photographic,
        downscale,
        measure: { w: measure.w, h: measure.h },
        working: { w: working.w, h: working.h },
      };
    }
  } finally {
    // In the finally, not after the try: a throw on a later source would otherwise discard the
    // bookkeeping for every source already decoded, so the next run repeats the whole browser
    // pass. That is the clean-checkout case, where one absent file is normal.
    if (Object.keys(manifest).length)
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await held.browser?.close();
  }

  return out;
}

export const loadCorpus = decodeAll;

/**
 * Decode one arbitrary file at a chosen long edge, for the downscale ladder.
 *
 * Separate from the corpus cache on purpose: the ladder asks what a source measures at sizes it
 * would never actually be worked at, so caching those under a source's name would put numbers in
 * the cache that no shipping path produces.
 */
export type EdgeDecode = { srcW: number; srcH: number; images: Map<number, RasterImage> };

/**
 * The ladder for several files, on one browser.
 *
 * `decodeAtEdges` launches and closes Chromium per call, which is right for a single source and
 * wrong for a five-source table: the launches dominate, and every other multi-source path in this
 * module already holds one browser open.
 */
export async function decodeManyAtEdges(
  files: { file: string; renderEdge?: number }[],
  edges: number[],
): Promise<EdgeDecode[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const out: EdgeDecode[] = [];
    for (const { file, renderEdge } of files)
      out.push(await drawLadder(page, file, edges, renderEdge));
    return out;
  } finally {
    await browser.close();
  }
}

async function drawLadder(
  page: Page,
  file: string,
  edges: number[],
  renderEdge?: number,
): Promise<EdgeDecode> {
  const bytes = new Uint8Array(readFileSync(path.join(REPO, file)));
  const res = await page.evaluate(drawInPage, {
    b64: Buffer.from(bytes).toString('base64'),
    mime: MIME[path.extname(file).toLowerCase()],
    edges,
    // An SVG entry pins its own render size in CORPUS. Defaulting to the widest rung here would
    // bake a vector at a size the corpus never uses, so the two tables would disagree.
    renderEdge: renderEdge ?? Math.max(...edges),
  });
  const images = new Map<number, RasterImage>();
  for (const edge of edges) {
    const d = res.draws[String(edge)];
    images.set(edge, { w: d.w, h: d.h, data: b64ToPixels(d.b64) });
  }
  return { srcW: res.srcW, srcH: res.srcH, images };
}

export async function decodeAtEdges(
  file: string,
  edges: number[],
  renderEdge?: number,
): Promise<EdgeDecode> {
  return (await decodeManyAtEdges([{ file, renderEdge }], edges))[0];
}

/**
 * Rasterize one vector source at several sizes, each rendered rather than resampled.
 *
 * `decodeAtEdges` draws once and shrinks, which is what a user's file does. This draws afresh at
 * every size, which is what choosing an export resolution does, and the two are not the same
 * picture: a stripe rendered at 256px is crisp, the same stripe shrunk from 1024px is not.
 */
export async function renderAtEdges(
  file: string,
  edges: number[],
): Promise<Map<number, { image: RasterImage; srcW: number; srcH: number }>> {
  const bytes = new Uint8Array(readFileSync(path.join(REPO, file)));
  const b64 = Buffer.from(bytes).toString('base64');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const out = new Map<number, { image: RasterImage; srcW: number; srcH: number }>();
    for (const edge of edges) {
      const res = await page.evaluate(drawInPage, {
        b64,
        mime: MIME[path.extname(file).toLowerCase()],
        edges: [Math.min(edge, MEASURE_EDGE)],
        renderEdge: edge,
      });
      const d = res.draws[String(Math.min(edge, MEASURE_EDGE))];
      out.set(edge, {
        image: { w: d.w, h: d.h, data: b64ToPixels(d.b64) },
        srcW: res.srcW,
        srcH: res.srcH,
      });
    }
    return out;
  } finally {
    await browser.close();
  }
}
