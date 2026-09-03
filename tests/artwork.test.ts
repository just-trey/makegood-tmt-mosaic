import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import {
  activeArtworkInstance,
  addInstanceForSource,
  availableZones,
  clampArtworkModes,
  clearArtwork,
  clearArtworkZoneBindings,
  CASCADE_CLEAR_MAX_MM,
  INSTANCE_CASCADE_MM,
  loadArtworkSource,
  pruneSettingsToPalette,
  removeArtworkInstance,
  setActiveArtwork,
  setArtworkMirror,
  setArtworkMode,
  setArtworkZone,
  syncActiveArtworkPlacement,
  zoneCoverage,
} from '../src/state/artwork';
import { state } from '../src/state/store';
import { OVERLAP_WARN_FRACTION } from '../src/geometry/designOverlap';
import type { AssemblyPart, ParsedSVG, ZoneMirror } from '../src/types';

function fakeParsed(): ParsedSVG {
  return {
    shapes: [],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: null,
  };
}

beforeEach(() => {
  state.parsed = null;
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  state.offsetX = 0;
  state.offsetY = 0;
  state.scalePct = 100;
  state.rotationDeg = 0;
  state.flipX = false;
  state.flipY = false;
  state.colorSettings = {};
  state.mergeGroups = [];
  state.baseColorKey = null;
  state.baseColorMembers = [];
  state.keptApart = [];
  state.assembly.parts = [];
  state.shapeKind = 'disc';
  state.assembly.kindId = null;
});

describe('Fill withheld on a kind that opts out', () => {
  function onKind(kindId: string): void {
    state.shapeKind = 'assembly';
    state.assembly.kindId = kindId;
  }

  it('clamps a Fill mode set on a withholding kind', () => {
    onKind('chair-body');
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkMode(a.id, 'fill');
    expect(activeArtworkInstance()!.mode).toBe('sticker');
  });

  it('leaves Fill alone on a kind that offers it', () => {
    onKind('wheel');
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkMode(a.id, 'fill');
    expect(activeArtworkInstance()!.mode).toBe('fill');
  });

  it('re-clamps artwork carried onto a withholding kind by a part switch', () => {
    // The hole a UI-only gate would leave: artwork outlives the switch, so a design set to Fill on
    // the wheel arrives on the chair still set to Fill.
    onKind('wheel');
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkMode(a.id, 'fill');
    onKind('chair-body');
    expect(clampArtworkModes()).toBe(true);
    expect(activeArtworkInstance()!.mode).toBe('sticker');
  });

  it('keeps Fill through a detour into a flat mode, which only ignores it', () => {
    onKind('wheel');
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkMode(a.id, 'fill');
    state.shapeKind = 'disc';
    expect(clampArtworkModes()).toBe(false);
    expect(activeArtworkInstance()!.mode).toBe('fill');
  });

  it('does not inherit a withheld Fill onto a second placement', () => {
    onKind('wheel');
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkMode(a.id, 'fill');
    onKind('chair-body');
    state.assembly.parts = [zonedPart(1, 'right', 'Right side')];
    expect(addInstanceForSource(a.sourceId, 'right').mode).toBe('sticker');
  });
});

/** A minimal zoned part carrying one named DesignZone, for the zone-targeting tests below. */
function zonedPart(
  id: number,
  zoneId: string,
  zoneName: string,
  templateFile?: string,
  mirror?: ZoneMirror,
): AssemblyPart {
  return {
    id,
    name: `part-${id}`,
    roleId: 'r',
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
    zones: [{ id: zoneId, name: zoneName, templateFile, mirror }],
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

describe('loadArtworkSource', () => {
  it('creates one source and one auto-instance on the implicit default zone', () => {
    const parsed = fakeParsed();
    const instance = loadArtworkSource(parsed, 'test.svg');

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].name).toBe('test.svg');
    expect(state.sources[0].kind).toBe('upload');
    expect(state.sources[0].parsed).toBe(parsed);

    expect(state.artworks).toHaveLength(1);
    expect(state.artworks[0]).toBe(instance);
    expect(instance.sourceId).toBe(state.sources[0].id);
    expect(instance.zone).toBeNull();
    expect(instance.mode).toBe('sticker');
    expect(state.activeArtworkId).toBe(instance.id);
  });

  it('leaves the instance unbound when the assembly offers a single zone', () => {
    state.assembly.parts = [zonedPart(1, 'only', 'Only')];
    expect(loadArtworkSource(fakeParsed(), 'a.svg').zone).toBeNull();
  });

  // "All zones" remains a real choice in the picker; it just isn't the default once there is more
  // than one, where it would stamp the design onto every surface of the chair at once — five zones
  // spanning 25 conformal charts, recut on every slider nudge, to produce a result nobody asked for.
  it('binds to the first zone when the assembly offers several', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left'), zonedPart(2, 'seat', 'Seat')];
    const instance = loadArtworkSource(fakeParsed(), 'a.svg');

    expect(instance.zone).toEqual({ partId: 1, zoneId: 'left' });
    expect(availableZones()[0].zoneId).toBe('left');
  });

  it('seeds instance placement from the current global fit fields', () => {
    state.offsetX = 3;
    state.offsetY = -4;
    state.scalePct = 150;
    state.rotationDeg = 30;
    state.flipX = true;
    state.flipY = true;

    const instance = loadArtworkSource(fakeParsed(), 'a.svg');

    expect(instance.offsetU).toBe(3);
    expect(instance.offsetV).toBe(-4);
    expect(instance.scalePct).toBe(150);
    expect(instance.rotationDeg).toBe(30);
    expect(instance.flipX).toBe(true);
    expect(instance.flipY).toBe(true);
  });

  it('accumulates sources/instances on a second load and makes the new one active', () => {
    const first = loadArtworkSource(fakeParsed(), 'first.svg');
    const second = loadArtworkSource(fakeParsed(), 'second.svg');

    expect(state.sources).toHaveLength(2);
    expect(state.artworks).toHaveLength(2);
    expect(state.sources.map((s) => s.name)).toEqual(['first.svg', 'second.svg']);
    expect(state.activeArtworkId).toBe(second.id);
    expect(state.artworks).toContain(first);
  });

  it('assigns each instance a distinct id across loads', () => {
    const first = loadArtworkSource(fakeParsed(), 'first.svg');
    const second = loadArtworkSource(fakeParsed(), 'second.svg');
    expect(first.id).not.toBe(second.id);
  });
});

// A design landing exactly on top of the one already there produces overlapping recesses that
// nothing downstream can tell apart from one design — see geometry/designOverlap.ts.
describe('stacked-instance cascade', () => {
  // assembly mode only — flat plate mode renders state.parsed alone, so there is no second design
  // on screen for a step to separate from
  beforeEach(() => {
    state.shapeKind = 'assembly';
  });

  it('steps a second design off the first on a single-zone part', () => {
    state.assembly.parts = [zonedPart(1, 'only', 'Only')];
    const first = loadArtworkSource(fakeParsed(), 'first.svg');
    const second = loadArtworkSource(fakeParsed(), 'second.svg');

    expect(first.offsetU).toBe(0);
    expect(first.offsetV).toBe(0);
    expect(second.offsetU).toBe(INSTANCE_CASCADE_MM);
    expect(second.offsetV).toBe(INSTANCE_CASCADE_MM);
  });

  it('keeps stepping for a third design', () => {
    loadArtworkSource(fakeParsed(), 'a.svg');
    loadArtworkSource(fakeParsed(), 'b.svg');
    expect(loadArtworkSource(fakeParsed(), 'c.svg').offsetU).toBe(INSTANCE_CASCADE_MM * 2);
  });

  it('steps relative to the seed offset, not from zero', () => {
    loadArtworkSource(fakeParsed(), 'a.svg');
    state.offsetX = 20;
    state.offsetY = -5;
    const second = loadArtworkSource(fakeParsed(), 'b.svg');
    // nothing is at (20, -5), so it lands exactly there
    expect(second.offsetU).toBe(20);
    expect(second.offsetV).toBe(-5);
  });

  it('leaves the first/only design on a part untouched', () => {
    state.offsetX = 12;
    state.offsetY = 9;
    const only = loadArtworkSource(fakeParsed(), 'a.svg');
    expect(only.offsetU).toBe(12);
    expect(only.offsetV).toBe(9);
  });

  it('does not step a design going onto a different zone', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left'), zonedPart(2, 'seat', 'Seat')];
    const first = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(first.id, 'seat');
    const second = loadArtworkSource(fakeParsed(), 'b.svg'); // defaults to 'left'

    expect(second.zone?.zoneId).toBe('left');
    expect(second.offsetU).toBe(0);
    expect(second.offsetV).toBe(0);
  });

  it('steps a second design bound to the same zone of a multi-zone part', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left'), zonedPart(2, 'seat', 'Seat')];
    loadArtworkSource(fakeParsed(), 'a.svg');
    const second = loadArtworkSource(fakeParsed(), 'b.svg'); // both default to 'left'

    expect(second.zone?.zoneId).toBe('left');
    expect(second.offsetU).toBe(INSTANCE_CASCADE_MM);
  });

  it('steps a "+zone" instance placed back onto the zone it came from', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left'), zonedPart(2, 'seat', 'Seat')];
    const first = loadArtworkSource(fakeParsed(), 'a.svg');
    const again = addInstanceForSource(first.sourceId, 'left');

    expect(again.offsetU).toBe(INSTANCE_CASCADE_MM);
    expect(again.offsetV).toBe(INSTANCE_CASCADE_MM);
  });

  it('leaves a "+zone" instance on a genuinely different zone at neutral', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left'), zonedPart(2, 'seat', 'Seat')];
    const first = loadArtworkSource(fakeParsed(), 'a.svg');
    const onSeat = addInstanceForSource(first.sourceId, 'seat');

    expect(onSeat.offsetU).toBe(0);
    expect(onSeat.offsetV).toBe(0);
  });

  it('makes the stepped placement the one the fit sliders show', () => {
    loadArtworkSource(fakeParsed(), 'a.svg');
    loadArtworkSource(fakeParsed(), 'b.svg');
    expect(state.offsetX).toBe(INSTANCE_CASCADE_MM);
    expect(state.offsetY).toBe(INSTANCE_CASCADE_MM);
  });

  // An "All zones" instance is stamped onto every surface, so a zone-bound design seeded at the
  // same spot lands on top of it — the exact case this cascade exists to prevent.
  it('steps off an "All zones" design already covering every surface', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left'), zonedPart(2, 'seat', 'Seat')];
    const first = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(first.id, null);

    const second = loadArtworkSource(fakeParsed(), 'b.svg'); // binds to 'left'

    expect(second.zone?.zoneId).toBe('left');
    expect(second.offsetU).toBe(INSTANCE_CASCADE_MM);
  });

  it('steps an "All zones" design off a zone-bound one it would cover', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left'), zonedPart(2, 'seat', 'Seat')];
    const first = loadArtworkSource(fakeParsed(), 'a.svg'); // binds to 'left'

    const everywhere = addInstanceForSource(first.sourceId, null);

    expect(everywhere.zone).toBeNull();
    expect(everywhere.offsetU).toBe(INSTANCE_CASCADE_MM);
  });
});

// The constant step is only loud enough on a design big enough for 8mm to leave a tenth of it
// covered. Below that it seeded an overlap the build then said nothing about, so the step scales.
describe('cascade step against the placed design size', () => {
  // fakeParsed is 10 SVG units wide and carries no boundary circle, so it anchors on its own bbox
  // at r=5 and the wheel branch places it at (asmRadius / 5) * 10 mm across.
  const placedMM = (asmRadius: number): number => asmRadius * 2;

  function twoDesigns(asmRadius: number): number {
    state.sources = [];
    state.artworks = [];
    state.parsed = null;
    state.activeArtworkId = null;
    state.offsetX = 0;
    state.offsetY = 0;
    state.shapeKind = 'assembly';
    state.asmRadius = asmRadius;
    loadArtworkSource(fakeParsed(), 'first.svg');
    return loadArtworkSource(fakeParsed(), 'second.svg').offsetU;
  }

  afterEach(() => {
    state.asmRadius = 138;
  });

  it('steps a 10mm design its own width, which clears it', () => {
    expect(twoDesigns(5)).toBe(placedMM(5));
  });

  it('keeps the constant for a design the constant already warns about', () => {
    expect(twoDesigns(20)).toBe(INSTANCE_CASCADE_MM); // 40mm across
  });

  it('never steps further than the largest design it clears', () => {
    for (let r = 1; r <= 30; r += 0.5)
      expect(twoDesigns(r)).toBeLessThanOrEqual(CASCADE_CLEAR_MAX_MM);
  });

  // Every design on one surface has to step along the same lattice. Sizing the step off the pair
  // being separated instead let a smaller design land between two of a bigger one's spots.
  it('does not park a small design inside one already cascaded past it', () => {
    twoDesigns(5); // two 10mm designs, at 0 and at 10
    state.offsetX = 0;
    state.offsetY = 0;
    state.scalePct = 50; // a 5mm third design, seeded back on the first
    const third = loadArtworkSource(fakeParsed(), 'third.svg');
    state.scalePct = 100;
    // 5mm wide at 20mm out clears the 10mm design centred on 10; 8mm out would sit inside it
    expect(third.offsetU).toBe(20);
  });

  // The check this whole change exists for: for two designs shaped alike, on a surface carrying
  // nothing bigger, no size makes the cascade both fail to separate them AND leave them under the
  // threshold that would warn about it. Both qualifiers are load-bearing, see docs/tech-debt.md.
  it('leaves no size where the step neither clears nor warns', () => {
    for (let r = 1; r <= 40; r += 0.25) {
      const w = placedMM(r);
      const step = twoDesigns(r);
      const covered = (Math.max(0, w - step) / w) ** 2;
      expect(step >= w || covered >= OVERLAP_WARN_FRACTION, `${w}mm design stepped ${step}mm`).toBe(
        true,
      );
    }
  });
});

// Flat plate mode draws state.parsed and nothing else, so a second design is never on screen —
// stepping would walk each freshly loaded SVG further off the plate for no visible reason, and the
// overlap warning that explains the step in assembly mode never runs here.
describe('stacked-instance cascade — flat mode', () => {
  it('leaves every load at the seed offset', () => {
    state.shapeKind = 'disc';

    const first = loadArtworkSource(fakeParsed(), 'a.svg');
    const second = loadArtworkSource(fakeParsed(), 'b.svg');
    const third = loadArtworkSource(fakeParsed(), 'c.svg');

    expect([first.offsetU, second.offsetU, third.offsetU]).toEqual([0, 0, 0]);
    expect(state.offsetX).toBe(0);
  });
});

describe('activeArtworkInstance', () => {
  it('returns null when nothing is loaded', () => {
    expect(activeArtworkInstance()).toBeNull();
  });

  it('returns the instance matching activeArtworkId', () => {
    const instance = loadArtworkSource(fakeParsed(), 'a.svg');
    expect(activeArtworkInstance()).toBe(instance);
  });
});

describe('syncActiveArtworkPlacement', () => {
  it('mirrors current global fit fields onto the active instance', () => {
    const instance = loadArtworkSource(fakeParsed(), 'a.svg');
    state.offsetX = 7;
    state.offsetY = 8;
    state.scalePct = 80;
    state.rotationDeg = 90;
    state.flipX = true;
    state.flipY = false;

    syncActiveArtworkPlacement();

    expect(instance.offsetU).toBe(7);
    expect(instance.offsetV).toBe(8);
    expect(instance.scalePct).toBe(80);
    expect(instance.rotationDeg).toBe(90);
    expect(instance.flipX).toBe(true);
    expect(instance.flipY).toBe(false);
  });

  it('is a no-op when there is no active instance', () => {
    expect(() => syncActiveArtworkPlacement()).not.toThrow();
  });
});

describe('clearArtwork', () => {
  it('drops parsed/sources/artworks/activeArtworkId and artwork-specific settings', () => {
    state.parsed = fakeParsed();
    loadArtworkSource(state.parsed, 'a.svg');
    state.colorSettings = { '#fff': { depth: 1 } };
    state.mergeGroups = [['#fff', '#000']];
    state.baseColorKey = '#fff';
    state.baseColorMembers = ['#fff'];
    state.keptApart = ['#000'];

    clearArtwork();

    expect(state.parsed).toBeNull();
    expect(state.sources).toEqual([]);
    expect(state.artworks).toEqual([]);
    expect(state.activeArtworkId).toBeNull();
    expect(state.colorSettings).toEqual({});
    expect(state.mergeGroups).toEqual([]);
    expect(state.baseColorKey).toBeNull();
    expect(state.baseColorMembers).toEqual([]);
    expect(state.keptApart).toEqual([]);
  });

  it('leaves placement fields (offset/scale/rotation/flip) untouched — a preference, not artwork data', () => {
    state.offsetX = 5;
    state.scalePct = 150;
    state.rotationDeg = 45;
    state.flipX = true;
    loadArtworkSource(fakeParsed(), 'a.svg');

    clearArtwork();

    expect(state.offsetX).toBe(5);
    expect(state.scalePct).toBe(150);
    expect(state.rotationDeg).toBe(45);
    expect(state.flipX).toBe(true);
  });
});

describe('setActiveArtwork', () => {
  it('pulls the target instance placement into the legacy global fit fields', () => {
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    a.offsetU = 11;
    a.offsetV = -5;
    a.scalePct = 60;
    a.rotationDeg = 270;
    a.flipX = true;
    a.flipY = true;
    const bParsed = fakeParsed();
    loadArtworkSource(bParsed, 'b.svg'); // becomes active; globals now mirror b

    setActiveArtwork(a.id);

    expect(state.activeArtworkId).toBe(a.id);
    expect(state.offsetX).toBe(11);
    expect(state.offsetY).toBe(-5);
    expect(state.scalePct).toBe(60);
    expect(state.rotationDeg).toBe(270);
    expect(state.flipX).toBe(true);
    expect(state.flipY).toBe(true);
    // state.parsed follows the active instance's own source, not whichever loaded last
    expect(state.parsed).not.toBe(bParsed);
  });

  it('is a no-op on an unknown id', () => {
    loadArtworkSource(fakeParsed(), 'a.svg');
    const before = state.offsetX;
    setActiveArtwork('nope');
    expect(state.offsetX).toBe(before);
  });
});

describe('availableZones / setArtworkZone', () => {
  it('dedupes zone ids across parts and reports each one once', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left side'), zonedPart(2, 'right', 'Right side')];
    expect(availableZones()).toEqual([
      { zoneId: 'left', name: 'Left side' },
      { zoneId: 'right', name: 'Right side' },
    ]);
  });

  it('passes through each zone’s template filename, for the per-zone download links', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left side', 'left-template.svg')];
    expect(availableZones()).toEqual([
      { zoneId: 'left', name: 'Left side', templateFile: 'left-template.svg' },
    ]);
  });

  it('is empty when no loaded part carries zones', () => {
    expect(availableZones()).toEqual([]);
  });

  it('binds an instance to a zone, resolving partId from the part that carries it', () => {
    state.assembly.parts = [zonedPart(7, 'left', 'Left side')];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');

    setArtworkZone(a.id, 'left');
    expect(a.zone).toEqual({ partId: 7, zoneId: 'left' });

    setArtworkZone(a.id, null);
    expect(a.zone).toBeNull();
  });

  it('reports each zone’s baked mirror relation', () => {
    state.assembly.parts = [
      zonedPart(1, 'right', 'Right side', undefined, { twin: 'left' }),
      zonedPart(2, 'front', 'Front', undefined, { self: true }),
    ];
    expect(availableZones()).toEqual([
      { zoneId: 'right', name: 'Right side', mirror: { twin: 'left' } },
      { zoneId: 'front', name: 'Front', mirror: { self: true } },
    ]);
  });

  it('drops mirror when the instance is rebound to a zone with none', () => {
    state.assembly.parts = [
      zonedPart(1, 'right', 'Right side', undefined, { twin: 'left' }),
      zonedPart(2, 'seat', 'Seat'),
    ];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'right');
    setArtworkMirror(a.id, true);
    expect(a.mirror).toBe(true);

    setArtworkZone(a.id, 'seat');
    expect(a.mirror).toBe(false);
  });

  it('drops mirror when the instance is unbound to "All zones"', () => {
    state.assembly.parts = [zonedPart(1, 'right', 'Right side', undefined, { twin: 'left' })];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'right');
    setArtworkMirror(a.id, true);

    setArtworkZone(a.id, null);
    expect(a.mirror).toBe(false);
  });

  it('keeps mirror when rebound to a different zone that also offers one', () => {
    // The order restoreSession runs in: the pool restores with mirror already set, then every
    // instance's zone is rebound via setArtworkZone as if the user had just picked it.
    state.assembly.parts = [
      zonedPart(1, 'right', 'Right side', undefined, { twin: 'left' }),
      zonedPart(2, 'front', 'Front', undefined, { self: true }),
    ];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'right');
    setArtworkMirror(a.id, true);

    setArtworkZone(a.id, 'front');
    expect(a.mirror).toBe(true);
  });
});

describe('setArtworkMirror', () => {
  it('turns mirror on only when the bound zone offers one', () => {
    state.assembly.parts = [zonedPart(1, 'right', 'Right side', undefined, { twin: 'left' })];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'right');

    setArtworkMirror(a.id, true);
    expect(a.mirror).toBe(true);

    setArtworkMirror(a.id, false);
    expect(a.mirror).toBe(false);
  });

  it('leaves mirror off when the bound zone offers none', () => {
    state.assembly.parts = [zonedPart(1, 'seat', 'Seat')];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'seat');

    setArtworkMirror(a.id, true);
    expect(a.mirror).toBe(false);
  });

  it('leaves mirror off on an unbound ("All zones") instance', () => {
    state.assembly.parts = [zonedPart(1, 'right', 'Right side', undefined, { twin: 'left' })];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');

    setArtworkMirror(a.id, true);
    expect(a.mirror).toBe(false);
  });
});

describe('zoneCoverage', () => {
  it('counts a mirrored instance’s twin zone as covered', () => {
    state.assembly.parts = [
      zonedPart(1, 'right', 'Right side', undefined, { twin: 'left' }),
      zonedPart(2, 'left', 'Left side', undefined, { twin: 'right' }),
    ];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'right');

    expect(zoneCoverage()).toEqual({ total: 2, covered: 1 });

    setArtworkMirror(a.id, true);
    expect(zoneCoverage()).toEqual({ total: 2, covered: 2 });
  });

  it('does not double-count a self-mirrored zone', () => {
    state.assembly.parts = [zonedPart(1, 'front', 'Front', undefined, { self: true })];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'front');
    setArtworkMirror(a.id, true);

    expect(zoneCoverage()).toEqual({ total: 1, covered: 1 });
  });
});

describe('addInstanceForSource', () => {
  it('creates a second instance on the same source with neutral placement, and activates it', () => {
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    state.offsetX = 20; // simulate the user having moved the first instance
    state.assembly.parts = [zonedPart(1, 'right', 'Right side')];

    const b = addInstanceForSource(a.sourceId, 'right');

    expect(state.artworks).toHaveLength(2);
    expect(b.sourceId).toBe(a.sourceId);
    expect(b.zone).toEqual({ partId: 1, zoneId: 'right' });
    expect(b.offsetU).toBe(0);
    expect(b.scalePct).toBe(100);
    expect(state.activeArtworkId).toBe(b.id);
  });

  it('inherits sticker/fill from the source’s existing instance, unlike placement', () => {
    const a = loadArtworkSource(fakeParsed(), 'pattern.svg', 'pattern', 'fill');
    state.assembly.parts = [zonedPart(1, 'right', 'Right side')];
    expect(addInstanceForSource(a.sourceId, 'right').mode).toBe('fill');
  });
});

describe('setArtworkMode', () => {
  it('switches one instance between sticker and fill', () => {
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    expect(a.mode).toBe('sticker');
    setArtworkMode(a.id, 'fill');
    expect(activeArtworkInstance()!.mode).toBe('fill');
    setArtworkMode(a.id, 'sticker');
    expect(activeArtworkInstance()!.mode).toBe('sticker');
  });

  it('leaves other instances alone, and ignores an unknown id', () => {
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    const b = loadArtworkSource(fakeParsed(), 'b.svg');
    setArtworkMode(a.id, 'fill');
    expect(state.artworks.find((x) => x.id === b.id)!.mode).toBe('sticker');
    expect(() => setArtworkMode('nope', 'fill')).not.toThrow();
  });
});

describe('removeArtworkInstance', () => {
  it('removes one instance and its source when it was the source’s only instance', () => {
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    removeArtworkInstance(a.id);
    expect(state.artworks).toEqual([]);
    expect(state.sources).toEqual([]);
    expect(state.parsed).toBeNull(); // falls all the way through to clearArtwork()
  });

  it('keeps the source alive when another instance still uses it', () => {
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    state.assembly.parts = [zonedPart(1, 'right', 'Right side')];
    const b = addInstanceForSource(a.sourceId, 'right');

    removeArtworkInstance(b.id);

    expect(state.artworks).toEqual([a]);
    expect(state.sources.map((s) => s.id)).toEqual([a.sourceId]);
  });

  it('reactivates a remaining instance when the active one is removed', () => {
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    const b = loadArtworkSource(fakeParsed(), 'b.svg');
    expect(state.activeArtworkId).toBe(b.id);

    removeArtworkInstance(b.id);

    expect(state.activeArtworkId).toBe(a.id);
  });
});

describe('pruneSettingsToPalette', () => {
  /** A parsed design that paints with exactly these hexes. */
  function parsedWith(...fills: string[]): ParsedSVG {
    return {
      ...fakeParsed(),
      shapes: fills.map((fill) => ({
        fill,
        loops: [
          [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
          ],
        ],
      })),
    } as ParsedSVG;
  }

  it('keeps settings whose colors are still painted by some loaded design', () => {
    loadArtworkSource(parsedWith('#ff0000', '#0000ff'), 'a.svg');
    state.colorSettings = { '#ff0000': { depth: 1.5 }, 'merge:#0000ff,#ff0000': { depth: 2 } };
    state.mergeGroups = [['#ff0000', '#0000ff']];
    state.keptApart = ['#0000ff'];
    state.baseColorKey = '#ff0000';
    state.baseColorMembers = ['#ff0000'];

    loadArtworkSource(parsedWith('#00ff00'), 'b.svg');
    pruneSettingsToPalette();

    expect(state.mergeGroups).toEqual([['#ff0000', '#0000ff']]);
    expect(state.keptApart).toEqual(['#0000ff']);
    expect(state.baseColorKey).toBe('#ff0000');
    expect(Object.keys(state.colorSettings).sort()).toEqual(['#ff0000', 'merge:#0000ff,#ff0000']);
  });

  it('drops a base assignment whose color no longer exists anywhere', () => {
    const a = loadArtworkSource(parsedWith('#0000ff'), 'a.svg');
    loadArtworkSource(parsedWith('#ff0000'), 'b.svg');
    state.baseColorKey = '#0000ff';
    state.baseColorMembers = ['#0000ff'];
    state.keptApart = ['#0000ff'];
    state.mergeGroups = [['#0000ff', '#ff0000']];
    state.colorSettings = { '#0000ff': { depth: 1 }, '#ff0000': { depth: 2 } };

    // removing the only design that painted blue is what strands the base assignment — leaving it
    // would silently exclude #0000ff from being cut the next time some design happens to use it
    removeArtworkInstance(a.id);

    expect(state.baseColorKey).toBeNull();
    expect(state.baseColorMembers).toEqual([]);
    expect(state.keptApart).toEqual([]);
    expect(state.mergeGroups).toEqual([]); // one live member left, so no group at all
    expect(state.colorSettings).toEqual({ '#ff0000': { depth: 2 } });
  });

  it('prunes assembly-mode depth keys by the hex behind their "asm:" prefix', () => {
    const a = loadArtworkSource(parsedWith('#0000ff'), 'a.svg');
    loadArtworkSource(parsedWith('#ff0000'), 'b.svg');
    state.colorSettings = {
      'asm:#0000ff': { depth: 3 },
      'asm:#ff0000': { depth: 2 },
      'asm:merge:#0000ff,#00ff00': { depth: 1 },
      'asm:__background__': { depth: 4 },
    };

    removeArtworkInstance(a.id);

    // a stale asm:#0000ff would silently cut at 3 mm the next time any design painted blue
    expect(Object.keys(state.colorSettings).sort()).toEqual(['asm:#ff0000', 'asm:__background__']);
  });

  it('reseats baseColorKey on a surviving member rather than clearing the whole base', () => {
    const a = loadArtworkSource(parsedWith('#0000ff'), 'a.svg');
    loadArtworkSource(parsedWith('#ff0000'), 'b.svg');
    state.baseColorKey = '#0000ff';
    state.baseColorMembers = ['#0000ff', '#ff0000'];

    removeArtworkInstance(a.id);

    expect(state.baseColorMembers).toEqual(['#ff0000']);
    expect(state.baseColorKey).toBe('#ff0000');
  });
});

describe('clearArtworkZoneBindings', () => {
  it('unbinds every instance without touching sources/instances themselves', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left side')];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'left');

    clearArtworkZoneBindings();

    expect(a.zone).toBeNull();
    expect(state.artworks).toHaveLength(1);
  });

  it('clears mirror along with the zone binding', () => {
    state.assembly.parts = [zonedPart(1, 'right', 'Right side', undefined, { twin: 'left' })];
    const a = loadArtworkSource(fakeParsed(), 'a.svg');
    setArtworkZone(a.id, 'right');
    setArtworkMirror(a.id, true);

    clearArtworkZoneBindings();

    expect(a.mirror).toBe(false);
  });
});
