/**
 * Print targets: build volume + the profile names (printer_settings_id / print_settings_id /
 * filament_settings_id / curr_bed_type) that make each slicer auto-select a system preset. Snapmaker
 * Orca needs its own names: `snapmaker-u1` was verified against a real 0.4mm-nozzle export.
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
  /** Slots in a *single* unit, 4 everywhere (AMS, AMS Lite, AMS 2 Pro; the U1's 4 heads): what most
   * users budget against, but not a ceiling — that is slotsMax. */
  slotsPerUnit: number;
  /** Most slots addressable in one print across chained units. The app can't know how many units
   * a user owns, so above slotsPerUnit ("needs more hardware") and above this ("can't print in one
   * go") are two different messages. */
  slotsMax: number;
  /** The multi-material hardware's name for copy: "AMS" is Bambu's brand and the U1 has a built-in
   * toolchanger, so every string that would hardcode "AMS" reads this. */
  unitLabel: string;
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
    slotsPerUnit: 4,
    // 4 chained AMS units; the A1's AMS Lite doesn't chain, but the A1 can drive the regular AMS.
    slotsMax: 16,
    unitLabel: 'AMS unit',
  },
  {
    id: 'bambu-h2d',
    label: 'Bambu H2D (350 × 320mm)',
    plate: { w: 350, d: 320, height: 325 },
    printerId: 'Bambu Lab H2D 0.4 nozzle',
    printId: '0.20mm Standard @BBL H2D',
    filamentId: 'Generic PETG',
    bedType: 'Textured PEI Plate',
    slotsPerUnit: 4,
    // dual nozzles: 24 AMS slots (4 × 4-slot AMS 2 Pro + 8 × single-spool AMS HT) + 1 external spool
    slotsMax: 25,
    unitLabel: 'AMS unit',
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
    slotsPerUnit: 4,
    // a hard ceiling: the 4 toolheads are built in and nothing chains
    slotsMax: 4,
    unitLabel: 'toolchanger',
  },
];

export const DEFAULT_PRINTER_ID = 'bambu-x1c';

export function getPrinter(id: string): Printer {
  return PRINTERS.find((p) => p.id === id) || PRINTERS.find((p) => p.id === DEFAULT_PRINTER_ID)!;
}
