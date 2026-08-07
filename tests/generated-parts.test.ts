// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { resolve } from 'node:path';
import {
  readMesh,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/mesh.mjs';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/ui/dialogs', () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));

import {
  asmCreateRolePart,
  asmRebuildGeneratedParts,
  onAssemblyPartsChanged,
} from '../src/assembly/parts';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import {
  applyBuildParam,
  clampBuildParamToPrinter,
  syncAssemblyKindControls,
} from '../src/ui/assemblyPanel';
import { track } from '../src/analytics/track';
import { build3MFCombined, type ExportPart } from '../src/export/threemf';
import { getPrinter } from '../src/export/printers';
import {
  placementNotice,
  resolvePlacement,
  type PlacementResolution,
} from '../src/export/placement';
import { HUBCAP_DEFAULT_DIAMETER_MM, HUBCAP_VERIFIED_DIAMETER_MM } from '../src/geometry/hubcap';
import { alertDialog } from '../src/ui/dialogs';
import { state } from '../src/state/store';
import type { AssemblyPart, AssemblyRole } from '../src/types';

/**
 * A part whose mesh the app *builds* rather than loads has no fingerprint to hang a verified plate
 * pose off — its geometry varies by design. What it can have is an arrangement a human checked at
 * one size, and these cover the seam that decides which of those two situations you are in.
 */

// process.cwd(), not import.meta.url: this suite runs under jsdom, where import.meta.url is not a
// file: URL and fileURLToPath throws at collection time.
const REPO = resolve(process.cwd());
const hubcapKind = ASSEMBLY_KINDS.find((k) => k.id === 'hubcap')!;
const hubcapRole = hubcapKind.roles.find((r) => r.id === 'hubcap')!;
const realBuildMesh = hubcapRole.buildMesh;

/** A flat square — enough geometry for the loader's face detection to have something to find. */
const squareSoup = (): Float32Array =>
  new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10]);

/**
 * Narrow a resolution to its unverified arm. `PlacementResolution` is a discriminated union and
 * `reason` only exists on that side, so every assertion about a reason needs this — asserting
 * `verified` is false first doesn't narrow the value for the next line.
 */
function unverified(r: PlacementResolution): Extract<PlacementResolution, { verified: false }> {
  if (r.verified) throw new Error(`expected no verified placement, got one for "${r.key}"`);
  return r;
}

function generatedPart(over: Partial<AssemblyPart> = {}): AssemblyPart {
  const p = asmCreateRolePart({ id: 'hubcap', name: 'Hubcap' } as AssemblyRole);
  Object.assign(p, {
    libraryPartId: 'hubcap-clips',
    assetPositions: squareSoup(),
    positions: squareSoup(),
    loaded: true,
    ...over,
  });
  return p;
}

/**
 * The left panel's markup, enough of it for the functions under test to do their work.
 *
 * Without this they hit their `if (!row || !input) return` guards and every assertion below passes
 * against a function that did nothing — the control's own clamping and re-issuing is most of what
 * these tests are about.
 */
function mountPanel(): void {
  document.body.innerHTML = `
    <div id="asm-radius-row"></div>
    <div id="asm-buildparam-row"><label id="asm-buildparam-label"></label>
      <input type="number" id="p-asm-buildparam" /></div>
    <div id="asm-template-row"><a id="asm-template-link"></a></div>
    <div id="asm-zone-template-row"><span id="asm-zone-template-links"></span></div>
    <div id="asm-variant-row"><span id="asm-variant-controls"></span></div>
    <div id="assembly-part-list"></div>
    <div id="asm-role-controls"></div>
  `;
  // jsdom implements neither, and syncTemplateLink revokes the previous URL on every call
  URL.createObjectURL = vi.fn(() => 'blob:hubcap-template');
  URL.revokeObjectURL = vi.fn();
}

beforeEach(() => {
  mountPanel();
  state.shapeKind = 'assembly';
  state.assembly.kindId = 'hubcap';
  state.assembly.parts = [];
  state.assembly.nextPartId = 1;
  state.hubcapDiameterMm = HUBCAP_DEFAULT_DIAMETER_MM;
  state.printerId = 'snapmaker-u1'; // 270x270 — a bed with a verified arrangement
  onAssemblyPartsChanged(() => {});
  vi.mocked(alertDialog).mockClear().mockResolvedValue(undefined);
});

afterEach(() => {
  hubcapRole.buildMesh = realBuildMesh;
  state.assembly.kindId = null;
  state.assembly.parts = [];
  state.shapeKind = 'disc';
  state.printerId = 'bambu-x1c';
});

describe('resolvePlacement for a generated part', () => {
  it('uses the role’s verified arrangement when the current size is one a human checked', () => {
    state.hubcapDiameterMm = HUBCAP_VERIFIED_DIAMETER_MM;

    const r = resolvePlacement(generatedPart());

    expect(r.verified).toBe(true);
    expect(r.placement!.plateHint).toBe(1);
    expect(r.placement!.fixedPosByPlate).toHaveProperty('270x270');
    expect(r.placement!.primeTowerDeltaByPlate).toHaveProperty('270x270');
  });

  it('reports generated-part once the size is past what was verified', () => {
    state.hubcapDiameterMm = HUBCAP_VERIFIED_DIAMETER_MM + 10;

    const r = resolvePlacement(generatedPart());

    expect(r.placement).toBeUndefined();
    expect(unverified(r).reason).toBe('generated-part');
  });

  it('reports generated-part on a bed nobody has checked', () => {
    state.printerId = 'bambu-h2d'; // 350x320 — no entry in the verified table

    expect(unverified(resolvePlacement(generatedPart())).reason).toBe('generated-part');
  });

  it('never calls it a mesh mismatch — a generated mesh is built to vary', () => {
    // The asset check runs before the fingerprint on purpose: 'mesh-mismatch' means the repo's own
    // assets drifted, which is a defect, and a mesh that can never match a seal is not that.
    state.hubcapDiameterMm = HUBCAP_VERIFIED_DIAMETER_MM + 10;

    const r = resolvePlacement(generatedPart({ positions: new Float32Array([1, 2, 3]) }));

    expect(unverified(r).reason).toBe('generated-part');
  });

  it('goes back to the ordinary path once the user drops their own mesh in', () => {
    // asmAdoptMesh clears assetPositions on an upload, and that is what makes this report as the
    // upload it is rather than as something generated.
    const r = resolvePlacement(generatedPart({ assetPositions: undefined, meshFromUpload: true }));

    expect(unverified(r).reason).not.toBe('generated-part');
  });
});

describe('placementNotice for a generated part', () => {
  it('gives the size as the reason, as information rather than a defect', () => {
    state.hubcapDiameterMm = HUBCAP_VERIFIED_DIAMETER_MM + 10;

    const notice = placementNotice('Hubcap', resolvePlacement(generatedPart()))!;

    expect(notice.level).toBe('info');
    expect(notice.message).toContain('generated to the size you chose');
    // the shared suffix exportPanel matches on to retract a stale one
    expect(notice.message).toContain('check it in your slicer before printing');
  });

  it('says nothing at all when the size is a verified one', () => {
    state.hubcapDiameterMm = HUBCAP_VERIFIED_DIAMETER_MM;

    expect(placementNotice('Hubcap', resolvePlacement(generatedPart()))).toBeNull();
  });
});

describe('the hubcap role’s own hooks', () => {
  it('resolves the verified plate against the printer selected now, not a fixed bed', () => {
    state.hubcapDiameterMm = HUBCAP_VERIFIED_DIAMETER_MM;

    state.printerId = 'snapmaker-u1';
    expect(hubcapRole.buildPlacement!()!.fixedPosByPlate).toHaveProperty('270x270');

    state.printerId = 'bambu-x1c';
    expect(hubcapRole.buildPlacement!()!.fixedPosByPlate).toHaveProperty('256x256');
  });

  it('withholds the plate rather than guessing, above the verified diameter', () => {
    state.hubcapDiameterMm = HUBCAP_VERIFIED_DIAMETER_MM + 0.5;

    expect(hubcapRole.buildPlacement!()).toBeUndefined();
  });

  it('turns a disc that missed the clips into a warning the user sees', async () => {
    // The geometry of that case is hubcap.test.ts's; what this covers is the role's own mapping —
    // components > 1 has to become a message, or the part exports as loose pieces in silence.
    const clips = await readMesh(resolve(REPO, 'public/stl/hubcap-clips.3mf'));
    state.hubcapDiameterMm = 20; // inside the clip ring, so nothing fuses

    const built = await realBuildMesh!(clips);

    expect(built.positions.length).toBeGreaterThan(0);
    expect(built.warning).toContain('too small to reach its mounting clips');
  }, 30000);

  it('builds silently at a size that does fuse', async () => {
    const clips = await readMesh(resolve(REPO, 'public/stl/hubcap-clips.3mf'));
    state.hubcapDiameterMm = HUBCAP_DEFAULT_DIAMETER_MM;

    const built = await realBuildMesh!(clips);

    expect(built.positions.length).toBeGreaterThan(0);
    expect(built.warning).toBeUndefined();
  }, 30000);
});

describe('asmRebuildGeneratedParts', () => {
  it('does nothing for a part that isn’t generated, or when there are none', async () => {
    const rebuilt = vi.fn();
    hubcapRole.buildMesh = rebuilt;

    await asmRebuildGeneratedParts();
    state.assembly.parts = [generatedPart({ assetPositions: undefined })];
    await asmRebuildGeneratedParts();

    expect(rebuilt).not.toHaveBeenCalled();
  });

  it('rebuilds from the stored asset, not from the mesh it built last time', async () => {
    const asset = squareSoup();
    state.assembly.parts = [generatedPart({ assetPositions: asset })];
    const rebuilt = vi.fn(async (from: Float32Array) => ({
      positions: from.slice(),
      vertices: undefined,
    }));
    hubcapRole.buildMesh = rebuilt;

    await asmRebuildGeneratedParts();

    expect(rebuilt).toHaveBeenCalledTimes(1);
    // Identity, not equality: the builder returns a copy, so a deep check would pass even if it
    // had been handed its own previous output — which is what would compound every resize.
    expect(rebuilt.mock.calls[0][0]).toBe(asset);
  });

  it('rebuilds every generated part and leaves the rest alone', async () => {
    state.assembly.parts = [
      generatedPart(),
      generatedPart(),
      generatedPart({ assetPositions: undefined }),
    ];
    const rebuilt = vi.fn(async (from: Float32Array) => ({
      positions: from.slice(),
      vertices: undefined,
    }));
    hubcapRole.buildMesh = rebuilt;

    await asmRebuildGeneratedParts();

    expect(rebuilt).toHaveBeenCalledTimes(2);
  });

  it('says so when a rebuild fails, instead of leaving a stale mesh unexplained', async () => {
    // The caller fires this with `void`, so an unhandled rejection would be invisible — while the
    // control already showed the new size and the part in the scene, and in any export, did not.
    state.assembly.parts = [generatedPart()];
    hubcapRole.buildMesh = vi.fn(async () => {
      throw new Error('boolean engine gave up');
    });

    await expect(asmRebuildGeneratedParts()).resolves.toBeUndefined();

    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining('boolean engine gave up'));
    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining('still the previous size'));
    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining(hubcapKind.name));
  });
});

describe('the diameter stays inside what the selected printer can print', () => {
  it('re-clamps when the kind becomes active again, not only on printer change', async () => {
    // The printer handler reads whichever kind is active *then*, so it does nothing while a kind
    // with no build parameter is selected. Without a clamp on the way back in, this route kept a
    // 320mm disc alive onto a 256mm bed: set it big on the H2D, leave the kind, change printer,
    // come back.
    state.printerId = 'bambu-h2d'; // 350x320
    await applyBuildParam(320);
    expect(state.hubcapDiameterMm).toBe(320);

    state.assembly.kindId = 'wheel'; // no buildParam — the printer handler is a no-op here
    state.printerId = 'bambu-x1c'; // 256x256
    await clampBuildParamToPrinter();
    expect(state.hubcapDiameterMm).toBe(320); // nothing has caught it yet, by design

    state.assembly.kindId = 'hubcap';
    syncAssemblyKindControls();
    await vi.waitFor(() => expect(state.hubcapDiameterMm).toBe(256));
  });

  it('reports the size that was built, not the one that was typed', async () => {
    state.printerId = 'bambu-x1c';

    await applyBuildParam(9999);

    expect(state.hubcapDiameterMm).toBe(256);
    expect(track).toHaveBeenCalledWith(
      'build_param_changed',
      expect.objectContaining({ value: 256 }),
    );
  });

  it('renders the control against the kind and the selected printer', () => {
    state.printerId = 'bambu-x1c'; // 256x256
    syncAssemblyKindControls();

    const input = document.querySelector('#p-asm-buildparam') as HTMLInputElement;
    expect(document.querySelector('#asm-buildparam-label')!.textContent).toBe('Hubcap diameter');
    expect(Number(input.max)).toBe(256); // the plate, not an invented constant
    expect(Number(input.min)).toBeCloseTo(32.09, 1);
    // `any`, or `min` becomes the step base and the default lands off-grid as :invalid
    expect(input.step).toBe('any');
    expect(document.querySelector<HTMLElement>('#asm-buildparam-row')!.style.display).not.toBe(
      'none',
    );
  });

  it('hides the control for a kind that has no build parameter', () => {
    state.assembly.kindId = 'wheel';
    syncAssemblyKindControls();

    expect(document.querySelector<HTMLElement>('#asm-buildparam-row')!.style.display).toBe('none');
  });

  it('re-issues the generated template whenever the size changes', async () => {
    syncAssemblyKindControls();
    vi.mocked(URL.createObjectURL).mockClear();

    await applyBuildParam(180);

    // a generated template is true-to-size only for the size it was built at
    expect(URL.createObjectURL).toHaveBeenCalled();
    const svg = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(await svg.text()).toContain('178mm'); // 180 less the 1mm chamfer each side
  });

  it('puts the live value back when the field is left empty', async () => {
    state.hubcapDiameterMm = HUBCAP_DEFAULT_DIAMETER_MM;
    syncAssemblyKindControls();
    const input = document.querySelector('#p-asm-buildparam') as HTMLInputElement;
    input.value = '';

    await applyBuildParam(NaN);

    expect(input.value).toBe(String(HUBCAP_DEFAULT_DIAMETER_MM));
    expect(state.hubcapDiameterMm).toBe(HUBCAP_DEFAULT_DIAMETER_MM);
  });

  it('says nothing when the value did not move', async () => {
    state.hubcapDiameterMm = HUBCAP_DEFAULT_DIAMETER_MM;
    vi.mocked(track).mockClear();

    await applyBuildParam(HUBCAP_DEFAULT_DIAMETER_MM);

    expect(track).not.toHaveBeenCalled();
  });
});

describe('a bed-specific plate position in the exporter', () => {
  const soup = new Float32Array([0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 0, 20, 0, 20, 0, 0, 20]);
  const materials = [
    { name: 'Body', color: '#cccccc' },
    { name: 'Red', color: '#ff0000' },
  ];
  const part = (over: Partial<ExportPart> = {}): ExportPart => ({
    name: 'Generated',
    nsign: 1,
    bodySoup: soup,
    subs: [
      { name: 'Body', matIndex: 0, soup },
      { name: 'Red', matIndex: 1, soup },
    ],
    plateHint: 1,
    ...over,
  });

  async function proj(blob: Blob): Promise<Record<string, unknown>> {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    return JSON.parse(await zip.file('Metadata/project_settings.config')!.async('string'));
  }
  async function itemXY(blob: Blob): Promise<{ x: number; y: number }> {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const model = await zip.file('3D/3dmodel.model')!.async('string');
    const t = /<item[^>]*transform="([^"]+)"/.exec(model)![1].split(/\s+/).map(Number);
    return { x: t[9], y: t[10] };
  }

  it('takes a matching bed position verbatim, off the reference plate as much as on it', async () => {
    // A per-bed position is authored for exactly this plate, so the group re-centering `fixedPos`
    // gets on a non-reference bed must not touch it — re-centering exists to rescue a coordinate
    // authored elsewhere, and would silently discard a verified one.
    const { blob } = await build3MFCombined(
      materials,
      [part({ fixedPosByPlate: { '270x270': { x: 149.5842, y: 148.0757 } } })],
      { printer: getPrinter('snapmaker-u1') },
    );

    const at = await itemXY(blob);
    expect(at.x).toBeCloseTo(149.5842, 3);
    expect(at.y).toBeCloseTo(148.0757, 3);
  });

  it('ignores a bed position authored for a different plate', async () => {
    const { blob } = await build3MFCombined(
      materials,
      [part({ fixedPosByPlate: { '256x256': { x: 141.192, y: 142.3629 } } })],
      { printer: getPrinter('snapmaker-u1') },
    );

    // Nothing verified for this bed, so it centres on the 270 plate instead. The translate is the
    // part's origin, not its centre — a 20mm part centred on 135 sits at 125.
    const at = await itemXY(blob);
    expect(at.x).toBeCloseTo(125, 3);
    expect(at.y).toBeCloseTo(125, 3);
  });

  it('anchors the prime tower off a per-bed delta alone', async () => {
    // The anchor search used to require `primeTowerDelta`, so a part carrying only the per-bed
    // form fell through to the suggested corner — discarding a position verified for that plate.
    const { blob } = await build3MFCombined(
      materials,
      [
        part({
          fixedPosByPlate: { '270x270': { x: 149.5842, y: 148.0757 } },
          primeTowerDeltaByPlate: { '270x270': { x: -122.0354, y: -120.228 } },
        }),
      ],
      { printer: getPrinter('snapmaker-u1') },
    );

    const p = await proj(blob);
    expect(Number((p.wipe_tower_x as string[])[0])).toBeCloseTo(27.5488, 2);
    expect(Number((p.wipe_tower_y as string[])[0])).toBeCloseTo(27.8477, 2);
  });

  it('suggests a tower that lands on the plate and clear of a centred part', async () => {
    // wipe_tower_x/y is the tower's front-left corner, so the suggestion has to BE a corner. When
    // it was a centre, a part centred on the plate got a tower at 30..90 — inside it — and the far
    // corners resolved to 226..286, off a 256mm plate entirely. Both without a word.
    const TOWER = 60;
    for (const printerId of ['bambu-x1c', 'snapmaker-u1', 'bambu-h2d']) {
      const printer = getPrinter(printerId);
      const { blob } = await build3MFCombined(materials, [part({ plateHint: undefined })], {
        printer,
      });
      const p = await proj(blob);
      const x = Number((p.wipe_tower_x as string[])[0]);
      const y = Number((p.wipe_tower_y as string[])[0]);

      // the whole nominal footprint has to be on the bed, corner to corner
      expect(x, `${printerId} tower x`).toBeGreaterThanOrEqual(0);
      expect(y, `${printerId} tower y`).toBeGreaterThanOrEqual(0);
      expect(x + TOWER, `${printerId} tower right edge`).toBeLessThanOrEqual(printer.plate.w);
      expect(y + TOWER, `${printerId} tower far edge`).toBeLessThanOrEqual(printer.plate.d);

      // and clear of the 20mm part sitting on the plate centre
      const pc = { x: printer.plate.w / 2, y: printer.plate.d / 2 };
      const clearOnX = x + TOWER <= pc.x - 10 || x >= pc.x + 10;
      const clearOnY = y + TOWER <= pc.y - 10 || y >= pc.y + 10;
      expect(clearOnX || clearOnY, `${printerId} tower overlaps the centred part`).toBe(true);
    }
  });

  it('keeps a far-corner suggestion on the plate', async () => {
    // The case a centred, small part cannot reach: put a part over the near corner so the FAR one
    // wins. Scored as a centre and emitted as a corner, the far corner resolved to plateW − 30,
    // which with a 60mm tower runs 30mm off the back of the bed. The near corner hides this —
    // it is wrong by the same +30 but still lands on the plate.
    const TOWER = 60;
    const big = new Float32Array([
      0, 0, 0, 100, 0, 0, 100, 0, 100, 0, 0, 0, 100, 0, 100, 0, 0, 100,
    ]);
    const printer = getPrinter('bambu-x1c'); // 256x256
    const { blob } = await build3MFCombined(
      materials,
      [
        {
          name: 'Corner hog',
          nsign: 1,
          bodySoup: big,
          subs: [
            { name: 'Body', matIndex: 0, soup: big },
            { name: 'Red', matIndex: 1, soup: big },
          ],
          plateHint: 1,
          fixedPos: { x: 0, y: 0 }, // occupies 0..100 in both axes
        },
      ],
      { printer },
    );

    const p = await proj(blob);
    const x = Number((p.wipe_tower_x as string[])[0]);
    const y = Number((p.wipe_tower_y as string[])[0]);
    expect(x + TOWER).toBeLessThanOrEqual(printer.plate.w);
    expect(y + TOWER).toBeLessThanOrEqual(printer.plate.d);
    // and it did pick the far corner, so this really exercised that branch
    expect(x).toBeGreaterThan(printer.plate.w / 2);
  });

  it('writes a baked project setting and declares it an override', async () => {
    // Written but not declared, a reload/resave can reconcile it back to the preset's default —
    // which for a tower width would retire the clearance the position was verified against.
    const { blob } = await build3MFCombined(
      materials,
      [part({ projectSettings: { prime_tower_width: '30' } })],
      { printer: getPrinter('snapmaker-u1') },
    );

    const p = await proj(blob);
    expect(p.prime_tower_width).toBe('30');
    expect((p.different_settings_to_system as string[])[0].split(';')).toContain(
      'prime_tower_width',
    );
  });
});
