// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  readMesh,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/mesh.mjs';
import type { AssemblyBuild, AssemblyPart } from '../src/types';

vi.mock('../src/app/rebuild', () => ({
  getLastAssemblyBuild: vi.fn(),
  isExportReady: vi.fn(() => true),
  holdExport: vi.fn(),
  exportBlockedReason: vi.fn(() => null),
}));
vi.mock('../src/geometry/assembly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/geometry/assembly')>()),
  asmPartFaceNormal: vi.fn(() => null),
}));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/ui/dialogs', () => ({ alertDialog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/state/persist', () => ({ schedulePersist: vi.fn() }));

import {
  exportPrintReady3MF,
  initExportPanel,
  PLACEMENT_WARNING_SUFFIXES,
  refreshPlacementNotices,
} from '../src/ui/exportPanel';
import { getLastAssemblyBuild } from '../src/app/rebuild';
import { buildHubcapBody } from '../src/geometry/hubcap';
import { WARNINGS, clearWarnings } from '../src/warnings';
import { state } from '../src/state/store';
import { setRebuildHandler } from '../src/app/scheduler';

/**
 * The placement notes are computed by the export's own layout, and used to reach the user only
 * after the file was saved. These drive the panel the way the page does, with the real placement
 * tables, layout and meshes; only the rebuild is stood in for, by handing over a finished build.
 */

const REPO = resolve(process.cwd());
const mesh = (id: string): Promise<Float32Array> => readMesh(resolve(REPO, `public/stl/${id}.3mf`));

const placementNotes = () =>
  WARNINGS.filter((w) => PLACEMENT_WARNING_SUFFIXES.some((s) => w.message.endsWith(s))).map(
    (w) => ({ message: w.message, level: w.level }),
  );
const bedNotes = () => placementNotes().filter((n) => n.message.includes("hasn't been checked"));

function part(over: Partial<AssemblyPart>): AssemblyPart {
  return {
    id: 1,
    name: 'part',
    roleId: 'role',
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
    topZ: 0,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 180,
    loaded: true,
    cutThrough: false,
    ...over,
  };
}

/** Every part with the body and one color, so every plate prints a prime tower. */
function buildOf(parts: AssemblyPart[], bodies: Float32Array[]): AssemblyBuild {
  return {
    partOutputs: parts.map((p, i) => ({
      part: p,
      bodySoup: bodies[i],
      inlaySoups: { 0: bodies[i] },
    })),
    palette: [{ hex: '#c1272d', key: '#c1272d', members: ['#c1272d'], isMerge: false }],
    viewSign: 1,
    detectedColors: [],
    baseAssigned: null,
  } as AssemblyBuild;
}

/** The notes are re-stated once any rebuild the switch starts lands, so this waits for that. */
async function selectPrinter(id: string): Promise<void> {
  const sel = document.querySelector<HTMLSelectElement>('#p-printer')!;
  sel.value = id;
  sel.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 0));
}

beforeAll(() => {
  document.body.innerHTML =
    '<div id="warnings"></div><div id="export-summary" hidden></div><div id="slot-count"></div>' +
    '<select id="p-printer">' +
    ['bambu-x1c', 'bambu-h2d', 'snapmaker-u1'].map((p) => `<option value="${p}">${p}</option>`) +
    '</select><button id="btn-export"></button>';
  initExportPanel();
  URL.createObjectURL = vi.fn(() => 'blob:mock') as unknown as typeof URL.createObjectURL;
});

beforeEach(() => {
  clearWarnings();
  state.assembly.parts = [];
});

afterEach(() => {
  state.assembly.kindId = null;
  state.printerId = 'bambu-x1c';
  state.hubcapDiameterMm = 220;
});

describe('the hubcap past its verified size: the notes before Export are the ones the export raises', () => {
  // The two cases from the 2026-10-06 review (item 3): the tower message arrived with the download.
  it.each([
    [240, 'bambu-x1c'],
    [260, 'snapmaker-u1'],
  ])(
    '%imm on %s',
    async (diameterMm, printerId) => {
      const clips = await mesh('hubcap-clips');
      const body = (await buildHubcapBody({ kind: 'circle', diameterMm }, clips)).positions;
      state.assembly.kindId = 'hubcap';
      state.hubcapDiameterMm = diameterMm;
      state.printerId = printerId;
      const hubcap = part({
        name: 'Hubcap',
        roleId: 'hubcap',
        libraryPartId: 'hubcap-clips',
        assetPositions: clips,
        positions: body,
      });
      state.assembly.parts = [hubcap];
      vi.mocked(getLastAssemblyBuild).mockReturnValue(buildOf([hubcap], [body]));

      refreshPlacementNotices();
      const before = placementNotes();
      expect(before.map((n) => n.message).join('\n')).toContain('No tower position was saved');
      expect(before.map((n) => n.message).join('\n')).toContain('generated to the size you chose');

      clearWarnings();
      await exportPrintReady3MF();
      expect(placementNotes()).toEqual(before);
    },
    30000,
  );

  // A smaller bed clamps the disc and regenerates it. Stated at the switch, the notes measured the
  // 260mm disc being replaced: "overhangs the 256×256mm plate" for a size never exported.
  it('waits for the clamp’s rebuild on a printer switch, not the disc it replaces', async () => {
    const clips = await mesh('hubcap-clips');
    const disc = async (d: number) =>
      (await buildHubcapBody({ kind: 'circle', diameterMm: d }, clips)).positions;
    const big = await disc(260);
    state.assembly.kindId = 'hubcap';
    state.hubcapDiameterMm = 260;
    state.printerId = 'snapmaker-u1';
    const hubcap = part({
      name: 'Hubcap',
      roleId: 'hubcap',
      libraryPartId: 'hubcap-clips',
      assetPositions: clips,
      positions: big,
    });
    state.assembly.parts = [hubcap];
    vi.mocked(getLastAssemblyBuild).mockReturnValue(buildOf([hubcap], [big]));
    // what rebuildCurrent's tail does, once the clamped disc is built
    setRebuildHandler(() => {
      vi.mocked(getLastAssemblyBuild).mockReturnValue(buildOf([hubcap], [hubcap.positions!]));
      refreshPlacementNotices();
    });
    const sel = document.querySelector<HTMLSelectElement>('#p-printer')!;
    sel.value = 'bambu-x1c';
    sel.dispatchEvent(new Event('change'));
    const said = () =>
      placementNotes()
        .map((n) => n.message)
        .join('\n');
    expect(said()).toBe('');
    await vi.waitFor(() => expect(said()).toContain('No tower position was saved'), {
      timeout: 20000,
    });
    expect(state.hubcapDiameterMm).toBeLessThan(260);
    expect(said()).not.toContain('overhangs');
    setRebuildHandler(() => {});
  }, 30000);
});

describe('a baked layout on a bed nobody checked it on', () => {
  const CHAIR = [
    'chair-handle-left',
    'chair-handle-right',
    'chair-storage-left',
    'chair-storage-right',
    'chair-wing-left',
    'chair-wing-right',
    'chair-wheel-mount-left',
    'chair-wheel-mount-right',
    'chair-seat-center',
    'chair-seat-back-bottom',
    'chair-seat-back-top',
    'chair-caster-std-left',
    'chair-caster-std-right',
  ];

  async function loadChair(): Promise<void> {
    state.assembly.kindId = 'chair-body';
    const bodies = await Promise.all(CHAIR.map(mesh));
    const parts = CHAIR.map((id, i) =>
      part({ id: i + 1, name: id, roleId: id, libraryPartId: id, positions: bodies[i] }),
    );
    state.assembly.parts = parts;
    vi.mocked(getLastAssemblyBuild).mockReturnValue(buildOf(parts, bodies));
  }

  // Item 11: every chair part resolves verified on any bed (a mesh seal), so the H2D exported the
  // 270mm tower deltas with nothing said. One line for the 13 parts, not 13 lines.
  it('says so once for the whole chair on the H2D, as information', async () => {
    await loadChair();
    await selectPrinter('bambu-h2d');
    expect(bedNotes()).toEqual([
      {
        message:
          "The plate layout for all 13 parts hasn't been checked on a 350 × 320mm bed. " +
          'Check the parts and prime tower in your slicer before printing.',
        level: 'info',
      },
    ]);
  }, 30000);

  it('says nothing on the two beds the chair was checked on', async () => {
    await loadChair();
    for (const printer of ['bambu-x1c', 'snapmaker-u1']) {
      await selectPrinter(printer);
      expect(bedNotes(), printer).toEqual([]);
    }
  }, 30000);

  it('notes nothing for the footrest on any registered bed', async () => {
    const body = await mesh('footrest');
    state.assembly.kindId = 'footrest';
    const footrest = part({
      name: 'Footrest',
      roleId: 'footrest',
      libraryPartId: 'footrest',
      positions: body,
    });
    state.assembly.parts = [footrest];
    vi.mocked(getLastAssemblyBuild).mockReturnValue(buildOf([footrest], [body]));

    for (const printer of ['snapmaker-u1', 'bambu-x1c', 'bambu-h2d']) {
      await selectPrinter(printer);
      expect(bedNotes(), printer).toEqual([]);
    }
  });

  it('follows a printer switch, replacing the last bed’s note rather than adding to it', async () => {
    await loadChair();
    await selectPrinter('bambu-x1c');
    expect(bedNotes()).toEqual([]);
    await selectPrinter('bambu-h2d');
    expect(bedNotes().map((n) => n.message)).toEqual([
      "The plate layout for all 13 parts hasn't been checked on a 350 × 320mm bed. " +
        'Check the parts and prime tower in your slicer before printing.',
    ]);
    await selectPrinter('bambu-x1c');
    expect(bedNotes()).toEqual([]);
  }, 30000);

  it('raises no second copy of a note at Export', async () => {
    await loadChair();
    await selectPrinter('bambu-h2d');
    const before = placementNotes();
    await exportPrintReady3MF();
    expect(placementNotes()).toEqual(before);
    expect(bedNotes()).toHaveLength(1);
  }, 30000);
});
