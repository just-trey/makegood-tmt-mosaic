# Spike: what strands cut pieces off the chart, and how wide the clip should reach

**Refuted: "two simplify passes disagree" is not why cut pieces sat off-surface.** Deriving the dead
region from the claim's own simplified outline still left **15** pieces at least half off their chart
(pre-#301: 14), and the export still cut the 32mm mark on `Wheel mount (left)`. Putting the dead region
exactly on the triangles made it worse: **42**. The cause is the claim overhanging its triangles by up
to `SIMPLIFY_TOL_MM`, so #301 clips the cut region instead. Of the two clip scopes measured, #301 ships
`narrow` (triangles plus the holes the claim closed, on the 12 dead-region charts only). `wide` (every
chart, before the dead subtraction) raised a new "too fine to print" on `Handle (left)` and was rejected.

**Spike, not a plan. The code is not in the tree.** It lived on the local branch `spike-shared-loop`,
which is deleted once this doc merges. The full diff is inlined at the end and applies to `e29c1fd`.

## Run context

| Item              | Value                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Base              | `e29c1fd57b249ffc6e1066bee1365aa4725336a0` (#301, before its round-1 fixes)                                         |
| Spike commits     | `1659b71b021e2cf2115924169a7a65f890eb2506` (f2, rawdead), `bf8c8e15e0f95f696f9af1fd4ee486a1b64ba9ad` (narrow, wide) |
| Reference sidecar | `a91ef30c4e63bfe6762ca06f3b91e5e9adb5ffe2` (last before the clip; the gate's A)                                     |
| Covers file       | `stubs/dead-zones.3mf`, gitignored, sha256 `43f9582a531e4609e22d345be5477c369e31711da6d68ef8d2c2e44ecc5c3847`       |
| Machine           | WSL2 (`6.18.33.2-microsoft-standard-WSL2`), RTX 2060 for the gate                                                   |
| Versions          | node v24.18.0, vite-node 2.1.9, `manifold-3d` 3.5.1, `@turf/turf` 6.5.0                                             |
| Re-run            | 2026-10-04, every number below, in a fresh worktree with its own `npm install`                                      |

- `e29c1fd` is an ancestor of `refs/pull/301/head` (`dfa8127`), so `git fetch origin pull/301/head`
  recovers it after the local branch is gone.
- **The `narrow` bake equals what #301 shipped.** Its sidecar parses equal to `dfa8127`'s and to
  `main`'s at `ff3ddcd` (JSON `==` in Python; the committed file is only prettier-formatted).
- The `''` bake re-derives `e29c1fd`'s committed sidecar exactly, by the same test.

## What each mode changes

All in `bakeZones`, `scripts/lib/zonebake.mjs`. Modes are read from `SPIKE_MODE` at bake time.

| `SPIKE_MODE` | Dead region derived from                        | Dead region re-simplified | Clip after the dead subtraction      | Clip before it (`subRegions`)    |
| ------------ | ----------------------------------------------- | ------------------------- | ------------------------------------ | -------------------------------- |
| pre-#301     | dead set ∩ raw triangles                        | yes                       | none                                 | none                             |
| `''` (base)  | same                                            | yes                       | raw triangles, 12 dead-region charts | none                             |
| `f2`         | dead set ∩ simplified claim (closed holes kept) | **no**                    | none                                 | none                             |
| `rawdead`    | dead set ∩ raw triangles                        | **no**                    | none                                 | none                             |
| `narrow`     | same as base                                    | yes                       | triangles + closed holes, 12 charts  | none                             |
| `wide`       | same as base                                    | yes                       | none                                 | triangles + closed holes, all 26 |

- "Closed holes" are the raw rings of every claim hole failing `isRealHole` (under 15mm² or under 2mm
  mean width): holes the claim fills on purpose.
- `f2` is #301 review finding F2's hypothesis: dead region and claim from one simplify loop, so their
  overhangs agree. `rawdead` is the opposite extreme: no simplify on the dead side at all.
- Every clip is followed by `clipRegionsToChart`'s 0.005mm opening (`CLIP_OPEN_MM`) and the 0.16mm²
  piece floor.

## Results

| Mode      | Cut pieces | ≥50% off-surface (mm²) | Off triangles: dead / coverless mm² | Off filled silhouette: dead / coverless mm² | Pieces reaching >0.2mm | Holes failing `isRealHole` (mm²) | Specks: 12 / 26 charts | Templates changed | Gate exit |
| --------- | ---------- | ---------------------- | ----------------------------------- | ------------------------------------------- | ---------------------- | -------------------------------- | ---------------------- | ----------------- | --------- |
| pre-#301  | 87         | 14 (16.080)            | 211.13 / 649.41                     | 110.87 / 216.64                             | 2                      | 3 (1.51)                         | 6 / 8                  | –                 | (A)       |
| `''` base | 87         | 0                      | 0.48 / 649.41                       | 0.41 / 216.64                               | 0                      | 26 (90.71)                       | 0 / 2                  | 0                 | 0         |
| `f2`      | 77         | **15** (10.082)        | 198.81 / 649.41                     | 99.83 / 216.64                              | 2                      | 3 (1.51)                         | 5 / 7                  | 6                 | 1         |
| `rawdead` | 103        | **42** (43.623)        | 241.82 / 649.41                     | 141.40 / 216.64                             | 2                      | 3 (1.51)                         | 76 / 78                | 6                 | 1         |
| `narrow`  | 82         | **0**                  | 118.63 / 649.41                     | 18.72 / 216.64                              | 2                      | 0                                | 0 / 2                  | 0                 | 0         |
| `wide`    | 77         | 0                      | 118.65 / 435.53                     | 18.73 / 2.76                                | 2                      | 0                                | 1 / 2                  | 9                 | 1         |

Commands, from the spike worktree root (setup under "Rebuild it"):

- **Bake:** `SPIKE_MODE=<mode> npx vite-node scripts/bake-zones.mjs scripts/zone-configs/chair-body.json`,
  then copy `public/stl/chair-body-zones.json` aside. Every bake overwrites it.
- **Pieces through holes:**
  `npx vite-node scripts/_spike-measure.mjs <pre301> <base> <f2> <rawdead> <narrow> <wide>`. The
  pre-#301 file is `git show a91ef30:public/stl/chair-body-zones.json`. Holes are summed from the
  per-chart rows it prints.
- **Specks:** `npx vite-node scripts/_spike-specks-all.ts <sidecar>` (12 charts) and
  `ALL=1 npx vite-node scripts/_spike-specks-all.ts <sidecar>` (26).
- **Templates changed:** `git status --short public/templates | wc -l` right after each bake.
- **Gate:** `npm run build && MOSAIC_GPU=1 npx vite-node scripts/check-cut-ribbon-ink.mjs <outDir> --sidecar=<sidecar>`.
  This is `e29c1fd`'s gate, which judges by inlay vertex count; #301's final gate judges by inlay area.

Reading the columns:

- **"Off filled silhouette"** subtracts the triangles plus every triangle hole failing `isRealHole`, so
  a hole the claim closes on purpose is not counted as overhang.
- **Coverless charts' 649.41mm² shrinks to 216.64mm²** off the filled silhouette: two thirds of that
  tech-debt figure is closed holes.
- **base reopened 26 holes** (`right/chair-wing-right` 18 of them, 77.88mm²), because raw triangles
  have holes the claim closed. That is #301's F1, and why `narrow` adds the closed holes back.
- **f2 lost 10 pieces but stranded 15.** Its dead region follows the simplified claim, so it eats
  different slivers, and specks fall from 6 to 5 rather than to 0.

## The two charts reaching past 0.2mm

`npx vite-node scripts/_spike-deep.mjs <sidecar> left chair-wing-left` (and `right chair-wing-right`)
on the `narrow` sidecar. `f2` prints the same rings.

| Chart                    | Reach (`_spike-measure`) | Rings beyond 0.2mm of the raw triangles                                                    |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| `left/chair-wing-left`   | 0.847mm                  | 2, outside the outer silhouette: 2.5880 and 2.3336mm², v 7.0–10.1                          |
| `right/chair-wing-right` | 0.851mm                  | 2 outside it (2.6306, 2.3297mm², v 6.9–10.0); 25 inside closed triangle holes, v 14.4–18.6 |

- The rings outside the silhouette are triangle holes pinched to the outer edge, which the claim closes.
  They are the four components in
  [findings/2026-09-09-cut-ribbon-offsurface.md](../findings/2026-09-09-cut-ribbon-offsurface.md) and
  the comment at `chartClipSection`'s call in `bakeZones`. Not a new defect.
- The 25 inside closed holes are 0.07–12.26mm² each and drop out of the filled-silhouette measure.

## Where the re-run and #301 disagree

Every #301 number this spike can reach re-derived, except one.

| Number                                   | #301                                   | Re-run 2026-10-04                                                          |
| ---------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| f2 / rawdead, pieces ≥50% off            | 15 / 42                                | 15 / 42                                                                    |
| f2 still cuts the mark                   | "the same mark"                        | gate exit 1: 107 vertices within 6mm, 1.000 x 0.211 x 32.334mm (A: 32.543) |
| shipped, ≥50% off                        | 0 of 82                                | 0 of 82                                                                    |
| pre-#301, ≥50% off                       | 14 (16.08mm²)                          | 14 (16.080mm²)                                                             |
| base failing holes                       | 26 (wing-right 18, 77.88mm²)           | 26 (wing-right 18, 77.88mm²)                                               |
| shipped off triangles, dead / coverless  | 118.63 / 649.41mm²                     | 118.63 / 649.41mm²                                                         |
| `wide`: pieces, templates, gate          | 77, 9 of 11, exit 1 on `Handle (left)` | 77, 9, exit 1 on `Handle (left)`                                           |
| **`wide` specks, 12 dead-region charts** | **0**                                  | **1** (`front/chair-handle-left`)                                          |
| `wide` specks, 26 charts                 | 2, `left/chair-handle-left` 0 → 1      | 2: `left/chair-handle-left` 1, `front/chair-handle-left` 1                 |

- **Not reconciled.** #301 does not record the code its rejected-variant columns ran on. Pre-#301 also
  had one speck on `front/chair-handle-left`, so the re-run's `wide` is no worse than main on that chart.
- Not re-run here: the `wide` chair-zones test failures (`npx vitest run tests/chair-zones.test.ts`),
  recorded in tech-debt.md's coverless-charts section.

## What this does not settle

- **Whether coverless-chart slack prints.** `wide` removes most of it (216.64 → 2.76mm² off the filled
  silhouette) but costs a new notice. The open item is tech-debt.md's "Charts with no dead region keep
  up to 0.2mm of cut region past their triangles".
- **Why 18.72mm² stays off the filled silhouette on the dead-region charts after `narrow`.** It includes
  the pinched notches above; the rest was not decomposed.

## Rebuild it

```bash
git fetch origin pull/301/head
git worktree add .claude/worktrees/spike-clip-scope e29c1fd
cd .claude/worktrees/spike-clip-scope
npm install
mkdir -p stubs && cp <path>/dead-zones.3mf stubs/   # gitignored; check the sha256 above
git apply spike.diff                                  # the block below, saved as spike.diff
```

Then run the commands under "Results". No GPU is needed except for the gate.

<details>
<summary>The whole spike: <code>git diff e29c1fd bf8c8e1</code> (383 lines)</summary>

```diff
diff --git a/scripts/_spike-deep.mjs b/scripts/_spike-deep.mjs
new file mode 100644
index 0000000..5ef1d75
--- /dev/null
+++ b/scripts/_spike-deep.mjs
@@ -0,0 +1,62 @@
+// SPIKE: where is the >0.2mm reach on a chart's biggest piece?
+import { readFileSync } from 'node:fs';
+import { getManifold } from '../src/geometry/manifold';
+
+const wasm = await getManifold();
+const [file, zoneId, partId] = process.argv.slice(2);
+const sc = JSON.parse(readFileSync(file, 'utf8'));
+const c = sc.zones.find((z) => z.id === zoneId).charts.find((ch) => ch.libraryPartId === partId);
+const tri = new wasm.CrossSection(
+  c.chartTris.map((t) => t.map((i) => [c.uv[2 * i], c.uv[2 * i + 1]])),
+  'NonZero',
+);
+const area = (pts) => {
+  let a = 0;
+  for (let i = 0; i < pts.length; i++) {
+    const [x1, y1] = pts[i];
+    const [x2, y2] = pts[(i + 1) % pts.length];
+    a += x1 * y2 - x2 * y1;
+  }
+  return a / 2;
+};
+const rings = tri.toPolygons().map((r) => r.map(([x, y]) => [x, y]));
+const outerOnly = new wasm.CrossSection(rings.filter((r) => area(r) > 0), 'NonZero');
+for (const p of c.cutRegions) {
+  const pcs = new wasm.CrossSection([p.outer, ...p.holes], 'EvenOdd');
+  const g = tri.offset(0.2, 'Round', 2, 64);
+  const b = pcs.subtract(g);
+  if (b.area() > 1e-6) {
+    for (const ring of b.toPolygons()) {
+      const xs = ring.map((q) => q[0]);
+      const ys = ring.map((q) => q[1]);
+      const rcs = new wasm.CrossSection([ring.map(([x, y]) => [x, y])], 'EvenOdd');
+      const outside = rcs.subtract(outerOnly);
+      console.log(
+        `beyond-0.2 ring area ${Math.abs(area(ring)).toFixed(4)}mm², bbox x ${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)} y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}; outside the outer silhouette ${outside.area().toFixed(4)}mm²`,
+      );
+      // the raw triangle hole containing it, if any
+      for (const r of rings.filter((r) => area(r) < 0)) {
+        const h = new wasm.CrossSection([r], 'EvenOdd');
+        const hit = h.intersect(rcs);
+        if (hit.area() > 1e-6) {
+          let per = 0;
+          for (let i = 0; i < r.length; i++) {
+            const [x1, y1] = r[i];
+            const [x2, y2] = r[(i + 1) % r.length];
+            per += Math.hypot(x2 - x1, y2 - y1);
+          }
+          console.log(
+            `  inside a triangle hole of ${Math.abs(area(r)).toFixed(2)}mm², 4A/P ${((4 * Math.abs(area(r))) / per).toFixed(2)}mm, ${r.length} vertices`,
+          );
+        }
+        hit.delete();
+        h.delete();
+      }
+      outside.delete();
+      rcs.delete();
+    }
+  }
+  b.delete();
+  g.delete();
+  pcs.delete();
+}
diff --git a/scripts/_spike-measure.mjs b/scripts/_spike-measure.mjs
new file mode 100644
index 0000000..a50b6c3
--- /dev/null
+++ b/scripts/_spike-measure.mjs
@@ -0,0 +1,138 @@
+// SPIKE (not committed): per-sidecar off-surface / holes / field-diff summary.
+// Usage: npx vite-node scripts/_spike-measure.mjs main.json other.json ...
+import { readFileSync } from 'node:fs';
+import { getManifold } from '../src/geometry/manifold';
+import { MIN_HOLE_AREA_MM2, MIN_HOLE_WIDTH_MM, regionNetArea } from './lib/zonebake.mjs';
+
+const wasm = await getManifold();
+const area = (pts) => {
+  let a = 0;
+  for (let i = 0; i < pts.length; i++) {
+    const [x1, y1] = pts[i];
+    const [x2, y2] = pts[(i + 1) % pts.length];
+    a += x1 * y2 - x2 * y1;
+  }
+  return a / 2;
+};
+const perim = (pts) => {
+  let p = 0;
+  for (let i = 0; i < pts.length; i++) {
+    const [x1, y1] = pts[i];
+    const [x2, y2] = pts[(i + 1) % pts.length];
+    p += Math.hypot(x2 - x1, y2 - y1);
+  }
+  return p;
+};
+const real = (h) =>
+  Math.abs(area(h)) >= MIN_HOLE_AREA_MM2 && (4 * Math.abs(area(h))) / perim(h) >= MIN_HOLE_WIDTH_MM;
+
+const files = process.argv.slice(2);
+const sides = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
+const J = JSON.stringify;
+const base = sides[0];
+for (let s = 0; s < sides.length; s++) {
+  const sc = sides[s];
+  let pieces = 0;
+  let half = 0;
+  let halfArea = 0;
+  const off = { dead: 0, none: 0 };
+  const offFill = { dead: 0, none: 0 };
+  const deep = [];
+  const holeRows = [];
+  const changed = [];
+  const otherChanged = new Set();
+  sc.zones.forEach((z, zi) => {
+    for (const k of Object.keys(z))
+      if (k !== 'charts' && J(z[k]) !== J(base.zones[zi][k])) otherChanged.add(`${z.id}.${k}`);
+    z.charts.forEach((c, ci) => {
+      const bc = base.zones[zi].charts[ci];
+      for (const k of Object.keys(c))
+        if (J(c[k]) !== J(bc[k])) {
+          if (k === 'cutRegions') changed.push(`${z.id}/${c.libraryPartId}`);
+          else otherChanged.add(`${z.id}/${c.libraryPartId}.${k}`);
+        }
+      const hasDead = (c.deadRegions ?? []).length > 0;
+      const cs = new wasm.CrossSection(
+        c.chartTris.map((t) => t.map((i) => [c.uv[2 * i], c.uv[2 * i + 1]])),
+        'NonZero',
+      );
+      // Filled silhouette: the triangles plus every hole of theirs that fails isRealHole (what the
+      // claim deliberately closes), so a closed hole is not counted as overhang.
+      const triPolys = cs.toPolygons().map((r) => r.map(([x, y]) => [x, y]));
+      const fillHoles = triPolys
+        .filter((r) => area(r) < 0 && !real(r))
+        .map((r) => new wasm.CrossSection([r], 'EvenOdd'));
+      const fill = wasm.CrossSection.union([cs, ...fillHoles]);
+      for (const f of fillHoles) f.delete();
+      const reachOf = (pcs) => {
+        const beyond = (d) => {
+          const g = fill.offset(d, 'Round', 2, 64);
+          const b = pcs.subtract(g);
+          const r = b.area() > 1e-6;
+          b.delete();
+          g.delete();
+          return r;
+        };
+        if (!beyond(0)) return 0;
+        if (beyond(3)) return 3;
+        let lo = 0;
+        let hi = 3;
+        while (hi - lo > 0.002) {
+          const m = (lo + hi) / 2;
+          if (beyond(m)) lo = m;
+          else hi = m;
+        }
+        return hi;
+      };
+      let holes = 0;
+      let fail = 0;
+      let failArea = 0;
+      for (const p of c.cutRegions ?? []) {
+        pieces++;
+        const pcs = new wasm.CrossSection([p.outer, ...p.holes], 'EvenOdd');
+        const o = pcs.subtract(cs);
+        const oa = o.area();
+        off[hasDead ? 'dead' : 'none'] += oa;
+        const of = pcs.subtract(fill);
+        offFill[hasDead ? 'dead' : 'none'] += of.area();
+        of.delete();
+        const reach = reachOf(pcs);
+        if (reach > 0.2) deep.push(`${z.id}/${c.libraryPartId} ${regionNetArea(p).toFixed(1)}mm² reach ${reach.toFixed(3)}mm`);
+        if (oa / pcs.area() >= 0.5) {
+          half++;
+          halfArea += regionNetArea(p);
+        }
+        o.delete();
+        pcs.delete();
+        for (const h of p.holes) {
+          holes++;
+          if (!real(h)) {
+            fail++;
+            failArea += Math.abs(area(h));
+          }
+        }
+      }
+      cs.delete();
+      fill.delete();
+      holeRows.push({ id: `${z.id}/${c.libraryPartId}`, hasDead, holes, fail, failArea });
+    });
+  });
+  console.log(`\n== ${files[s]}`);
+  console.log(
+    `pieces ${pieces}; >=50% off: ${half} (${halfArea.toFixed(3)}mm²); off-surface mm²: dead-region charts ${off.dead.toFixed(2)}, no-dead charts ${off.none.toFixed(2)}`,
+  );
+  console.log(
+    `off the FILLED silhouette (triangles + holes failing isRealHole) mm²: dead ${offFill.dead.toFixed(2)}, no-dead ${offFill.none.toFixed(2)}`,
+  );
+  console.log(`pieces reaching more than 0.2mm past the filled silhouette: ${deep.length}${deep.length ? ' — ' + deep.join('; ') : ''}`);
+  console.log(
+    `cutRegions changed vs ${files[0]}: ${changed.length}${changed.length ? ' — ' + changed.join(', ') : ''}`,
+  );
+  console.log(`other fields changed: ${otherChanged.size ? [...otherChanged].join(', ') : 'none'}`);
+  console.log('holes per chart (total / failing isRealHole / failing mm²):');
+  for (const r of holeRows)
+    if (r.holes)
+      console.log(
+        `  ${r.id.padEnd(38)}${r.hasDead ? ' D' : '  '} ${String(r.holes).padStart(3)} / ${String(r.fail).padStart(3)} / ${r.failArea.toFixed(2)}`,
+      );
+}
diff --git a/scripts/_spike-specks-all.ts b/scripts/_spike-specks-all.ts
new file mode 100644
index 0000000..9532f66
--- /dev/null
+++ b/scripts/_spike-specks-all.ts
@@ -0,0 +1,51 @@
+// How many specks under CLIP_REMNANT_FLOOR_MM2 the app's own clip leaves when a design covers a
+// whole chart: each one is a "too fine to print" notice on a plain full-bleed design. Counted per
+// chart that carries a dead region, which are the charts whose cut region the bake clips.
+//
+// Usage: npx vite-node scripts/measure-cut-specks.ts [sidecar.json ...]
+//   (defaults to public/stl/chair-body-zones.json; pass an older sidecar to compare)
+import { readFileSync } from 'node:fs';
+import * as turf from '@turf/turf';
+import { safeIntersectChecked, dropUnprintableRemnants } from '../src/geometry/regions';
+import { CLIP_REMNANT_FLOOR_MM2 } from '../src/geometry/depth';
+import type { PolyFeature } from '../src/types';
+
+type Region = { outer: number[][]; holes: number[][][] };
+type Chart = { libraryPartId: string; cutRegions: Region[]; deadRegions?: Region[] };
+
+const close = (r: number[][]): number[][] =>
+  r.length && (r[0][0] !== r.at(-1)![0] || r[0][1] !== r.at(-1)![1]) ? [...r, r[0]] : r;
+// Far past any chart's UV, so the clip is the cut region's own outline and nothing else.
+const COVER = turf.polygon([
+  [
+    [-2000, -2000],
+    [2000, -2000],
+    [2000, 2000],
+    [-2000, 2000],
+    [-2000, -2000],
+  ],
+]) as PolyFeature;
+
+const files = process.argv.slice(2);
+for (const f of files.length ? files : ['public/stl/chair-body-zones.json']) {
+  const sidecar = JSON.parse(readFileSync(f, 'utf8')) as {
+    zones: { id: string; charts: Chart[] }[];
+  };
+  console.log(f);
+  let total = 0;
+  for (const z of sidecar.zones)
+    for (const c of z.charts) {
+      if (!process.env.ALL && !(c.deadRegions ?? []).length) continue;
+      const cut = turf.multiPolygon(
+        c.cutRegions.map((r) => [close(r.outer), ...r.holes.map(close)]),
+      ) as PolyFeature;
+      const r = safeIntersectChecked(COVER, cut);
+      const d = dropUnprintableRemnants(r.feat, CLIP_REMNANT_FLOOR_MM2);
+      total += d.dropped;
+      console.log(
+        `  ${`${z.id}/${c.libraryPartId}`.padEnd(38)} ${String(c.cutRegions.length).padStart(3)} ` +
+          `pieces, ${String(d.dropped).padStart(3)} speck(s)${r.clipped ? '' : ' (clip FAILED)'}`,
+      );
+    }
+  console.log(`  ${total} speck(s) in all.`);
+}
diff --git a/scripts/lib/zonebake.mjs b/scripts/lib/zonebake.mjs
index 2f8b53a..f5adaeb 100644
--- a/scripts/lib/zonebake.mjs
+++ b/scripts/lib/zonebake.mjs
@@ -4329,10 +4329,31 @@ export function bakeZones(config, parts, log = () => {}, opts = {}) {
       // printed seam this is what each part's cutter must be clipped to — clipping to the whole
       // zone outline instead pushes artwork past the part's own chart, where the warp reports it
       // off-chart and the color silently vanishes from both parts.
+      const rawOfSimplified = new Map();
       const subLoops = boundaryVertexLoops(list.map((e) => e.zTri))
-        .map((loop) => simplifyLoop(loop.map(uvOf), simplifyTol))
+        .map((loop) => {
+          const raw = loop.map(uvOf);
+          const simp = simplifyLoop(raw, simplifyTol);
+          rawOfSimplified.set(simp, raw);
+          return simp;
+        })
         .filter((pts) => pts.length >= 3);
       const rawRegions = classifyRegions(subLoops);
+      // SPIKE: the raw triangle rings plus the RAW rings of every hole the claim closed.
+      const SPIKE_MODE = process.env.SPIKE_MODE ?? '';
+      const spikeFill = () => {
+        const tri = new opts.wasm.CrossSection(
+          list.map((e) => triRing(e.zTri)),
+          'NonZero',
+        );
+        const closed = rawRegions
+          .flatMap((r) => r.holes)
+          .filter((h) => !isRealHole(h, minHoleArea, minHoleWidth))
+          .map((h) => new opts.wasm.CrossSection([rawOfSimplified.get(h)], 'EvenOdd'));
+        const fill = opts.wasm.CrossSection.union([tri, ...closed]);
+        for (const c of [tri, ...closed]) c.delete();
+        return fill;
+      };
       // Folds, not holes. Reported rather than dropped quietly, because a hole that stops being
       // punched *adds* clip region: artwork now cuts where the sidecar used to exclude. That is the
       // intent — a zero-width ribbon excluded nothing real — but it is still the clip region moving,
@@ -4368,9 +4389,23 @@ export function bakeZones(config, parts, log = () => {}, opts = {}) {
             `sliver island(s) under ${minIslandArea}mm² (largest ${dropped[0].area.toFixed(3)}mm²) ` +
             `from the clip region — artwork placed there will not cut`,
         );
-      const subRegions = allRegions
+      let subRegions = allRegions
         .filter((r, i) => i === 0 || r.area >= minIslandArea)
         .map(({ outer, holes }) => ({ outer, holes }));
+      if (SPIKE_MODE === 'wide') {
+        const fill = spikeFill();
+        const clipped = clipRegionsToChart(opts.wasm, subRegions, fill, 0);
+        fill.delete();
+        const shed = clipped.filter((r) => regionNetArea(r) < minCutPieceArea);
+        if (shed.length)
+          warnings.push(
+            `SPIKE zone "${zoneCfg.id}" part "${parts[pi].libraryPartId}": wide clip dropped ` +
+              `${shed.length} claim piece(s) under ${+minCutPieceArea.toFixed(3)}mm²`,
+          );
+        subRegions = clipped
+          .filter((r) => regionNetArea(r) >= minCutPieceArea)
+          .map((r) => ({ outer: roundLoop(r.outer), holes: r.holes.map(roundLoop) }));
+      }
       // An empty list would read at runtime as "no per-part clipping" and silently fall back to the
       // whole zone outline — the exact failure subRegions exists to prevent. Fail the bake instead.
       if (!subRegions.length)
@@ -4398,7 +4433,18 @@ export function bakeZones(config, parts, log = () => {}, opts = {}) {
             list.map((e) => triRing(e.zTri)),
             'NonZero',
           );
-          const cut = deadCS.intersect(chartCS);
+          // SPIKE: f2 = intersect the dead set with the SIMPLIFIED claim (holes it closed stay
+          // closed), not the raw triangles, and do not re-simplify after.
+          const SPIKE = process.env.SPIKE_MODE ?? '';
+          const subCS =
+            SPIKE === 'f2'
+              ? new opts.wasm.CrossSection(
+                  subRegions.flatMap((r) => [r.outer, ...r.holes]),
+                  'EvenOdd',
+                )
+              : null;
+          const cut = deadCS.intersect(subCS ?? chartCS);
+          if (subCS) subCS.delete();
           const rings = cut.toPolygons().map((ring) => ring.map(([x, y]) => [x, y]));
           cut.delete();
           chart.deadRegions = classifyRegions(rings)
@@ -4416,10 +4462,14 @@ export function bakeZones(config, parts, log = () => {}, opts = {}) {
             // hole under minHoleArea is not subtracted from what ships either. Nothing in the
             // current sidecar moves: all 12 of its dead regions have no holes at all.
             .filter((r) => regionNetArea(r) >= MIN_DEAD_AREA_MM2)
-            .map((r) => ({
-              outer: roundLoop(simplifyLoop(r.outer, simplifyTol)),
-              holes: r.holes.map((h) => roundLoop(simplifyLoop(h, simplifyTol))),
-            }));
+            .map((r) =>
+              SPIKE_MODE === 'f2' || SPIKE_MODE === 'rawdead'
+                ? { outer: roundLoop(r.outer), holes: r.holes.map(roundLoop) }
+                : {
+                    outer: roundLoop(simplifyLoop(r.outer, simplifyTol)),
+                    holes: r.holes.map((h) => roundLoop(simplifyLoop(h, simplifyTol))),
+                  },
+            );
         }
       }
       // The clip the runtime actually uses: this part's claim less the surface the covers hide,
@@ -4441,8 +4491,10 @@ export function bakeZones(config, parts, log = () => {}, opts = {}) {
       // floored separately: the clip takes off-part area nobody needs telling about, the floor takes
       // on-chart surface, so only the floor warns — like the island and fold drops above.
       let onChart = cutPieces;
-      if (chartCS && chart.deadRegions?.length) {
-        const clipped = clipRegionsToChart(opts.wasm, cutPieces, chartCS, 0);
+      if ((!SPIKE_MODE || SPIKE_MODE === 'narrow') && chartCS && chart.deadRegions?.length) {
+        const clipTo = SPIKE_MODE === 'narrow' ? spikeFill() : chartCS;
+        const clipped = clipRegionsToChart(opts.wasm, cutPieces, clipTo, 0);
+        if (clipTo !== chartCS) clipTo.delete();
         const offChart =
           cutPieces.reduce((t, r) => t + regionNetArea(r), 0) -
           clipped.reduce((t, r) => t + regionNetArea(r), 0);
```

</details>
