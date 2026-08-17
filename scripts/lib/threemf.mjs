// Reading what an export actually contains, shared by every script that needs to look inside a
// 3MF rather than trusting that one appeared.
//
// The .mjs twin of tests/lib/threemf.ts. Two copies exist because vitest reads TypeScript and the
// drive scripts do not; keeping this one in lib/ is what stops a third appearing per script.
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';

/**
 * Body/inlay counts per exported part -- the .mjs twin of tests/lib/threemf.ts, plus the body's
 * triangle count.
 *
 * The triangle count is what separates "cut, recess left empty" from "exported uncut": both ship
 * one body and no inlays, so counts alone can't tell the intersection branch from the difference
 * branch, and a bug collapsing one into the other would pass unnoticed. A cut body carries the
 * pocket walls; an uncut one is the original part mesh.
 */
export async function partSummaries(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const model = await zip.file('3D/3dmodel.model').async('string');
  const cfg = await zip.file('Metadata/model_settings.config').async('string');

  const extruderOf = new Map();
  for (const [, id, body] of cfg.matchAll(/<part id="(\d+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    const m = /<metadata key="extruder" value="(\d+)"\/>/.exec(body);
    if (m) extruderOf.set(id, +m[1]);
  }
  const trisOf = new Map();
  for (const [, id, mesh] of model.matchAll(
    /<object id="(\d+)"[^>]*>\s*<mesh>([\s\S]*?)<\/mesh>/g,
  )) {
    trisOf.set(id, [...mesh.matchAll(/<triangle /g)].length);
  }
  return [
    ...model.matchAll(
      /<object id="\d+" name="([^"]*)" type="model">\s*<components>([\s\S]*?)<\/components>/g,
    ),
  ].map(([, name, components]) => {
    const ids = [...components.matchAll(/objectid="(\d+)"/g)].map(([, id]) => id);
    // Same rule as the twin: a sub-object the config never names is the bug itself, not an inlay
    // and not a nothing. Scoring it as neither would let a regression that drops config entries
    // report zero inlays -- i.e. pass the "no overlapping uncut-body + inlay pair" check while
    // shipping exactly that pair.
    for (const id of ids) {
      if (extruderOf.get(id) === undefined)
        throw new Error(`sub-object ${id} of "${name}" has no model_settings.config entry`);
    }
    const bodyIds = ids.filter((id) => extruderOf.get(id) === 1);
    return {
      name,
      bodyCount: bodyIds.length,
      inlayCount: ids.filter((id) => extruderOf.get(id) !== 1).length,
      bodyTris: bodyIds.reduce((n, id) => n + (trisOf.get(id) ?? 0), 0),
    };
  });
}

/**
 * Plate count, per-plate part names and filament counts, and the total build items.
 *
 * What CI could not previously say about an export: smoke downloaded three files and printed
 * `statSync(f).size` with no assertion on any of them, so an export that wrote one empty plate,
 * dropped every inlay, or lost the filament table fired the same download event and printed a
 * smaller number into a log nobody diffs.
 */
export async function plateSummary(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const model = await zip.file('3D/3dmodel.model').async('string');
  const cfg = await zip.file('Metadata/model_settings.config').async('string');

  const name = {};
  const extruders = {};
  for (const m of cfg.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    name[m[1]] = m[2].match(/<metadata key="name" value="([^"]*)"/)?.[1] ?? '?';
    extruders[m[1]] = new Set(
      [...m[2].matchAll(/<metadata key="extruder" value="(\d+)"\/>/g)].map((e) => e[1]),
    );
  }
  const plates = [...cfg.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((p) =>
    [...p[1].matchAll(/key="object_id" value="(\d+)"/g)].map((o) => o[1]),
  );
  return {
    plates: plates.map((ids) => ({
      parts: ids.map((id) => name[id] ?? '?'),
      filaments: new Set(ids.flatMap((id) => [...(extruders[id] ?? [])])).size,
    })),
    items: [...model.matchAll(/<item /g)].length,
    filaments: new Set(Object.values(extruders).flatMap((s) => [...s])).size,
  };
}
