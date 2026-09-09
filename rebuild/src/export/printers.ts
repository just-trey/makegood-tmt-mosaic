export interface Printer {
  id: string;
  label: string;
  bedW: number;
  bedD: number;
  bedH: number;
  /** Slicer preset names the project opens with. */
  printerPreset: string;
  printPreset: string;
  filamentPreset: string;
  bedType: string;
  slotsPerUnit: number;
  slotsMax: number;
  unitLabel: string;
  /** Snapmaker's slicer is Orca-based and takes its own preset names. */
  family: 'bambu' | 'snapmaker';
}

export const PRINTERS: Printer[] = [
  {
    id: 'bambu-x1c',
    label: 'Bambu X1C / P1S / A1 (256 × 256 mm)',
    bedW: 256,
    bedD: 256,
    bedH: 250,
    printerPreset: 'Bambu Lab X1 Carbon 0.4 nozzle',
    printPreset: '0.20mm Standard @BBL X1C',
    filamentPreset: 'Generic PETG',
    bedType: 'Textured PEI Plate',
    slotsPerUnit: 4,
    slotsMax: 16,
    unitLabel: 'AMS',
    family: 'bambu',
  },
  {
    id: 'bambu-h2d',
    label: 'Bambu H2D (350 × 320 mm)',
    bedW: 350,
    bedD: 320,
    bedH: 325,
    printerPreset: 'Bambu Lab H2D 0.4 nozzle',
    printPreset: '0.20mm Standard @BBL H2D',
    filamentPreset: 'Generic PETG',
    bedType: 'Textured PEI Plate',
    slotsPerUnit: 4,
    slotsMax: 25,
    unitLabel: 'AMS',
    family: 'bambu',
  },
  {
    id: 'snapmaker-u1',
    label: 'Snapmaker U1 (270 × 270 mm)',
    bedW: 270,
    bedD: 270,
    bedH: 270,
    printerPreset: 'Snapmaker U1 (0.4 nozzle)',
    printPreset: '0.20 Standard @Snapmaker U1 (0.4 nozzle)',
    filamentPreset: 'Generic PETG',
    bedType: 'Textured PEI Plate',
    slotsPerUnit: 4,
    slotsMax: 4,
    unitLabel: 'toolhead',
    family: 'snapmaker',
  },
];

export const DEFAULT_PRINTER = 'bambu-x1c';

export function printerById(id: string): Printer {
  return PRINTERS.find((p) => p.id === id) ?? PRINTERS[0];
}
