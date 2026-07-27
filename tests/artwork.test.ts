import { describe, expect, it, beforeEach } from 'vitest';
import {
  activeArtworkInstance,
  addInstanceForSource,
  availableZones,
  clearArtwork,
  clearArtworkZoneBindings,
  loadArtworkSource,
  pruneSettingsToPalette,
  removeArtworkInstance,
  setActiveArtwork,
  setArtworkMode,
  setArtworkZone,
  syncActiveArtworkPlacement,
} from '../src/state/artwork';
import { state } from '../src/state/store';
import type { AssemblyPart, ParsedSVG } from '../src/types';

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
});

/** A minimal zoned part carrying one named DesignZone, for the zone-targeting tests below. */
function zonedPart(
  id: number,
  zoneId: string,
  zoneName: string,
  templateFile?: string,
): AssemblyPart {
  return {
    id,
    name: `part-${id}`,
    roleId: 'r',
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoop: null,
    zones: [{ id: zoneId, name: zoneName, templateFile }],
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
});
