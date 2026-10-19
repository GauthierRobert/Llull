/**
 * Native feature cuts (07 FTR M7, VC-FTR-25 / VC-FTR-27): holes (BRepFeat_MakeRevol), pockets (BRepFeat_MakePrism) and pocket floor fillets
 * (floor edges selected and filleted by the sidecar on the cut's own topology) on the real `llull-kernel`, against the same nodes lowered
 * to plain booleans (core `lowerFeature`, evaluated by the same kernel) and against the analytic volumes of the 07 validation pack.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { floorEdgeIndices } from '@core/geometry/featureFillet';
import { lowerFeature, needsReach, throughReach } from '@core/geometry/featureLowering';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type Entity, type ShapeRecipe } from '@core/model/types';
import { createNativeTestKernel, describeNative, meshOf } from './kernelTestSupport';

let kernel: GeometryKernel;
beforeAll(() => {
  kernel = createNativeTestKernel();
}, 120_000);
afterAll(() => {
  (kernel as { dispose?: () => void }).dispose?.();
  setGeometryKernel(null);
});

const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel });
const rel = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
const TOP = { near: [50, 30, 10] };

interface Measured {
  readonly volume: number;
  readonly faces: number;
}

type FeatureRecipe = Extract<ShapeRecipe, { op: 'feature' }>;

/** The recipe with every `feature` node replaced by what the lowering makes of it: booleans of the compound tool (plus the floor fillet). */
function lowered(recipe: ShapeRecipe): ShapeRecipe {
  switch (recipe.op) {
    case 'solid':
    case 'brep':
      return recipe;
    case 'boolean':
      return { ...recipe, a: lowered(recipe.a), b: lowered(recipe.b) };
    case 'blend':
      return { ...recipe, sources: recipe.sources.map(lowered) };
    case 'feature': {
      const node: FeatureRecipe = { ...recipe, source: lowered(recipe.source) };
      const sourceMesh = needsReach(node) ? meshOf(kernel, node.source) : null;
      const plan = lowerFeature(node, sourceMesh === null ? 0 : throughReach(sourceMesh, node.frame));
      if (plan === null) throw new Error('the lowering refused the node');
      const cut: ShapeRecipe = { op: 'boolean', boolean: plan.mode, a: node.source, b: plan.tool };
      if (node.feature !== 'pocket' || node.pocket.floorFillet <= 0 || plan.pocket === undefined) return cut;
      const topology = kernel.topology(kernel.evaluate(cut)!);
      const edges = topology === null ? [] : floorEdgeIndices(topology, plan.pocket, node.frame);
      return { op: 'fillet', source: cut, edges, size: node.pocket.floorFillet };
    }
    default:
      return { ...recipe, source: lowered(recipe.source) };
  }
}

const measureRecipe = (recipe: ShapeRecipe): Measured => {
  const shape = kernel.evaluate(recipe);
  expect(shape).not.toBeNull();
  const topology = kernel.topology(shape!);
  return { volume: topology?.volume ?? Number.NaN, faces: topology?.faces.length ?? 0 };
};

/** The single entity the plan builds, as its recipe. */
function built(actions: unknown[]): ShapeRecipe {
  const result = execute(createEmptyDocument(), 'build_project', { actions }, ctx());
  expect(result.error).toBeUndefined();
  const doc: CadDocument = result.document;
  expect(doc.order).toHaveLength(1);
  return recipeOf(doc.entities[doc.order[0] as string] as Entity);
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

/** The native build of `actions` equals its lowering to booleans (volume 1e-9, same face count). */
function expectParity(actions: unknown[]): Measured {
  const recipe = built(actions);
  const viaNative = measureRecipe(recipe);
  const viaLowering = measureRecipe(lowered(recipe));
  expect(rel(viaNative.volume, viaLowering.volume)).toBeLessThan(1e-9);
  expect(viaNative.faces).toBe(viaLowering.faces);
  return viaNative;
}

describeNative('native pockets (BRepFeat_MakePrism) equal the lowering', () => {
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
      expectParity([plate(), pocket('$plate', 'part', extra)]);
    },
    120_000,
  );

  it.each([
    ['PK-01', 0, 3931.327412287],
    ['PK-02', 1.5, 3877.71730193],
  ])(
    'VC-FTR-27 %s: the pocket (floor fillet %d) removes the analytic volume, natively and lowered',
    (_id, floorFillet, removed) => {
      const result = expectParity([plate(), pocket('$plate', 'part', { depth: 5, cornerRadius: 4, floorFillet })]);
      expect(rel(60000 - result.volume, removed)).toBeLessThan(1e-6);
    },
    120_000,
  );

  it('a floor fillet adds the concave fillet material at the floor edges and its own faces', () => {
    const plain = expectParity([plate(), pocket('$plate', 'part', { depth: 5, cornerRadius: 4 })]);
    const rounded = expectParity([plate(), pocket('$plate', 'part', { depth: 5, cornerRadius: 4, floorFillet: 1.5 })]);
    expect(rounded.volume).toBeGreaterThan(plain.volume);
    expect(rounded.faces).toBeGreaterThan(plain.faces);
  }, 120_000);

  it('a floor fillet also rounds the foot of an island', () => {
    const post = [
      [45, 27],
      [55, 27],
      [55, 33],
      [45, 33],
    ];
    const common = { depth: 4, cornerRadius: 2, islands: [post] };
    const plain = expectParity([plate(), pocket('$plate', 'part', common)]);
    const rounded = expectParity([plate(), pocket('$plate', 'part', { ...common, floorFillet: 1 })]);
    expect(rounded.volume).toBeGreaterThan(plain.volume);
    expect(rounded.faces).toBeGreaterThan(plain.faces);
    // The pocket ring (40 x 20 minus the 10 x 6 post, corner radius 2 on both) is 740 mm^2: 60000 - 4 * 740 before the fillets.
    expect(rel(60000 - plain.volume, 4 * 740)).toBeLessThan(1e-6);
  }, 120_000);

  it('an open pocket running out over the side stays one native cut', () => {
    expectParity([
      plate(),
      pocket('$plate', 'part', { depth: 4, cornerRadius: 0, open: true, outline: { kind: 'rectangle', center: [95, 30], size: [20, 20] } }),
    ]);
  }, 120_000);
});

describeNative('native holes (BRepFeat_MakeRevol) equal the lowering', () => {
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
      expectParity([plate(), hole('$plate', 'part', { ...at, ...extra })]);
    },
    120_000,
  );

  it('the machined plate plan (VC-FTR-25): 55978.529153', () => {
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
    const result = expectParity([plate(), csk, cbore, pocketed, blind]);
    expect(rel(result.volume, 55978.529153)).toBeLessThan(1e-6);
  }, 180_000);

  it('more than 8 positions use the single compound lowering; up_to_next holes stay native', () => {
    const points = Array.from({ length: 12 }, (_, i) => [10 + (i % 6) * 15, 15 + Math.floor(i / 6) * 30]);
    const many = expectParity([
      plate(),
      hole('$plate', 'part', { points, hole: { kind: 'simple', diameter: 4 }, extent: { kind: 'through_all' } }),
    ]);
    expect(rel(many.volume, 60000 - 12 * Math.PI * 4 * 10)).toBeLessThan(1e-6);
    const outer = { command: 'add_box', params: { size: [100, 60, 30], position: [0, 0, 0], anchor: 'min' }, as: 'outer' };
    const cavity = { command: 'add_box', params: { size: [80, 40, 20], position: [10, 10, 5], anchor: 'min' }, as: 'cavity' };
    const hollow = { command: 'boolean', params: { op: 'subtract', a: '$outer', b: '$cavity' }, as: 'hollow' };
    const wall = hole('$hollow', 'part', {
      face: { near: [50, 30, 30] },
      points: [[50, 30]],
      hole: { kind: 'simple', diameter: 6 },
      extent: { kind: 'up_to_next' },
    });
    expectParity([outer, cavity, hollow, wall]);
  }, 180_000);
});
