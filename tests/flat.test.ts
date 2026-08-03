import { beforeEach, describe, expect, it } from 'vitest';
import { BACKGROUND_KEY, buildGeometry, type FlatBuildInput } from '../src/geometry/flat';
import { WARNINGS, clearWarnings } from '../src/warnings';
import type { ParsedSVG } from '../src/types';

function squareParsed(): ParsedSVG {
  const loops = [
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
  ];
  return {
    shapes: [{ fill: '#ff0000', loops, order: 0 }],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: null,
  };
}

function baseInput(overrides: Partial<FlatBuildInput> = {}): FlatBuildInput {
  return {
    parsed: squareParsed(),
    colorSettings: {},
    baseParams: {
      diameter: 80,
      thickness: 4,
      marginPct: 5,
      scaleMult: 1,
      offsetX: 0,
      offsetY: 0,
      flipX: false,
      flipY: false,
      rotationDeg: 0,
    },
    shapeKind: 'disc',
    globalDepth: 1,
    recessBg: true,
    mergeGroups: [],
    baseColorHex: '#b9c0c6',
    ...overrides,
  };
}

describe('buildGeometry background recess depth', () => {
  it('uses the global depth when no override is set', async () => {
    const built = (await buildGeometry(baseInput()))!;
    const bg = built.colorMeshes.find((c) => c.isBackground)!;
    expect(bg).toBeDefined();
    expect(bg.depth).toBeCloseTo(1);
    expect(bg.mesh.position.z).toBeCloseTo(4 - 1);
  });

  it('honors a per-background depth override from colorSettings', async () => {
    const built = (await buildGeometry(
      baseInput({ colorSettings: { [BACKGROUND_KEY]: { depth: 2.5 } } }),
    ))!;
    const bg = built.colorMeshes.find((c) => c.isBackground)!;
    expect(bg.depth).toBeCloseTo(2.5);
    expect(bg.mesh.position.z).toBeCloseTo(4 - 2.5);
  });

  it('clamps depth to the plate thickness', async () => {
    const built = (await buildGeometry(
      baseInput({ colorSettings: { [BACKGROUND_KEY]: { depth: 99 } } }),
    ))!;
    const bg = built.colorMeshes.find((c) => c.isBackground)!;
    expect(bg.depth).toBeCloseTo(4 - 0.05);
  });

  it('color regions keep their own per-key depth', async () => {
    const built = (await buildGeometry(
      baseInput({ colorSettings: { '#ff0000': { depth: 0.6 } } }),
    ))!;
    const red = built.colorMeshes.find((c) => c.key === '#ff0000')!;
    expect(red.depth).toBeCloseTo(0.6);
  });
});

describe('buildGeometry depth clamp warning', () => {
  beforeEach(() => clearWarnings());

  it('says so when a depth deeper than the plate is clamped', async () => {
    const built = (await buildGeometry(
      baseInput({ colorSettings: { '#ff0000': { depth: 100 } } }),
    ))!;
    expect(built.colorMeshes.find((c) => c.key === '#ff0000')!.depth).toBeCloseTo(3.95);
    expect(WARNINGS.map((w) => w.message)).toContain(
      'Depth for "#ff0000" was set to 100.00 mm, but a 4.00 mm plate can only cut 0.02–3.95 mm ' +
        'deep — it was cut at 3.95 mm instead.',
    );
    expect(WARNINGS.every((w) => w.build)).toBe(true);
  });

  it('says so when a zero or negative depth is clamped', async () => {
    for (const depth of [0, -1]) {
      clearWarnings();
      const built = (await buildGeometry(baseInput({ colorSettings: { '#ff0000': { depth } } })))!;
      expect(built.colorMeshes.find((c) => c.key === '#ff0000')!.depth).toBeCloseTo(0.02);
      expect(WARNINGS.some((w) => w.message.includes('it was cut at 0.02 mm instead.'))).toBe(true);
    }
  });

  it('names the background region rather than a hex', async () => {
    await buildGeometry(baseInput({ colorSettings: { [BACKGROUND_KEY]: { depth: 99 } } }));
    expect(WARNINGS.some((w) => w.message.startsWith('Depth for "Background" was set to'))).toBe(
      true,
    );
  });

  it('stays quiet for an in-range depth, and for an unset one', async () => {
    await buildGeometry(baseInput({ colorSettings: { '#ff0000': { depth: 2 } } }));
    await buildGeometry(baseInput());
    expect(WARNINGS).toHaveLength(0);
  });

  it('stays quiet when the clamp only moves the depth below the printed precision', async () => {
    // 3.951 clamps to 3.95 on a 4 mm plate. Warning about it would print "was set to 3.95 mm …
    // it was cut at 3.95 mm instead", which reads as a bug in the warning rather than a fact.
    await buildGeometry(baseInput({ colorSettings: { '#ff0000': { depth: 3.951 } } }));
    expect(WARNINGS).toHaveLength(0);
  });

  it('names a merged group the way the color list labels it', async () => {
    const parsed = squareParsed();
    parsed.shapes.push({
      fill: '#00ff00',
      loops: [
        [
          { x: 20, y: 0 },
          { x: 30, y: 0 },
          { x: 30, y: 10 },
          { x: 20, y: 10 },
        ],
      ],
      order: 1,
    });
    await buildGeometry(
      baseInput({
        parsed,
        mergeGroups: [['#ff0000', '#00ff00']],
        globalDepth: 100,
        recessBg: false,
      }),
    );
    expect(WARNINGS.some((w) => w.message.startsWith('Depth for "Merged (2)" was set to'))).toBe(
      true,
    );
    expect(WARNINGS.every((w) => !w.message.includes('(merged)'))).toBe(true);
  });

  it('warns on every rebuild, not only the first', async () => {
    // The clamped depth must never get written back into colorSettings as if the user had asked
    // for it — that silenced this warning from the second build onward while the depth stayed
    // wrong. Same input twice must report the same thing twice.
    const input = baseInput({ colorSettings: { '#ff0000': { depth: 100 } } });
    await buildGeometry(input);
    const first = WARNINGS.filter((w) => w.message.startsWith('Depth for')).length;
    clearWarnings();
    await buildGeometry(input);

    expect(first).toBeGreaterThan(0);
    expect(WARNINGS.filter((w) => w.message.startsWith('Depth for'))).toHaveLength(first);
  });
});
