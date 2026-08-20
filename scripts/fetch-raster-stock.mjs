/**
 * Fetch the licensed stock half of the raster corpus from Wikimedia Commons.
 *
 *   node scripts/fetch-raster-stock.mjs
 *
 * The corpus lives in gitignored `stubs/`, which the findings report names as a weakness: a clean
 * checkout cannot rebuild it. This closes that for the stock half only. The private half (a phone
 * photo, a scan, a screenshot) stays unrecoverable, and rastercorpus.ts skips whatever is absent
 * with a notice rather than failing. Titles are pinned, so a re-run fetches the same files, and the
 * provenance sidecar records licence and author per file so the report can cite them without
 * anyone re-deriving it.
 *
 * Commons rather than a stock site on purpose. These are CC-licensed originals at camera
 * resolution with their metadata intact, and the licence permits local use without an API key or
 * an account. What they are NOT is a sample of what a MakeGood volunteer uploads, which is why
 * every entry is tagged `stock` and reported apart from the real files.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'stubs', 'raster stock');
const UA =
  'makegood-tmt-mosaic-bench/0.6 (https://github.com/just-trey/makegood-tmt-mosaic; trey@lazybeagle3d.com)';

/**
 * What each file is here to probe. The reading itself is not asserted here: CORPUS carries the
 * group and scripts/bench-raster.ts does the judging, so a second copy of the expectation would be
 * one that could silently disagree.
 */
const WANTED = [
  {
    local: 'gravel.jpg',
    title: 'Gravel texture at High Easter Essex.jpg',
    note: 'pure high-frequency texture, the strongest test',
  },
  {
    local: 'foliage.jpg',
    title: 'Thick foliage in the Sinharaja Forest Reserve.jpg',
    note: 'busy natural scene, no flat field anywhere',
  },
  {
    local: 'brick.jpg',
    title: 'Brick wall close-up view.jpg',
    note: 'regular mid-frequency texture',
  },
  {
    local: 'crowd.jpg',
    title: 'Busy crowd on Market Place at St Albans Market.jpg',
    note: 'busy real scene rather than a texture',
  },
  {
    local: 'night.jpg',
    title: 'Château Frontenac at night, Quebec Ville, Canada.jpg',
    note: 'low light, sensor noise across the frame',
  },
  {
    local: 'bokeh-food.jpg',
    title: 'Mini donut breakfast portrait and bokeh (13976781295).jpg',
    note: 'shallow depth of field, most of the frame defocused',
  },
];

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const sha1 = (b) => createHash('sha1').update(b).digest('hex');

const api = async (params) => {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok)
    throw new Error(`Commons API ${res.status} for ${params.titles ?? params.gsrsearch}`);
  return res.json();
};

mkdirSync(OUT, { recursive: true });
const provenance = [];

for (const want of WANTED) {
  const data = await api({
    action: 'query',
    format: 'json',
    titles: `File:${want.title}`,
    prop: 'imageinfo',
    iiprop: 'url|size|mime|sha1|extmetadata',
  });
  const page = Object.values(data.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined)
    throw new Error(`no such file on Commons: ${want.title}`);
  const info = page.imageinfo?.[0];
  if (!info) throw new Error(`no imageinfo for ${want.title}`);
  const meta = info.extmetadata ?? {};
  const strip = (v) => (v?.value ?? '').replace(/<[^>]*>/g, '').trim();

  const dest = path.join(OUT, want.local);
  // A cache hit has to be the whole file, not merely a file. A 29MB download interrupted at 3MB
  // leaves something nonempty that every later run would trust, and the corpus would then measure
  // a truncated JPEG under a name that says otherwise.
  const complete =
    existsSync(dest) &&
    statSync(dest).size === info.size &&
    sha1(readFileSync(dest)) === info.sha1 &&
    isJpeg(readFileSync(dest));
  if (complete) {
    console.log(`have  ${want.local}`);
  } else {
    const res = await fetch(info.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`download ${res.status} for ${want.title}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Refuse an HTML error page saved under a .jpg name: the failure that looks like success here
    // is a redirect to a notice page, which downstream would decode as "unsupported format".
    if (!isJpeg(bytes))
      throw new Error(`${want.title} did not come back as JPEG (got ${bytes.length} bytes)`);
    if (bytes.length !== info.size)
      throw new Error(
        `${want.title} is ${bytes.length} bytes, Commons says ${info.size}. Truncated download.`,
      );
    // Checksummed, not merely sized. Titles are pinned but revisions are not: Commons lets a file
    // be re-uploaded under the same name, which would silently swap a measured corpus source.
    // Recording the hash means a swap shows up as a mismatch here rather than as a moved number in
    // a findings report.
    if (sha1(bytes) !== info.sha1)
      throw new Error(
        `${want.title} does not match the sha1 Commons reports (${info.sha1}). The file was ` +
          `probably re-uploaded; check the Commons history before trusting any measurement.`,
      );
    // Written aside then renamed, so an interruption leaves no half file for the check above to
    // have to catch on the next run.
    const tmp = `${dest}.part`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
    console.log(
      `fetch ${want.local}  ${info.width}x${info.height}  ${(bytes.length / 1e6).toFixed(1)}MB`,
    );
  }

  provenance.push({
    local: want.local,
    note: want.note,
    sha1: info.sha1,
    fetched: new Date().toISOString().slice(0, 10),
    title: page.title,
    width: info.width,
    height: info.height,
    licence: strip(meta.LicenseShortName),
    author: strip(meta.Artist),
    descriptionUrl: info.descriptionurl,
  });
}

writeFileSync(path.join(OUT, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(
  `\n${provenance.length} files in ${path.relative(REPO, OUT)}, provenance.json written.`,
);
