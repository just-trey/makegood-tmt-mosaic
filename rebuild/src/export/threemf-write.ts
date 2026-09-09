import { writeZip, type ZipEntry } from '../lib/zip';
import { escapeXml } from '../lib/xml';
import type { Mesh } from '../geometry/mesh';
import type { Layout } from './plates';
import type { Printer } from './printers';

export interface ExportSlot {
  /** 1-based filament number in the slicer. 1 is the body. */
  index: number;
  color: string;
  name: string;
}

export interface ExportOptions {
  printer: Printer;
  layout: Layout;
  slots: ExportSlot[];
  projectName: string;
}

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';
const APP = 'BambuStudio-01.09.05.51';
const PLATE_GAP = 0.1;

function uuid(n: number, salt: number): string {
  const h = (v: number, len: number) => v.toString(16).padStart(len, '0').slice(-len);
  return `${h(n, 8)}-${h(salt, 4)}-4${h(n * 7 + salt, 3)}-8${h(n * 13 + salt * 3, 3)}-${h(n * 104729 + salt, 12)}`;
}

function meshXml(id: number, mesh: Mesh): string {
  const out: string[] = [`<object id="${id}" p:UUID="${uuid(id, 1)}" type="model"><mesh><vertices>`];
  const p = mesh.pos;
  const v: string[] = new Array(p.length / 3);
  for (let i = 0; i < p.length; i += 3) v[i / 3] = `<vertex x="${p[i].toFixed(4)}" y="${p[i + 1].toFixed(4)}" z="${p[i + 2].toFixed(4)}"/>`;
  out.push(v.join(''), '</vertices><triangles>');
  const t = mesh.idx;
  const tr: string[] = new Array(t.length / 3);
  for (let i = 0; i < t.length; i += 3) tr[i / 3] = `<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`;
  out.push(tr.join(''), '</triangles></mesh></object>');
  return out.join('');
}

/**
 * A Bambu Studio project: the split layout the slicer itself writes (one model file per object
 * under 3D/Objects, the root model holding components and build items), plus the two config
 * files that carry plate membership, per-part filament numbers and the print presets.
 */
export async function write3mf(opts: ExportOptions): Promise<Uint8Array> {
  const { printer, layout, slots } = opts;
  const files: ZipEntry[] = [];
  const zip = { file: (name: string, data: string) => files.push({ name, data }) };
  const nPlates = layout.plates.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(nPlates)));
  let nextId = 1;
  const rootObjects: string[] = [];
  const buildItems: string[] = [];
  const settingsObjects: string[] = [];
  const plateXml: string[] = [];
  const assemble: string[] = [];
  const rels: string[] = [];
  let identify = 1;

  for (const plate of layout.plates) {
    const col = (plate.index - 1) % cols;
    const row = Math.floor((plate.index - 1) / cols);
    const ox = col * printer.bedW * (1 + PLATE_GAP);
    const oy = -row * printer.bedD * (1 + PLATE_GAP);
    const instances: string[] = [];
    for (const pp of plate.pieces) {
      const parts: { id: number; mesh: Mesh; name: string; slot: number }[] = [];
      parts.push({ id: nextId++, mesh: pp.body, name: `${pp.piece.name} body`, slot: 1 });
      for (const inl of pp.inlays) {
        const slot = slots.find((s) => s.index === inl.slot);
        parts.push({ id: nextId++, mesh: inl.mesh, name: `${pp.piece.name} · ${slot?.name ?? inl.color}`, slot: inl.slot });
      }
      const containerId = nextId++;
      const rootId = nextId++;
      const file = `3D/Objects/object_${rootId}.model`;
      const sub: string[] = [`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>`, `<metadata name="BambuStudio:3mfVersion">1</metadata><resources>`];
      for (const part of parts) sub.push(meshXml(part.id, part.mesh));
      sub.push(`<object id="${containerId}" p:UUID="${uuid(containerId, 2)}" type="model"><components>`);
      for (const part of parts) sub.push(`<component objectid="${part.id}" p:UUID="${uuid(part.id, 3)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`);
      sub.push('</components></object></resources><build/></model>');
      zip.file(file, sub.join(''));
      rels.push(`<Relationship Target="/${file}" Id="rel-${rootId}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`);
      rootObjects.push(`<object id="${rootId}" p:UUID="${uuid(rootId, 4)}" type="model"><components><component p:path="/${file}" objectid="${containerId}" p:UUID="${uuid(containerId, 5)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>`);
      const tx = ox + pp.x, ty = oy + pp.y;
      buildItems.push(`<item objectid="${rootId}" p:UUID="${uuid(rootId, 6)}" transform="1 0 0 0 1 0 0 0 1 ${tx.toFixed(4)} ${ty.toFixed(4)} 0" printable="1"/>`);
      const partXml = parts
        .map(
          (part) =>
            `<part id="${part.id}" subtype="normal_part"><metadata key="name" value="${escapeXml(part.name)}"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/><metadata key="source_file" value=""/><metadata key="extruder" value="${part.slot}"/><mesh_stat face_count="${part.mesh.idx.length / 3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/></part>`,
        )
        .join('');
      settingsObjects.push(`<object id="${rootId}"><metadata key="name" value="${escapeXml(pp.piece.name)}"/><metadata key="extruder" value="1"/>${partXml}</object>`);
      instances.push(`<model_instance><metadata key="object_id" value="${rootId}"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="${identify++}"/></model_instance>`);
      assemble.push(`<assemble_item object_id="${rootId}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 ${tx.toFixed(4)} ${ty.toFixed(4)} 0" offset="0 0 0"/>`);
    }
    plateXml.push(`<plate><metadata key="plater_id" value="${plate.index}"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/>${instances.join('')}</plate>`);
  }

  const root = [
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>`,
    `<metadata name="Application">${APP}</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><metadata name="Title">${escapeXml(opts.projectName)}</metadata>`,
    `<resources>${rootObjects.join('')}</resources><build p:UUID="${uuid(999, 7)}">${buildItems.join('')}</build></model>`,
  ].join('');
  zip.file('3D/3dmodel.model', root);
  zip.file('3D/_rels/3dmodel.model.rels', `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`);
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="gcode" ContentType="text/x.gcode"/></Types>`);
  zip.file('Metadata/model_settings.config', `<?xml version="1.0" encoding="UTF-8"?>\n<config>${settingsObjects.join('')}${plateXml.join('')}<assemble>${assemble.join('')}</assemble></config>`);
  zip.file('Metadata/project_settings.config', JSON.stringify(projectSettings(opts), null, 2));
  return writeZip(files);
}

/**
 * Print settings MakeGood's prints use: Generic PETG, 15% gyroid, tree supports, no brim. Only
 * the keys that differ from the preset are written; the slicer fills the rest from the named
 * presets, so the file stays valid across slicer versions.
 */
export function projectSettings(opts: ExportOptions): Record<string, unknown> {
  const { printer, slots, layout } = opts;
  const n = Math.max(1, ...slots.map((s) => s.index));
  const byIndex = new Map(slots.map((s) => [s.index, s]));
  const colours: string[] = [];
  for (let i = 1; i <= n; i++) colours.push((byIndex.get(i)?.color ?? '#808080').toUpperCase());
  const rep = (v: string) => Array.from({ length: n }, () => v);
  const towerX = layout.plates.map((p) => (p.tower ? p.tower.x.toFixed(2) : '15'));
  const towerY = layout.plates.map((p) => (p.tower ? p.tower.y.toFixed(2) : '15'));
  return {
    version: '01.09.05.51',
    printer_settings_id: printer.printerPreset,
    print_settings_id: printer.printPreset,
    filament_settings_id: rep(printer.filamentPreset),
    filament_colour: colours,
    filament_type: rep('PETG'),
    curr_bed_type: printer.bedType,
    printable_area: [`0x0`, `${printer.bedW}x0`, `${printer.bedW}x${printer.bedD}`, `0x${printer.bedD}`],
    printable_height: String(printer.bedH),
    sparse_infill_density: '15%',
    sparse_infill_pattern: 'gyroid',
    enable_support: '1',
    support_type: 'tree(auto)',
    brim_type: 'no_brim',
    enable_prime_tower: '1',
    prime_tower_width: '35',
    wipe_tower_x: towerX,
    wipe_tower_y: towerY,
    different_settings_to_system: ['sparse_infill_density;sparse_infill_pattern;enable_support;support_type;brim_type;enable_prime_tower;prime_tower_width;wipe_tower_x;wipe_tower_y', ...rep(''), ''],
  };
}
