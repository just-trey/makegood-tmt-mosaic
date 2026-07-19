import { describe, expect, it } from 'vitest';
import { BACKGROUND_KEY, buildGeometry, type FlatBuildInput } from '../src/geometry/flat';
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
