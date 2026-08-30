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

function threeColorParsed(): ParsedSVG {
  const bar = (x0: number, x1: number) => [
    [
      { x: x0, y: 0 },
      { x: x1, y: 0 },
      { x: x1, y: 10 },
      { x: x0, y: 10 },
    ],
  ];
  return {
    shapes: [
      { fill: '#ff0000', loops: bar(0, 12), order: 0 },
      { fill: '#00ff00', loops: bar(12, 21), order: 1 },
      { fill: '#0000ff', loops: bar(21, 27), order: 2 },
    ],
    bbox: { minX: 0, minY: 0, maxX: 27, maxY: 10 },
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
      'Depth for "#ff0000" was set to 100.00 mm, but a 4.00 mm plate can only cut 3.95 mm deep. ' +
        'It was cut at 3.95 mm instead.',
    );
    expect(WARNINGS.every((w) => w.build)).toBe(true);
  });

  it('says so when a zero or negative depth is clamped', async () => {
    for (const depth of [0, -1]) {
      clearWarnings();
      const built = (await buildGeometry(baseInput({ colorSettings: { '#ff0000': { depth } } })))!;
      expect(built.colorMeshes.find((c) => c.key === '#ff0000')!.depth).toBeCloseTo(0.2);
      expect(WARNINGS.some((w) => w.message.includes('It was raised to 0.20 mm.'))).toBe(true);
    }
  });

  it('says it once for every color at that depth, not once per color', async () => {
    await buildGeometry(baseInput({ parsed: threeColorParsed(), globalDepth: 0, recessBg: false }));

    const zero = WARNINGS.filter((w) => w.message.includes('is not a depth that can cut'));
    expect(zero.map((w) => w.message)).toEqual([
      'Depths for "#0000ff", "#00ff00", "#ff0000" were set to 0.00 mm, which is not a depth ' +
        'that can cut. They were raised to 0.20 mm.',
    ]);
  });

  it('keeps two different requested depths in two messages', async () => {
    // Grouping on "was raised at all" would put both in one message and quote one of them the
    // other's number.
    await buildGeometry(
      baseInput({
        parsed: threeColorParsed(),
        recessBg: false,
        colorSettings: {
          '#ff0000': { depth: 0 },
          '#00ff00': { depth: -1 },
          '#0000ff': { depth: 0 },
        },
      }),
    );

    expect(
      WARNINGS.filter((w) => w.message.includes('is not a depth that can cut')).map(
        (w) => w.message,
      ),
    ).toEqual([
      'Depths for "#0000ff", "#ff0000" were set to 0.00 mm, which is not a depth that can cut. ' +
        'They were raised to 0.20 mm.',
      'Depth for "#00ff00" was set to -1.00 mm, which is not a depth that can cut. It was ' +
        'raised to 0.20 mm.',
    ]);
  });

  it('names the background alongside the colors it shares a depth with', async () => {
    await buildGeometry(baseInput({ parsed: threeColorParsed(), globalDepth: 0 }));

    const zero = WARNINGS.filter((w) => w.message.includes('is not a depth that can cut'));
    expect(zero).toHaveLength(1);
    expect(zero[0].message).toContain('"#ff0000", "Background"');
  });

  it('names the background region rather than a hex', async () => {
    await buildGeometry(baseInput({ colorSettings: { [BACKGROUND_KEY]: { depth: 99 } } }));
    expect(WARNINGS.some((w) => w.message.startsWith('Depth for "Background" was set to'))).toBe(
      true,
    );
  });

  it('honors a positive depth thinner than a layer, noting rather than clamping it', async () => {
    // A 0.12 mm recess is a real choice on a 0.08 mm profile. Clamping it up to 0.2 mm would put
    // it out of reach entirely, and the user knows their slicer better than this does.
    const built = (await buildGeometry(
      baseInput({ colorSettings: { '#ff0000': { depth: 0.12 } } }),
    ))!;

    expect(built.colorMeshes.find((c) => c.key === '#ff0000')!.depth).toBeCloseTo(0.12);
    const note = WARNINGS.find((w) => w.message.includes('thinner than the usual'));
    expect(note).toBeDefined();
    expect(note!.level).toBe('info');
    expect(WARNINGS.every((w) => !w.message.includes('was raised to'))).toBe(true);
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

  it('says it once for every color clamped to the same depth, not once per color', async () => {
    // Same shape as the zero-depth grouping test above, for the too-deep clamp branch: a global
    // Depth of 100 on a 4 mm disc (recessBg: true) clamps every color, including Background, to
    // 3.95 mm, and used to raise one identical-looking pill per color instead of one.
    await buildGeometry(
      baseInput({ parsed: threeColorParsed(), globalDepth: 100, recessBg: true }),
    );
    const tooDeep = WARNINGS.filter((w) => w.message.includes('can only cut'));
    expect(tooDeep).toHaveLength(1);
    expect(tooDeep[0].message).toBe(
      'Depths for "#0000ff", "#00ff00", "#ff0000", "Background" were set to 100.00 mm, but a ' +
        '4.00 mm plate can only cut 3.95 mm deep. They were cut at 3.95 mm instead.',
    );
  });

  it('says it once for every color clamped, without Background when recessBg is off', async () => {
    await buildGeometry(
      baseInput({ parsed: threeColorParsed(), globalDepth: 100, recessBg: false }),
    );
    const tooDeep = WARNINGS.filter((w) => w.message.includes('can only cut'));
    expect(tooDeep).toHaveLength(1);
    expect(tooDeep[0].message).toContain('"#0000ff", "#00ff00", "#ff0000"');
    expect(tooDeep[0].message).not.toContain('Background');
  });

  it('keeps two different requested depths in two too-deep messages', async () => {
    await buildGeometry(
      baseInput({
        parsed: threeColorParsed(),
        recessBg: false,
        colorSettings: {
          '#ff0000': { depth: 100 },
          '#00ff00': { depth: 50 },
          '#0000ff': { depth: 100 },
        },
      }),
    );
    const tooDeep = WARNINGS.filter((w) => w.message.includes('can only cut'));
    expect(tooDeep.map((w) => w.message)).toEqual([
      'Depths for "#0000ff", "#ff0000" were set to 100.00 mm, but a 4.00 mm plate can only cut ' +
        '3.95 mm deep. They were cut at 3.95 mm instead.',
      'Depth for "#00ff00" was set to 50.00 mm, but a 4.00 mm plate can only cut 3.95 mm deep. ' +
        'It was cut at 3.95 mm instead.',
    ]);
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
