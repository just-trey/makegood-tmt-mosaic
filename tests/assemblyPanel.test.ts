// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DOM-only: stub the scene/scheduler/library side effects so importing the panel doesn't pull in
// three.js, fetch a parts manifest, or schedule a real rebuild.
vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/assembly/parts', () => ({
  applyAsmPatchChoice: vi.fn(),
  asmLoadFullAssembly: vi.fn(),
  asmRebuildGeneratedParts: vi.fn(),
  asmRemovePart: vi.fn(),
  onAssemblyPartsChanged: vi.fn(),
  switchChairVariant: vi.fn(),
}));
vi.mock('../src/ui/artworkListPanel', () => ({ renderArtworkList: vi.fn() }));
vi.mock('../src/state/artwork', () => ({ availableZones: () => [], clampArtworkModes: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));

import { renderAssemblyPartList, renderAssemblyRoleControls } from '../src/ui/assemblyPanel';
import { applyAsmPatchChoice } from '../src/assembly/parts';
import { state } from '../src/state/store';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import type { AssemblyPart } from '../src/types';

function part(over: Partial<AssemblyPart> = {}): AssemblyPart {
  return {
    id: 1,
    name: 'Wheel top',
    roleId: 'wheel-half',
    libraryPartId: 'wheel-half',
    positions: new Float32Array([0, 0, 0]),
    patches: null,
    patchIdx: 0,
    patchNormal: [0, 1, 0],
    boundaryLoops: null,
    topZ: 24.25,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
    ...over,
  } as unknown as AssemblyPart;
}

/**
 * Whether a kind auto-loads is decided by the parts manifest being reachable
 * (`asmKindCanAutoLoad`), not by anything on the kind — so the two cases below differ only in
 * whether the library has been populated, which is exactly what differs at runtime.
 */
const kind = ASSEMBLY_KINDS.find((k) => k.roles.every((r) => r.libraryPartId))!;
const libraryReachable = (yes: boolean) => {
  state.assembly.library = yes
    ? kind.roles.map((r) => ({
        id: r.libraryPartId!,
        name: r.name,
        file: `${r.libraryPartId}.3mf`,
      }))
    : [];
};

beforeEach(() => {
  document.body.innerHTML =
    '<div id="assembly-role-controls"></div><div id="assembly-part-list"></div>';
  state.shapeKind = 'assembly';
  state.assembly.kindId = kind.id;
  state.assembly.parts = [part()];
  libraryReachable(true);
  // The face-status test gives this mock a real implementation. Nothing in the config resets
  // mocks between tests, so without this it would leak into whatever is appended after it.
  vi.mocked(applyAsmPatchChoice).mockReset();
});

describe('the per-part rows in the Part panel', () => {
  it('offers no mesh drop target on a part that auto-loaded from the library', () => {
    renderAssemblyPartList();

    // The row is there, behind Advanced, with its face and alignment controls…
    expect(document.querySelector('.asm-adv')).not.toBeNull();
    expect(document.querySelector('[data-asm="baseDepth"]')).not.toBeNull();
    // …but nothing offers to replace the mesh the verified export placement is keyed to.
    expect(document.querySelector('[data-asm-drop]')).toBeNull();
    expect(document.querySelector('[data-asm-file]')).toBeNull();
  });

  // The app cannot check that an arbitrary mesh is the part it claims to be, and every verified
  // export pose is keyed to the shipped one — so an unreachable library is an error, not an
  // invitation to supply your own.
  it('reports an error and offers no way in when the library is unreachable', () => {
    libraryReachable(false);

    renderAssemblyRoleControls();
    renderAssemblyPartList();

    const err = document.querySelector('[data-asm-load-error]');
    expect(err?.textContent).toContain('Reload the page');
    expect(document.querySelector('[data-asm-drop]')).toBeNull();
    expect(document.querySelector('[data-asm-file]')).toBeNull();
    expect(document.querySelector('[data-role-add]')).toBeNull();
    expect(document.querySelector('#assembly-part-list')?.children).toHaveLength(0);
  });

  it('leaves the per-part face override in place — it is the only face control there is', () => {
    state.assembly.parts = [
      part({
        patches: [
          { area: 29403, normal: [0, 1, 0], offset: 24.25, triIndices: [] },
          { area: 120, normal: [0, -1, 0], offset: 0, triIndices: [] },
        ],
      }),
    ];

    renderAssemblyPartList();

    const face = document.querySelector<HTMLSelectElement>('[data-asm="patchIdx"]');
    expect(face).not.toBeNull();
    expect(face!.options).toHaveLength(2);
  });

  it('updates the face status line when the face changes, so it cannot contradict the dropdown', () => {
    // The real applyAsmPatchChoice also rebuilds boundaryLoops and restPositions, which need real
    // geometry. Only the two fields the status line reads are needed here.
    vi.mocked(applyAsmPatchChoice).mockImplementation((p: AssemblyPart) => {
      const patch = p.patches![p.patchIdx];
      p.patchNormal = patch.normal;
      p.topZ = patch.offset;
    });
    state.assembly.parts = [
      part({
        patches: [
          { area: 29403, normal: [0, 1, 0], offset: 24.25, triIndices: [] },
          { area: 4468, normal: [0, 0, -1], offset: -8, triIndices: [] },
        ],
      }),
    ];

    renderAssemblyPartList();
    const status = document.querySelector('[data-asm-face-status]')!;
    expect(status.textContent).toContain('normal (0.00, 1.00, 0.00)');

    const face = document.querySelector<HTMLSelectElement>('[data-asm="patchIdx"]')!;
    face.value = '1';
    face.dispatchEvent(new Event('change'));

    // The specific new values, not just "it changed": the bug this guards left the OLD normal
    // sitting above a dropdown naming the new one.
    expect(status.textContent).toContain('normal (0.00, 0.00, -1.00)');
    expect(status.textContent).toContain('plane offset -8.00mm');
  });
});
