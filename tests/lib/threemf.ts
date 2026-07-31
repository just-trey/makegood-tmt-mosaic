import JSZip from 'jszip';

/** The sub-objects one exported part actually ships, read back out of a built 3MF. */
export interface PartObjectSummary {
  name: string;
  bodyCount: number;
  inlayCount: number;
  /** Each sub-object's extruder, in emission order: body is 1, color `ci`'s inlay is `ci + 2`. */
  extruders: number[];
}

/**
 * Per-part body/inlay object counts from a built 3MF — what actually ships, as opposed to the
 * in-memory `AssemblyPartOutput` the geometry tests assert. Pins the export half of the CSG
 * failure branches: a part whose cut failed must ship its body alone, with no inlay solid left
 * occupying the same volume.
 */
export async function partObjectSummaries(blob: Blob): Promise<PartObjectSummary[]> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const model = await zip.file('3D/3dmodel.model')!.async('string');
  const cfg = await zip.file('Metadata/model_settings.config')!.async('string');

  // Body vs inlay is the extruder, not the object's name: only the body is named "Body" by
  // convention, while an inlay carries a filament name out of user-editable filaments.json, so a
  // filament named "Body" would collide. matIndex 0 -> extruder 1 is the body by construction
  // (exportPanel.ts). Scoped inside <part>..</part> because each enclosing <object> also carries
  // its own key="extruder" value="1" that would otherwise match first.
  const extruderOf = new Map<string, number>();
  for (const [, id, partBody] of cfg.matchAll(/<part id="(\d+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    const m = /<metadata key="extruder" value="(\d+)"\/>/.exec(partBody);
    if (m) extruderOf.set(id, +m[1]);
  }

  // Only the wrapping component objects match here — a mesh <object> is followed by <mesh>, not
  // <components> — and their <component objectid=".."> children are the sub-objects that ship.
  return [
    ...model.matchAll(
      /<object id="\d+" name="([^"]*)" type="model">\s*<components>([\s\S]*?)<\/components>/g,
    ),
  ].map(([, name, components]) => {
    const extruders = [...components.matchAll(/objectid="(\d+)"/g)].map(([, id]) => {
      const e = extruderOf.get(id);
      // The two files disagreeing is itself the bug, so say so rather than scoring it as an inlay.
      if (e === undefined)
        throw new Error(`sub-object ${id} of "${name}" has no model_settings.config entry`);
      return e;
    });
    return {
      name,
      bodyCount: extruders.filter((e) => e === 1).length,
      inlayCount: extruders.filter((e) => e !== 1).length,
      extruders,
    };
  });
}
