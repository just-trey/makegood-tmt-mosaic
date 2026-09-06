// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same stubbing as assemblyPanel.test.ts: the module under test pulls in three.js and the parts
// manifest transitively, and only renderZoneTemplateLinks itself is under test here. state/artwork
// stays real, unlike assemblyPanel.test.ts's own mock of it, since the point of this file is
// availableZones() actually reporting the Whole chair entry.
vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/assembly/parts', () => ({
  applyAsmPatchChoice: vi.fn(),
  asmLoadFullAssembly: vi.fn(),
  asmRebuildGeneratedParts: vi.fn(),
  asmRemovePart: vi.fn(),
  onAssemblyPartsChanged: vi.fn(),
  partsLibrarySettled: vi.fn(() => true),
  switchChairVariant: vi.fn(),
}));
vi.mock('../src/ui/artworkListPanel', () => ({ renderArtworkList: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));

import { renderZoneTemplateLinks } from '../src/ui/assemblyPanel';
import { track } from '../src/analytics/track';
import { state } from '../src/state/store';
import { WHOLE_CHAIR_ZONE } from '../src/geometry/zones';
import type { ConformalChart } from '../src/geometry/conformal';
import type { ZoneNet } from '../src/geometry/zoneCharts';
import type { AssemblyPart } from '../src/types';

function chartWithBounds(): ConformalChart {
  return {
    positions3: new Float32Array(),
    uv: new Float32Array(),
    triangles: new Uint32Array(),
    normalSign: 1,
    boundary: [],
    zoneBounds: { minU: 0, minV: 0, maxU: 10, maxV: 10 },
  };
}

function netPart(id: number, zoneId: string, templateFile: string): AssemblyPart {
  return {
    id,
    name: `part-${id}`,
    roleId: 'r',
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
    zones: [{ id: zoneId, name: zoneId, templateFile, chart: chartWithBounds() }],
    topZ: 0,
    baseDepth: 1,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  };
}

const NET: ZoneNet = {
  templateFile: 'net-template.svg',
  bounds: { minU: 0, minV: 0, maxU: 20, maxV: 20 },
  zones: {
    left: { name: 'left', rotationDeg: 0, offsetU: 0, offsetV: 0, attached: true },
    back: { name: 'back', rotationDeg: 0, offsetU: 0, offsetV: 0, attached: true },
  },
};

beforeEach(() => {
  document.body.innerHTML =
    '<div class="hint" id="asm-zone-template-row" style="display: none">' +
    '<span id="asm-zone-template-links"></span></div>';
  state.shapeKind = 'assembly';
  state.assembly.kindId = 'chair-body';
  state.assembly.parts = [];
  state.assembly.net = null;
});

describe('renderZoneTemplateLinks — Whole chair', () => {
  it('adds a Whole chair link pointing at the net template once a net is loaded', () => {
    state.assembly.parts = [
      netPart(1, 'left', 'left-template.svg'),
      netPart(2, 'back', 'back-template.svg'),
    ];
    state.assembly.net = NET;

    renderZoneTemplateLinks();

    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('#asm-zone-template-links a'),
    );
    expect(links[0]).toMatchObject({
      textContent: 'Whole chair',
      href: expect.stringContaining('net-template.svg'),
    });
    expect(links.map((a) => a.textContent)).toEqual(['Whole chair', 'left', 'back']);
  });

  it('omits it with no net loaded, same as before this feature', () => {
    state.assembly.parts = [netPart(1, 'left', 'left-template.svg')];

    renderZoneTemplateLinks();

    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('#asm-zone-template-links a'),
    );
    expect(links.map((a) => a.textContent)).toEqual(['left']);
  });

  it('tracks a Whole chair download under its own zone id, like any other zone link', () => {
    state.assembly.parts = [
      netPart(1, 'left', 'left-template.svg'),
      netPart(2, 'back', 'back-template.svg'),
    ];
    state.assembly.net = NET;
    renderZoneTemplateLinks();

    document.querySelector<HTMLAnchorElement>('#asm-zone-template-links a')!.click();

    expect(track).toHaveBeenCalledWith('template_download', {
      kind: 'chair-body',
      zone: WHOLE_CHAIR_ZONE,
    });
  });
});
