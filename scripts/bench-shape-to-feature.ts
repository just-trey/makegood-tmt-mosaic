// Measures the O(n²·len) containment-resolution cost in shapeToFeature (src/geometry/regions.ts)
// against real SVG files. Run with: node_modules/.bin/vite-node scripts/bench-shape-to-feature.ts <file-or-dir> ...
//
// For each top-level <path> element it reports subpath count, total flattened point count,
// an estimated cost (subpath_count² × avg_subpath_len — the shape of the n²·len containment
// loop in shapeToFeature), and the actual measured wall-clock time spent inside the real
// shapeToFeature() call, so the formula can be checked against ground truth.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { parsePathD } from '../src/svg/path';
import { shapeToFeature } from '../src/geometry/regions';
import type { SVGShape, Loop } from '../src/types';

interface PathStat {
  file: string;
  pathIndex: number;
  subpaths: number;
  totalPoints: number;
  avgSubpathLen: number;
  estimatedCost: number;
  measuredMs: number;
}

function extractPathDs(svgText: string): string[] {
  const ds: string[] = [];
  const re = /<path\b[^>]*\bd\s*=\s*(["'])([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svgText))) {
    ds.push(m[2]);
  }
  return ds;
}

function benchOne(d: string, file: string, pathIndex: number): PathStat | null {
  const loops: Loop[] = parsePathD(d);
  if (!loops.length) return null;
  const subpaths = loops.length;
  const totalPoints = loops.reduce((sum, l) => sum + l.length, 0);
  const avgSubpathLen = totalPoints / subpaths;
  const estimatedCost = subpaths * subpaths * avgSubpathLen;

  const shape: SVGShape = { fill: '#000000', loops, order: 0 };

  // Warm up (JIT) with a throwaway call, then measure a fresh call for ground truth.
  shapeToFeature(shape);
  const t0 = performance.now();
  shapeToFeature(shape);
  const measuredMs = performance.now() - t0;

  return { file, pathIndex, subpaths, totalPoints, avgSubpathLen, estimatedCost, measuredMs };
}

function findSvgFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        const full = join(p, entry.name);
        if (entry.isDirectory()) out.push(...findSvgFiles([full]));
        else if (extname(entry.name).toLowerCase() === '.svg') out.push(full);
      }
    } else if (extname(p).toLowerCase() === '.svg') {
      out.push(p);
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const targets = args.length ? args : ['stubs', 'public/patterns', 'public/templates'];

  const files = findSvgFiles(targets).sort();
  const results: PathStat[] = [];
  const fileTotals = new Map<
    string,
    { measuredMs: number; estimatedCost: number; paths: number }
  >();

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const ds = extractPathDs(text);
    let fMeasured = 0,
      fEstimated = 0,
      fPaths = 0;
    ds.forEach((d, idx) => {
      const stat = benchOne(d, file, idx);
      if (!stat) return;
      results.push(stat);
      fMeasured += stat.measuredMs;
      fEstimated += stat.estimatedCost;
      fPaths += 1;
    });
    if (fPaths)
      fileTotals.set(file, { measuredMs: fMeasured, estimatedCost: fEstimated, paths: fPaths });
  }

  // Per-file summary, worst-to-best by actual measured time.
  const summary = Array.from(fileTotals.entries())
    .map(([file, t]) => ({ file, ...t }))
    .sort((a, b) => b.measuredMs - a.measuredMs);

  const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

  console.log(
    '\nPer-file totals (sum of shapeToFeature() over every <path> in the file), worst-to-best by measured time:\n',
  );
  console.log(['file', 'paths', 'measured_ms', 'estimated_cost'].join('\t'));
  for (const s of summary) {
    console.log([s.file, s.paths, s.measuredMs.toFixed(2), fmtNum(s.estimatedCost)].join('\t'));
  }

  console.log('\nWorst individual <path> elements, worst-to-best by measured time:\n');
  const worst = results
    .slice()
    .sort((a, b) => b.measuredMs - a.measuredMs)
    .slice(0, 20);
  console.log(
    [
      'file',
      'pathIndex',
      'subpaths',
      'totalPoints',
      'avgSubpathLen',
      'estimatedCost',
      'measuredMs',
    ].join('\t'),
  );
  for (const r of worst) {
    console.log(
      [
        r.file,
        r.pathIndex,
        r.subpaths,
        r.totalPoints,
        r.avgSubpathLen.toFixed(1),
        fmtNum(r.estimatedCost),
        r.measuredMs.toFixed(2),
      ].join('\t'),
    );
  }
}

main();
