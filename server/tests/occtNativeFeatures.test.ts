/**
 * OCC-native features (07 FTR M7, VC-FTR-25): holes (BRepFeat_MakeRevol) and pockets (BRepFeat_MakePrism) against the same nodes lowered to
 * booleans. Both kernels share one WASM module; `nativeFeatures: false` forces the lowering.
 */

import { beforeAll, describe, expect, it, afterAll } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { createOcctKernel } from '@kernel-occt/occtKernel';
import { nativeFeatureCount } from '@kernel-occt/occtFeatures';
import { createNodeOcctKernel } from '../src/occtNode';

let native: GeometryKernel;
let lowered: GeometryKernel;
beforeAll(async () => {
  native = await createNodeOcctKernel();
  lowered = await createOcctKernel({ nativeFeatures: false });
}, 120_000);
afterAll(() => setGeometryKernel(null));

const ctxOf = (kernel: GeometryKernel): ExecutionContext => ({ ...defaultContext(), kernel });
const rel = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
const TOP = { near: [50, 30, 10] };

interface Measured {
  readonly volume: number;
  readonly faces: number;
}

/** Runs `actions` on `kernel` and returns the exact volume and face count of the single result. */
function measure(kernel: GeometryKernel, actions: unknown[]): Measured {
  const built = execute(createEmptyDocument(), 'build_project', { actions }, ctxOf(kernel));
  expect(built.error).toBeUndefined();
  const doc: CadDocument = built.document;
  expect(doc.order).toHaveLength(1);
  const shape = kernel.evaluate(recipeOf(doc.entities[doc.order[0] as string] as Entity));
  expect(shape).not.toBeNull();
  const topology = kernel.topology(shape!);
  return { volume: topology?.volume ?? Number.NaN, faces: topology?.faces.length ?? 0 };
}

const plate = (size: number[] = [100, 60, 10]): unknown => ({
  command: 'add_box',
  params: { size, position: [0, 0, 0], anchor: 'min' },
  as: 'plate',
});

const hole = (target: string, as: string, extra: Record<string, unknown>): unknown => ({
  command: 'add_hole',
  params: { target, face: TOP, pointsFrame: 'world_xy', ...extra },
  as,
});

const pocket = (target: string, as: string, extra: Record<string, unknown>): unknown => ({
  command: 'add_pocket',
  params: {
    target,
    face: TOP,
    outline: { kind: 'rectangle', center: [50, 30], size: [40, 20] },
    cornerRadius: 3,
    floorFillet: 0,
    ...extra,
  },
  as,
});

/** Native and lowered builds of `actions` agree (volume 1e-9, same face count); `nodes` feature nodes took the native path. */
function expectParity(actions: unknown[], nodes: number): Measured {
  const before = nativeFeatureCount();
  const viaNative = measure(native, actions);
  const nativeNodes = nativeFeatureCount() - before;
  const viaLowering = measure(lowered, actions);
  expect(nativeFeatureCount() - before).toBe(nativeNodes);
  expect(nativeNodes).toBe(nodes);
  expect(rel(viaNative.volume, viaLowering.volume)).toBeLessThan(1e-9);
  expect(viaNative.faces).toBe(viaLowering.faces);
  return viaNative;
}

describe('native pockets (BRepFeat_MakePrism) equal the lowering', () => {
  it.each([
    ['rounded rectangle', { depth: 4 }],
    ['through', { through: true }],
    ['sharp corners', { depth: 4, cornerRadius: 0 }],
    [
      'polygon',
      {
        depth: 3,
        cornerRadius: 1,
        outline: {
          kind: 'polygon',
          points: [
            [20, 20],
            [60, 20],
            [40, 50],
          ],
        },
      },
    ],
  ])(
    '%s',
    (_name, extra) => {
      expectParity([plate(), pocket('$plate', 'part', extra)], 1);
    },
    120_000,
  );

  it('with a floor fillet: native cut, then the same fillet', () => {
    const result = expectParity([plate(), pocket('$plate', 'part', { depth: 5, cornerRadius: 4, floorFillet: 1.5 })], 1);
    expect(rel(60000 - result.volume, 3877.71730193)).toBeLessThan(1e-6);
  }, 120_000);

  it('islands fall back to the lowering; an open pocket running out over the side stays native', () => {
    const post = [
      [45, 27],
      [55, 27],
      [55, 33],
      [45, 33],
    ];
    expectParity([plate(), pocket('$plate', 'part', { depth: 4, cornerRadius: 2, islands: [post] })], 0);
    expectParity(
      [
        plate(),
        pocket('$plate', 'part', {
          depth: 4,
          cornerRadius: 0,
          open: true,
          outline: { kind: 'rectangle', center: [95, 30], size: [20, 20] },
        }),
      ],
      1,
    );
  }, 120_000);
});

describe('native holes (BRepFeat_MakeRevol) equal the lowering', () => {
  const at = { points: [[50, 30]] };
  it.each([
    ['simple through', { hole: { kind: 'simple', diameter: 4.8 }, extent: { kind: 'through_all' } }],
    [
      'countersink through',
      { hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100 }, extent: { kind: 'through_all' } },
    ],
    [
      'counterbore through',
      { hole: { kind: 'counterbore', diameter: 5.5, cboreDiameter: 10, cboreDepth: 5.5 }, extent: { kind: 'through_all' } },
    ],
    [
      'counterdrill through',
      {
        hole: { kind: 'counterdrill', diameter: 4, cboreDiameter: 8, cboreDepth: 4, cskDiameter: 10, cskAngle: 90 },
        extent: { kind: 'through_all' },
      },
    ],
    ['blind with 118 point', { hole: { kind: 'simple', diameter: 6 }, extent: { kind: 'blind', depth: 6, drillPointAngle: 118 } }],
    ['blind flat', { hole: { kind: 'simple', diameter: 6 }, extent: { kind: 'blind', depth: 6, drillPointAngle: 0 } }],
  ])(
    '%s',
    (_name, extra) => {
      expectParity([plate(), hole('$plate', 'part', { ...at, ...extra })], 1);
    },
    120_000,
  );

  it('the machined plate plan (VC-FTR-25): 55978.529153 with 4 native nodes', () => {
    const csk = hole('$plate', 'csk', {
      points: [
        [10, 10],
        [90, 10],
        [10, 50],
        [90, 50],
      ],
      hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100 },
      extent: { kind: 'through_all' },
    });
    const cbore = hole('$csk', 'cb', {
      points: [
        [30, 30],
        [70, 30],
      ],
      hole: { kind: 'counterbore', diameter: 5.5, cboreDiameter: 10, cboreDepth: 5.5 },
      extent: { kind: 'through_all' },
    });
    const pocketed = pocket('$cb', 'pocketed', { outline: { kind: 'rectangle', center: [50, 45], size: [40, 12] }, depth: 4 });
    const blind = hole('$pocketed', 'part', {
      points: [[50, 15]],
      hole: { kind: 'simple', diameter: 6 },
      extent: { kind: 'blind', depth: 6, drillPointAngle: 118 },
    });
    const result = expectParity([plate(), csk, cbore, pocketed, blind], 4);
    expect(rel(result.volume, 55978.529153)).toBeLessThan(1e-6);
  }, 180_000);

  it('more than 8 positions use the single compound lowering; up_to_next holes stay native', () => {
    const points = Array.from({ length: 12 }, (_, i) => [10 + (i % 6) * 15, 15 + Math.floor(i / 6) * 30]);
    expectParity([plate(), hole('$plate', 'part', { points, hole: { kind: 'simple', diameter: 4 }, extent: { kind: 'through_all' } })], 0);
    const outer = { command: 'add_box', params: { size: [100, 60, 30], position: [0, 0, 0], anchor: 'min' }, as: 'outer' };
    const cavity = { command: 'add_box', params: { size: [80, 40, 20], position: [10, 10, 5], anchor: 'min' }, as: 'cavity' };
    const hollow = { command: 'boolean', params: { op: 'subtract', a: '$outer', b: '$cavity' }, as: 'hollow' };
    const wall = hole('$hollow', 'part', {
      face: { near: [50, 30, 30] },
      points: [[50, 30]],
      hole: { kind: 'simple', diameter: 6 },
      extent: { kind: 'up_to_next' },
    });
    expectParity([outer, cavity, hollow, wall], 1);
  }, 180_000);
});
