/**
 * Supported print targets: build volume + the Bambu-Studio-project-format profile-name strings
 * (printer_settings_id / print_settings_id / filament_settings_id / curr_bed_type) that make
 * each slicer auto-select a matching system preset on import. Bambu Studio and OrcaSlicer read
 * these directly; Snapmaker Orca is a downstream OrcaSlicer fork that reads the same
 * project_settings.config shape but needs its own preset names — the `snapmaker-u1` entry below
 * was verified against a real Snapmaker Orca 0.4mm-nozzle export, not guessed.
 */
export interface Printer {
  id: string;
  label: string;
  plate: { w: number; d: number; height: number };
  printerId: string;
  printId: string;
  filamentId: string;
  bedType: string;
  /** printer_variant / nozzle_diameter — only Snapmaker Orca's preset system keys off this. */
  variant?: string;
  /** Filament slots in a *single* AMS/toolchanger unit — 4 for every entry here: Bambu's original
   * AMS, AMS Lite, and AMS 2 Pro are all 4-slot units, and the U1's built-in toolchanger has 4
   * heads. This is the number most users are actually budgeting against, since one unit is the
   * common setup — but it is not a ceiling, which is what amsSlotsMax is for. */
  amsSlotsPerUnit: number;
  /** Most slots this printer can address in one print, across daisy-chained units. Above
   * amsSlotsPerUnit and at or below this, a design is printable but needs hardware beyond the
   * single unit; above this it can't be printed in one go on this machine at all. The app has no
   * way to know how many units a given user owns, so the two numbers drive two different messages
   * rather than one hard capacity claim. */
  amsSlotsMax: number;
}

export const PRINTERS: Printer[] = [
  {
    id: 'bambu-x1c',
    label: 'Bambu X1C / P1S / A1 (256 × 256mm)',
    plate: { w: 256, d: 256, height: 250 },
    printerId: 'Bambu Lab X1 Carbon 0.4 nozzle',
    printId: '0.20mm Standard @BBL X1C',
    filamentId: 'Generic PETG',
    bedType: 'Textured PEI Plate',
    amsSlotsPerUnit: 4,
    // up to 4 AMS units daisy-chained. The A1's own AMS Lite is 4 slots and doesn't chain, but the
    // A1 can drive the regular AMS now, so 16 holds for all three printers this entry covers.
    amsSlotsMax: 16,
  },
  {
    id: 'bambu-h2d',
    label: 'Bambu H2D (350 × 320mm)',
    plate: { w: 350, d: 320, height: 325 },
    printerId: 'Bambu Lab H2D 0.4 nozzle',
    printId: '0.20mm Standard @BBL H2D',
    filamentId: 'Generic PETG',
    bedType: 'Textured PEI Plate',
    amsSlotsPerUnit: 4,
    // the outlier: dual nozzles let it reach 24 AMS slots (4 × AMS 2 Pro + 8 × 2-slot AMS HT) plus
    // one external spool on the second nozzle
    amsSlotsMax: 25,
  },
  {
    id: 'snapmaker-u1',
    label: 'Snapmaker U1 (270 × 270mm)',
    plate: { w: 270, d: 270, height: 270 },
    printerId: 'Snapmaker U1 (0.4 nozzle)',
    printId: '0.20 Standard @Snapmaker U1 (0.4 nozzle)',
    filamentId: 'Generic PETG',
    bedType: 'Textured PEI Plate',
    variant: '0.4',
    amsSlotsPerUnit: 4,
    // a genuine hard ceiling, unlike the Bambus: the 4 toolheads are built in and nothing chains
    amsSlotsMax: 4,
  },
];

export const DEFAULT_PRINTER_ID = 'bambu-x1c';

export function getPrinter(id: string): Printer {
  return PRINTERS.find((p) => p.id === id) || PRINTERS.find((p) => p.id === DEFAULT_PRINTER_ID)!;
}
