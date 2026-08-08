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
  generatedPartsNeedRebuild,
  onAssemblyPartsChanged,
} from '../src/assembly/parts';
import {
  ASSEMBLY_KINDS,
  generatedDesignFaceOverride,
  generatedFitFactor,
  hubcapShapeFromState,
  hubcapSilhouetteOffset,
} from '../src/assembly/kinds';
import { designAnchor, designMmPerUnit } from '../src/geometry/assembly';
import {
  outlineBounds,
  outlineContains,
  outlineReach,
  placeArtworkPoint,
  type OutlinePt,
} from '../src/geometry/hubcapOutline';
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
import {
  HUBCAP_DEFAULT_DIAMETER_MM,
  HUBCAP_DISCONNECTED_WARNING,
  HUBCAP_SILHOUETTE_CAPPED_TO_WHEEL,
  HUBCAP_VERIFIED_DIAMETER_MM,
  HUBCAP_WHEEL_DIAMETER_MM,
} from '../src/geometry/hubcap';
import { alertDialog } from '../src/ui/dialogs';
import { state } from '../src/state/store';
import type { ArtworkInstance, AssemblyPart, AssemblyRole, ParsedSVG } from '../src/types';

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
  vi.mocked(track).mockClear();
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

  it('withholds the plate for a silhouette too, even at a verified diameter number', () => {
    // The verified arrangement was checked with a round disc. Once the part is cut to a
    // silhouette, hubcapDiameterMm is a longest-side reading of a shape that isn't round — the
    // clearance a circle of that size was checked at says nothing about what a traced photo
    // reaches on its off-axis corners.
    state.hubcapDiameterMm = HUBCAP_VERIFIED_DIAMETER_MM;
    state.hubcapSilhouette = true;

    expect(hubcapRole.buildPlacement!()).toBeUndefined();

    state.hubcapSilhouette = false;
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

    await expect(asmRebuildGeneratedParts()).resolves.toBe(false);

    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining('boolean engine gave up'));
    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining('still the previous size'));
    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining(hubcapKind.name));
  });

  it('leaves a failed rebuild owing one, rather than recording it as done', async () => {
    // The signature was stored before the build ran, so a failure was remembered as success and
    // the part kept its stale mesh forever — nothing retries, because nothing thinks it is owed.
    state.assembly.parts = [generatedPart()];
    // a size no earlier case in this file built at, so "still owed" is about THIS rebuild
    state.hubcapDiameterMm = 177;
    hubcapRole.buildMesh = vi.fn(async () => {
      throw new Error('boolean engine gave up');
    });

    await asmRebuildGeneratedParts();

    expect(generatedPartsNeedRebuild()).toBe(true);
  });

  it('re-runs when the artwork is re-traced to the same number of colours', async () => {
    // Detail-slider re-quantizing usually lands on the same colour count, so comparing counts held
    // still while the outline underneath changed: the picture updated and the part did not.
    state.hubcapSilhouette = true;
    const shapes = [{ fill: '#000', order: 0, loops: [] }];
    const parsedA = {
      shapes,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    } as unknown as ParsedSVG;
    state.sources = [{ id: 's1', kind: 'raster', name: 'a.png', parsed: parsedA, svgText: '' }];
    state.assembly.parts = [generatedPart()];
    hubcapRole.buildMesh = vi.fn(async (from: Float32Array) => ({
      positions: from.slice(),
      vertices: undefined,
    }));
    await asmRebuildGeneratedParts();
    expect(generatedPartsNeedRebuild()).toBe(false);

    // a re-trace: a NEW parsed object carrying the same shape count
    state.sources[0].parsed = {
      shapes: [{ fill: '#000', order: 0, loops: [] }],
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    } as unknown as ParsedSVG;

    expect(generatedPartsNeedRebuild()).toBe(true);

    state.hubcapSilhouette = false;
    state.sources = [];
  });
});

describe('which warning a generated hubcap raises', () => {
  it('reports loose pieces over anything cosmetic, when both are true', async () => {
    // These co-occur, which is the whole point: clipCoverage samples only the clip annulus, so a
    // detached island elsewhere passes it and the shape gets reported as merely thin — while the
    // part comes off the plate in pieces. `shape.warning ?? …` dropped the severe one whenever the
    // mild one existed. Built with the real clips asset and the real builder, because the
    // component count has to come from an actual boolean.
    const clips = await readMesh(resolve(REPO, 'public/stl/hubcap-clips.3mf'));
    state.hubcapSilhouette = true;
    state.hubcapDiameterMm = 220;
    state.scalePct = 100;
    state.offsetX = 0;
    state.offsetY = 0;
    state.rotationDeg = 0;
    state.flipX = false;
    state.flipY = false;

    // a blob over the clips, plus a detached hair-thin bar well away from it
    const canvas = { w: 512, h: 512 };
    const parsed = {
      shapes: [
        {
          fill: '#000',
          order: 0,
          // big enough that it still covers the clips after the outline centres on its own bbox,
          // which the detached bar below drags sideways
          loops: [
            [
              { x: 106, y: 106 },
              { x: 406, y: 106 },
              { x: 406, y: 406 },
              { x: 106, y: 406 },
            ],
          ],
        },
        {
          fill: '#111',
          order: 1,
          loops: [
            [
              { x: 460, y: 240 },
              { x: 461, y: 240 },
              { x: 461, y: 280 },
              { x: 460, y: 280 },
            ],
          ],
        },
      ],
      bbox: { minX: 106, minY: 106, maxX: 461, maxY: 406 },
      rawSVGCircle: null,
      userUnitMM: null,
      viewBox: canvas,
      canvas,
      origin: 'raster',
    } as unknown as ParsedSVG;
    state.sources = [{ id: 's1', kind: 'raster', name: 'a.png', parsed, svgText: '' }];
    state.parsed = parsed;
    state.artworks = [
      {
        id: 'a1',
        sourceId: 's1',
        zone: null,
        offsetU: 0,
        offsetV: 0,
        scalePct: 100,
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        mode: 'sticker',
      } as unknown as (typeof state.artworks)[number],
    ];
    state.activeArtworkId = 'a1';

    const shape = await hubcapShapeFromState();
    expect(shape.shape.kind).toBe('silhouette');
    // the fixture has to actually trip a cosmetic warning, or this proves nothing
    expect(shape.warning).toBeDefined();
    expect(shape.warning).not.toBe(HUBCAP_DISCONNECTED_WARNING);

    const out = await hubcapRole.buildMesh!(clips as Float32Array);

    expect(out.warning).toBe(HUBCAP_DISCONNECTED_WARNING);
    // A silhouette is cut flat, so its design face IS its outline and artwork reaching that
    // boundary is standing on the part's real outer wall — declare the shell's full 3mm.
    expect(out.edgeCutThroughDepth).toBe(3);

    state.hubcapSilhouette = false;
    state.sources = [];
    state.artworks = [];
    state.parsed = null;
  }, 60000);

  it('declares no edge rule on a round disc', async () => {
    // The circle is chamfered: its design face is inset 1mm from the rim, so a through-cut at the
    // face boundary would still leave a base-color ring and the rule would be a lie. The rule is
    // read off the shape that got BUILT, so every fallback-to-circle path is covered by this too
    // — including asking for a silhouette and not getting one.
    const clips = await readMesh(resolve(REPO, 'public/stl/hubcap-clips.3mf'));
    state.hubcapSilhouette = false;
    state.hubcapDiameterMm = 220;

    const out = await hubcapRole.buildMesh!(clips as Float32Array);
    expect(out.edgeCutThroughDepth).toBeUndefined();
  }, 60000);

  it('drops the edge rule when a silhouette falls back to a circle', async () => {
    // The toggle is on, but two artworks make an outline of two islands with no answer to which
    // one sizes the part, so hubcapShapeFromState rounds. A part left carrying the rule here would
    // through-cut the rim of a plain disc.
    const clips = await readMesh(resolve(REPO, 'public/stl/hubcap-clips.3mf'));
    state.hubcapSilhouette = true;
    state.hubcapDiameterMm = 220;
    state.artworks = [{ id: 'a1' }, { id: 'a2' }] as unknown as typeof state.artworks;

    const shape = await hubcapShapeFromState();
    expect(shape.shape.kind).toBe('circle');
    const out = await hubcapRole.buildMesh!(clips as Float32Array);
    expect(out.edgeCutThroughDepth).toBeUndefined();

    state.hubcapSilhouette = false;
    state.artworks = [];
  }, 60000);
});

describe('the diameter stays inside what the selected printer can print', () => {
  it('re-clamps when the kind becomes active again, not only on printer change', async () => {
    // The printer handler reads whichever kind is active *then*, so it does nothing while a kind
    // with no build parameter is selected. Without a clamp on the way back in, this route kept a
    // 320mm disc alive onto a 256mm bed: set it big on the H2D, leave the kind, change printer,
    // come back.
    // each bed's ceiling keeps PLATE_EDGE_MARGIN_MM of clearance on both sides
    const h2dMax = 320 - 10;
    const x1cMax = 256 - 10;
    state.printerId = 'bambu-h2d'; // 350x320
    await applyBuildParam(999);
    expect(state.hubcapDiameterMm).toBe(h2dMax);

    state.assembly.kindId = 'wheel'; // no buildParam — the printer handler is a no-op here
    state.printerId = 'bambu-x1c'; // 256x256
    await clampBuildParamToPrinter();
    expect(state.hubcapDiameterMm).toBe(h2dMax); // nothing has caught it yet, by design

    state.assembly.kindId = 'hubcap';
    syncAssemblyKindControls();
    await vi.waitFor(() => expect(state.hubcapDiameterMm).toBe(x1cMax));
  });

  it('reports the size that was built, not the one that was typed', async () => {
    state.printerId = 'bambu-x1c';

    await applyBuildParam(9999);

    expect(state.hubcapDiameterMm).toBe(246); // 256 less the edge clearance
    expect(track).toHaveBeenCalledWith(
      'build_param_changed',
      expect.objectContaining({ value: 246 }),
    );
  });

  it('renders the control against the kind and the selected printer', () => {
    state.printerId = 'bambu-x1c'; // 256x256
    syncAssemblyKindControls();

    const input = document.querySelector('#p-asm-buildparam') as HTMLInputElement;
    expect(document.querySelector('#asm-buildparam-label')!.textContent).toBe('Hubcap diameter');
    expect(Number(input.max)).toBe(246); // the plate less its edge clearance
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

  it('leaves clearance to the bed edge rather than ending exactly on it', async () => {
    // The ceiling used to be the plate exactly, so a disc could touch both edges and pass every
    // downstream check — the overhang warning allows 0.5mm, which a part 0.03mm inside slips under.
    state.printerId = 'bambu-h2d'; // 350x320

    await applyBuildParam(999);

    expect(state.hubcapDiameterMm).toBeLessThan(320);
    const input = document.querySelector('#p-asm-buildparam') as HTMLInputElement;
    expect(Number(input.max)).toBeLessThan(320);
  });

  it('puts the size back when the rebuild fails, so it still describes the mesh', async () => {
    // The parameter is what the rest of the app reads to DESCRIBE the built mesh. Left at a size
    // nothing was built at, the verified-plate lookup would pin a 250mm disc at the arrangement
    // checked for 220mm, and the template would be re-issued at a size that does not exist.
    state.printerId = 'snapmaker-u1';
    state.hubcapDiameterMm = 250;
    state.assembly.parts = [generatedPart()];
    hubcapRole.buildMesh = vi.fn(async () => {
      throw new Error('boolean engine gave up');
    });

    await applyBuildParam(200);

    expect(state.hubcapDiameterMm).toBe(250);
    // and nothing was reported for a build that never happened
    expect(track).not.toHaveBeenCalledWith('build_param_changed', expect.anything());
  });

  it('says nothing when the value did not move', async () => {
    state.hubcapDiameterMm = HUBCAP_DEFAULT_DIAMETER_MM;
    vi.mocked(track).mockClear();

    await applyBuildParam(HUBCAP_DEFAULT_DIAMETER_MM);

    expect(track).not.toHaveBeenCalled();
  });
});

/**
 * A hubcap cut to its artwork's shape is one object presented two ways — a part and a picture — and
 * every check here is about the two staying the same object. They are produced by different code
 * (a CrossSection union here, the cut's own placer there) so nothing but a test keeps them honest.
 */
describe('the silhouette and the artwork on it are one shape', () => {
  /** A parsed artwork whose drawn content is deliberately smaller than its sheet. */
  const parsedWith = (
    content: { x: number; y: number }[],
    canvas = { w: 512, h: 512 },
  ): ParsedSVG => {
    const xs = content.map((p) => p.x);
    const ys = content.map((p) => p.y);
    return {
      shapes: [{ fill: '#000', order: 0, loops: [content] }],
      bbox: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      },
      rawSVGCircle: null,
      userUnitMM: null,
      viewBox: canvas,
      canvas,
      origin: 'raster',
    } as ParsedSVG;
  };

  /** A centred square of side `w` on a 512 sheet, plus the instance that places it. */
  function loadArtwork(parsed: ParsedSVG, over: Partial<ArtworkInstance> = {}): void {
    state.sources = [{ id: 's1', kind: 'raster', name: 'a.png', parsed, svgText: '' }];
    state.parsed = parsed;
    state.artworks = [
      {
        id: 'a1',
        sourceId: 's1',
        zone: null,
        offsetU: 0,
        offsetV: 0,
        scalePct: 100,
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        mode: 'sticker',
        ...over,
      },
    ];
    state.activeArtworkId = 'a1';
  }

  const square = (w: number, cx = 256, cy = 256): { x: number; y: number }[] => [
    { x: cx - w / 2, y: cy - w / 2 },
    { x: cx + w / 2, y: cy - w / 2 },
    { x: cx + w / 2, y: cy + w / 2 },
    { x: cx - w / 2, y: cy + w / 2 },
  ];

  /** The mm-per-unit the CUT will use, straight from the shared helper. */
  const cutMmPerUnit = (parsed: ParsedSVG, scaleMult = 1): number =>
    designMmPerUnit(parsed, scaleMult, designAnchor(parsed, true).r, {
      isRect: true,
      radius: 0,
      designFace: () => generatedDesignFaceOverride(),
      generatedFit: generatedFitFactor,
    });

  beforeEach(() => {
    state.hubcapSilhouette = true;
    state.hubcapDiameterMm = 220;
    state.scalePct = 100;
    state.offsetX = 0;
    state.offsetY = 0;
    state.rotationDeg = 0;
    state.flipX = false;
    state.flipY = false;
  });

  afterEach(() => {
    state.hubcapSilhouette = false;
    state.sources = [];
    state.artworks = [];
    state.parsed = null;
    state.activeArtworkId = null;
  });

  it('sizes the outline off the sheet, exactly as the picture is sized', async () => {
    // The bug this pins: the outline was fitted to its own traced CONTENT bbox while the artwork
    // was scaled off the document CANVAS. A subject that doesn't fill its sheet — a padded PNG,
    // which is most of them — then printed the picture smaller than the shape cut for it.
    const parsed = parsedWith(square(300)); // 300 of a 512 sheet
    loadArtwork(parsed);

    const { shape } = await hubcapShapeFromState();
    if (shape.kind !== 'silhouette') throw new Error('expected a silhouette');

    const [x0, z0, x1, z1] = outlineBounds(shape.outline);
    // the picture's own scale says 300 units becomes 300 * mmPerUnit mm; the part has to agree
    const expected = 300 * cutMmPerUnit(parsed);
    expect(x1 - x0).toBeCloseTo(expected, 1);
    expect(z1 - z0).toBeCloseTo(expected, 1);
    // and that is NOT the same as fitting the content to the full 220 — the trap being closed
    expect(expected).toBeLessThan(219);
  }, 30000);

  it('follows the artwork through a rotation', async () => {
    // The cut applies rotationDeg; the outline ignored it, giving a rotated picture inside an
    // unrotated part. A 45-degree turn is the readable case: the bbox has to grow by root two.
    const parsed = parsedWith(square(300));
    loadArtwork(parsed, { rotationDeg: 45 });

    const { shape } = await hubcapShapeFromState();
    if (shape.kind !== 'silhouette') throw new Error('expected a silhouette');

    const [x0, z0, x1, z1] = outlineBounds(shape.outline);
    const side = 300 * cutMmPerUnit(parsed);
    expect(x1 - x0).toBeCloseTo(side * Math.SQRT2, 0);
    expect(z1 - z0).toBeCloseTo(side * Math.SQRT2, 0);
  }, 30000);

  it('shrinks the picture with the part when the wheel caps it', async () => {
    // The cap used to shrink the disc alone and leave the design scale where it was, so the outer
    // band of every colour region fell off the edge of the part it was cut into. The override is
    // what the artwork is scaled by, so it has to carry the cap.
    const parsed = parsedWith(square(500, 256, 256), { w: 512, h: 512 });
    loadArtwork(parsed, { scalePct: 300 });
    state.scalePct = 300;

    const { shape, warning } = await hubcapShapeFromState();
    if (shape.kind !== 'silhouette') throw new Error('expected a silhouette');

    // the part cleared the rim
    expect(outlineReach(shape.outline)).toBeLessThanOrEqual(HUBCAP_WHEEL_DIAMETER_MM / 2 + 0.5);
    expect(warning).toBe(HUBCAP_SILHOUETTE_CAPPED_TO_WHEEL);
    // and the picture came down with it: re-deriving the artwork's own scale reproduces the part
    const [x0, , x1] = outlineBounds(shape.outline);
    expect(x1 - x0).toBeCloseTo(500 * cutMmPerUnit(parsed, 3), 1);
  }, 30000);

  it('ignores a user offset entirely — the part centres on its clips', () => {
    // Offset is derived, not read: moving the picture relative to a part that IS the picture is
    // not meaningful, and honouring it cannot be made consistent because the cut finishes with the
    // design face's own centre, which for a silhouette is the thing being offset.
    const parsed = parsedWith(square(300));
    loadArtwork(parsed, { offsetU: 40, offsetV: -25 });

    return hubcapShapeFromState().then(({ shape }) => {
      if (shape.kind !== 'silhouette') throw new Error('expected a silhouette');
      const [x0, z0, x1, z1] = outlineBounds(shape.outline);
      expect((x0 + x1) / 2).toBeCloseTo(0, 6);
      expect((z0 + z1) / 2).toBeCloseTo(0, 6);
    });
  }, 30000);

  it('draws the template for the silhouette, not for a disc that is not there', async () => {
    const parsed = parsedWith(square(300));
    loadArtwork(parsed);
    await hubcapShapeFromState();

    const svg = hubcapKind.buildTemplate!();

    expect(svg).toContain('<path');
    expect(svg).not.toContain('<circle');
    expect(svg).toContain('square-cut');
  }, 30000);

  it('mirrors on each flip the same way the cut does', async () => {
    // A block with an arm off one side. Two properties this fixture needs and a rectangle hasn't:
    // its bbox centre must be solid (the part centres on its clips, so the clips land there), and
    // it must be asymmetric about that centre or a mirror is undetectable.
    const armed = [
      { x: 200, y: 200 },
      { x: 400, y: 200 },
      { x: 400, y: 280 },
      { x: 560, y: 280 },
      { x: 560, y: 320 },
      { x: 400, y: 320 },
      { x: 400, y: 400 },
      { x: 200, y: 400 },
    ];
    const parsed = parsedWith(armed);

    // Which side of the axis the material sits on. Bounds can't answer it — centring makes them
    // symmetric by construction — so measure area either side on a grid.
    const bias = async (over: Partial<ArtworkInstance>): Promise<number> => {
      loadArtwork(parsed, over);
      const { shape } = await hubcapShapeFromState();
      if (shape.kind !== 'silhouette') throw new Error('expected a silhouette');
      const [x0, z0, x1, z1] = outlineBounds(shape.outline);
      let right = 0;
      let left = 0;
      for (let i = 0; i < 80; i++)
        for (let j = 0; j < 80; j++) {
          const x = x0 + ((i + 0.5) / 80) * (x1 - x0);
          const z = z0 + ((j + 0.5) / 80) * (z1 - z0);
          if (!outlineContains(shape.outline, x, z)) continue;
          if (x > 0) right++;
          else left++;
        }
      return right - left;
    };

    const plainBias = await bias({});
    const flippedBias = await bias({ flipX: true });

    expect(plainBias).not.toBe(0);
    expect(Math.sign(plainBias)).toBe(-Math.sign(flippedBias));
  }, 30000);

  it('falls back to the global placement when no instance exists', async () => {
    // state.parsed with no ArtworkInstance shouldn't happen, but the build has the same fallback
    // (rebuild.ts) and the two have to agree about size — a silhouette read from the globals while
    // the cut read an instance, or vice versa, is the drift this whole seam exists to prevent.
    const parsed = parsedWith(square(300));
    state.sources = [];
    state.artworks = [];
    state.parsed = parsed;
    state.scalePct = 50;

    const { shape } = await hubcapShapeFromState();
    if (shape.kind !== 'silhouette') throw new Error('expected a silhouette');

    const [x0, , x1] = outlineBounds(shape.outline);
    expect(x1 - x0).toBeCloseTo(300 * cutMmPerUnit(parsed, 0.5), 1);
  }, 30000);

  /**
   * The invariant, over the awkward cases rather than one example.
   *
   * Every earlier test here compared bbox SIZES, which is why two ways of defeating the shared
   * transform survived a review round: an SVG declaring an absolute mm size returns from
   * designMmPerUnit before the design face is consulted (so the wheel cap never reached it), and
   * the cut ends with `+ faceCx`, the design face's own centre, which for a silhouette is the
   * outline being placed. Both put the picture off the shape while every size assertion passed.
   *
   * So: place the artwork exactly as the CUT will, and require every point to land on the part.
   */
  const cutPlacedPoints = (parsed: ParsedSVG, art: Partial<ArtworkInstance>): OutlinePt[] => {
    const a = state.artworks[0]!;
    const anchor = designAnchor(parsed, true);
    const mmPerUnit = cutMmPerUnit(parsed, (art.scalePct ?? 100) / 100);
    return parsed.shapes[0].loops[0].map((p) =>
      placeArtworkPoint(p.x, p.y, {
        cx: anchor.cx,
        cy: anchor.cy,
        mmPerUnit,
        xMul: a.flipX ? 1 : -1,
        zMul: a.flipY ? 1 : -1,
        rotationDeg: a.rotationDeg,
        offX: a.offsetU,
        offZ: a.offsetV,
      }),
    );
  };

  const FIXTURES: {
    why: string;
    canvas?: { w: number; h: number };
    mm?: number;
    art?: Partial<ArtworkInstance>;
  }[] = [
    { why: 'subject centred on its sheet', art: {} },
    { why: 'subject off-centre on its sheet', art: {} },
    { why: 'declares an absolute mm size', mm: 0.5 },
    // big enough that the wheel cap engages: the cap rides on generatedFit, and this is the branch
    // that returns before the design face is ever consulted
    { why: 'declares an absolute mm size past the wheel', mm: 1.5 },
    { why: 'rotated', art: { rotationDeg: 37 } },
    { why: 'mirrored horizontally', art: { flipX: true } },
    { why: 'mirrored vertically', art: { flipY: true } },
    { why: 'scaled up past the wheel', art: { scalePct: 400 } },
    { why: 'scaled down', art: { scalePct: 60 } },
    { why: 'offset by the user', art: { offsetU: 30, offsetV: -18 } },
  ];

  it.each(FIXTURES)(
    'the picture lands on the part — $why',
    async (f) => {
      const content =
        f.why === 'subject off-centre on its sheet' ? square(260, 330, 300) : square(300);
      const parsed = parsedWith(content);
      if (f.mm != null) (parsed as { userUnitMM?: number | null }).userUnitMM = f.mm;
      loadArtwork(parsed, f.art);

      const { shape } = await hubcapShapeFromState();
      if (shape.kind !== 'silhouette') throw new Error(`expected a silhouette for "${f.why}"`);
      // the rebuild applies the derived offset; do the same so the cut is placed as it really is
      const off = hubcapSilhouetteOffset()!;
      state.artworks[0].offsetU = off.x;
      state.artworks[0].offsetV = off.z;

      // The cut finishes with `+ faceCx`, the design face's bbox centre. It contributes nothing only
      // because the outline centres itself on the mounting axis — assert that rather than assume it,
      // since a non-zero centre is exactly how the picture slid off the shape before.
      const [cx0, cz0, cx1, cz1] = outlineBounds(shape.outline);
      expect((cx0 + cx1) / 2).toBeCloseTo(0, 6);
      expect((cz0 + cz1) / 2).toBeCloseTo(0, 6);

      // Pulled 2% toward the axis before testing. The artwork's own vertices are the part's edge, so
      // testing them raw asks an even-odd ray cast about points exactly on the boundary, where it is
      // undefined. 2% is far tighter than anything this has caught — the drifts were 12% and worse.
      for (const p of cutPlacedPoints(parsed, f.art ?? {})) {
        const x = p.x * 0.98;
        const z = p.z * 0.98;
        expect(
          outlineContains(shape.outline, x, z),
          `${f.why}: cut point (${x.toFixed(1)}, ${z.toFixed(1)}) fell outside the part`,
        ).toBe(true);
      }
    },
    30000,
  );

  it('draws the template mirrored, the way every baked template is', async () => {
    // scripts/gen-templates.mjs maps part->template as `bboxCx - (x - faceCx)` — both axes negate,
    // because a template is looked at from the side artwork is applied from. Emitting `x - x0`
    // instead is a 180-degree rotation: invisible on a disc or any symmetric shape, and wrong on
    // exactly the asymmetric silhouettes this feature is for. Only discovered after someone has
    // drawn on one and loaded it back, so it has to be pinned here.
    const armed = [
      { x: 200, y: 200 },
      { x: 400, y: 200 },
      { x: 400, y: 280 },
      { x: 560, y: 280 },
      { x: 560, y: 320 },
      { x: 400, y: 320 },
      { x: 400, y: 400 },
      { x: 200, y: 400 },
    ];
    const parsed = parsedWith(armed);
    loadArtwork(parsed);
    const { shape } = await hubcapShapeFromState();
    if (shape.kind !== 'silhouette') throw new Error('expected a silhouette');

    const [x0, z0, x1, z1] = outlineBounds(shape.outline);
    // the part's own furthest-back vertex, whose two candidate mappings differ in BOTH coordinates
    let tip = { x: 0, z: -Infinity };
    for (const r of shape.outline) for (const p of r) if (p.z > tip.z) tip = { x: p.x, z: p.z };
    const round2 = (v: number): number => Number(v.toFixed(2));
    const mirrored = `${round2(x1 - tip.x)},${round2(z1 - tip.z)}`;
    const naive = `${round2(tip.x - x0)},${round2(tip.z - z0)}`;
    expect(mirrored).not.toBe(naive); // the fixture actually discriminates

    const svg = hubcapKind.buildTemplate!();
    expect(svg).toContain(mirrored);
    expect(svg).not.toContain(naive);
  }, 30000);

  it('gives a fallback circle its own face, not the diameter it was asked for', async () => {
    // A disc's design face is 2mm smaller than its diameter — the chamfer. Reporting the diameter
    // here auto-fits artwork about 1% oversized, onto the bevel, where it gets cut away. Keying on
    // the toggle alone did exactly that for every case that asks for a silhouette and gets a disc.
    const parsed = parsedWith(square(300));
    loadArtwork(parsed);
    state.artworks.push({ ...state.artworks[0], id: 'a2' });

    const { shape } = await hubcapShapeFromState();

    expect(shape.kind).toBe('circle');
    expect(generatedDesignFaceOverride()).toBeNull();
    expect(generatedFitFactor()).toBe(1);
  }, 30000);

  it('goes back to the disc template once the silhouette is off', async () => {
    const parsed = parsedWith(square(300));
    loadArtwork(parsed);
    await hubcapShapeFromState();
    state.hubcapSilhouette = false;
    state.hubcapDiameterMm = 180;

    // live from the diameter, not the cached outline: the control moves and the link is re-read
    expect(hubcapKind.buildTemplate!()).toContain('178mm');
  }, 30000);
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

  it('keeps the suggested tower off the plate edge', async () => {
    // Flush in the corner is a position no bed can honour: the front-left of a Bambu plate carries
    // the nozzle-wipe exclusion, and nothing prints right up to a border. (0, 0) passed every
    // other check here — on the plate, not at the centre, clear of the part.
    const { blob } = await build3MFCombined(materials, [part({ plateHint: undefined })], {
      printer: getPrinter('bambu-x1c'),
    });

    const p = await proj(blob);
    expect(Number((p.wipe_tower_x as string[])[0])).toBeGreaterThanOrEqual(20);
    expect(Number((p.wipe_tower_y as string[])[0])).toBeGreaterThanOrEqual(20);
  });

  it('leaves the excluded front-left corner for last', async () => {
    // Every corner is equally free for a small centred part, and `reduce` keeps the earlier
    // candidate on a tie — so ordering front-left last is what keeps the tower out of the
    // nozzle-wipe exclusion without costing a suggestion anywhere.
    const { blob } = await build3MFCombined(materials, [part({ plateHint: undefined })], {
      printer: getPrinter('bambu-h2d'), // 350x320, roomy enough that corners are genuinely free
    });

    const p = await proj(blob);
    const x = Number((p.wipe_tower_x as string[])[0]);
    const y = Number((p.wipe_tower_y as string[])[0]);
    expect(x).toBeGreaterThan(350 / 2);
    expect(y).toBeGreaterThan(320 / 2);
  });

  it('writes no tower position at all when every corner is blocked', async () => {
    // Pinning the least-bad corner would make the file assert a placement the exporter has just
    // measured as colliding. The warning already says to move it; leaving the key out lets the
    // slicer apply its own printer-aware default instead of our known-bad one.
    const wide = new Float32Array([
      0, 0, 0, 240, 0, 0, 240, 0, 240, 0, 0, 0, 240, 0, 240, 0, 0, 240,
    ]);
    const { blob, warnings } = await build3MFCombined(
      materials,
      [
        {
          name: 'Wide',
          nsign: 1,
          bodySoup: wide,
          subs: [
            { name: 'Body', matIndex: 0, soup: wide },
            { name: 'Red', matIndex: 1, soup: wide },
          ],
        },
      ],
      { printer: getPrinter('bambu-x1c') },
    );

    const p = await proj(blob);
    expect(warnings.join(' ')).toContain('move the tower in your slicer');
    expect(p.wipe_tower_x).toBeUndefined();
    expect(p.wipe_tower_y).toBeUndefined();
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
