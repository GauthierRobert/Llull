/** The native `feature` hook of KernelOps (07 FTR M7) and the code / table output of ribs, counterdrills and up-to extents. */
import { describe, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { authoredFeatures } from '@core/geometry/featureInstances';
import { holeToolProfile, lowerFeature, needsReach, type FeatureRecipe } from '@core/geometry/featureLowering';
import { recipeOf } from '@core/geometry/shapeRecipe';
import type { HoleTableData } from '@core/commands/features/holeTable';
import type { CadDocument, Entity, ShapeRecipe } from '@core/model/types';
import { TETRA } from '../../helpers/fakeKernel';
import { idOf, manifoldSuite, meshOf, plate } from '../../helpers/featureSupport';

manifoldSuite();

const FRAME = { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;

describe('KernelOps.feature (native form of a feature node)', () => {
  const recipe = (): ShapeRecipe => {
    const stock = plate();
    return {
      op: 'feature',
      source: { op: 'solid', entity: stock.doc.entities[stock.id] as Entity },
      feature: 'hole',
      frame: FRAME,
      points: [[10, 10]],
      hole: { kind: 'simple', diameter: 4 },
      extent: { kind: 'through_all' },
    };
  };

  const kernelWith = (
    feature: (() => object | null) | undefined,
    failureEpoch?: () => number,
  ): { kernel: ReturnType<typeof kernelFromOps<object>>; boolean: ReturnType<typeof vi.fn> } => {
    const boolean = vi.fn(() => ({ tag: 'boolean' }));
    const kernel = kernelFromOps<object>({
      name: 'hooked',
      solid: () => ({ tag: 'solid' }),
      boolean,
      ...(feature === undefined ? {} : { feature }),
      ...(failureEpoch === undefined ? {} : { failureEpoch }),
      fillet: () => null,
      blend: () => null,
      chamfer: () => null,
      shell: () => null,
      place: () => null,
      scale: () => null,
      tessellate: () => TETRA,
      topology: () => null,
      exportStep: () => null,
      release: () => undefined,
    });
    return { kernel, boolean };
  };

  it('uses the native result and builds no tool when the hook answers', () => {
    const feature = vi.fn(() => ({ tag: 'native' }));
    const { kernel, boolean } = kernelWith(feature);
    expect(kernel.evaluate(recipe())).not.toBeNull();
    expect(feature).toHaveBeenCalledTimes(1);
    expect(boolean).not.toHaveBeenCalled();
    const [, node, reach] = feature.mock.calls[0] as unknown as [object, FeatureRecipe, number];
    expect(node.feature).toBe('hole');
    expect(reach).toBeGreaterThanOrEqual(0);
  });

  it('a native attempt that degraded the module is not lowered on that module: null, then retried after the epoch bump', () => {
    let epoch = 0;
    let degrade = true;
    const feature = vi.fn(() => {
      if (degrade) epoch += 1;
      return null;
    });
    const { kernel, boolean } = kernelWith(feature, () => epoch);
    expect(kernel.evaluate(recipe())).toBeNull();
    expect(boolean).not.toHaveBeenCalled();
    degrade = false;
    expect(kernel.evaluate(recipe())).not.toBeNull();
    expect(feature).toHaveBeenCalledTimes(2);
    expect(boolean).toHaveBeenCalledWith('subtract', expect.anything(), expect.anything());
  });

  it('lowers to a boolean when the hook declines or is absent', () => {
    for (const hook of [() => null, undefined]) {
      const { kernel, boolean } = kernelWith(hook);
      expect(kernel.evaluate(recipe())).not.toBeNull();
      expect(boolean).toHaveBeenCalledWith('subtract', expect.anything(), expect.anything());
    }
  });
});

describe('lowering of the new feature members', () => {
  it('a rib lowers to a union tool; needsReach is false for it', () => {
    const rib: FeatureRecipe = {
      op: 'feature',
      source: { op: 'solid', entity: plate().doc.entities['box-1'] as Entity },
      feature: 'rib',
      frame: FRAME,
      rib: {
        path: [
          [10, 10],
          [50, 10],
        ],
        thickness: 3,
        height: 20,
        symmetric: true,
      },
    };
    expect(lowerFeature(rib, 0)).toMatchObject({ mode: 'union' });
    expect(needsReach(rib)).toBe(false);
    expect(lowerFeature({ ...rib, rib: { ...rib.rib, height: 0 } } as FeatureRecipe, 0)).toBeNull();
    expect(lowerFeature({ ...rib, rib: { ...rib.rib, path: [[1, 1]] } } as FeatureRecipe, 0)).toBeNull();
  });

  it('hole tool profiles: counterdrill needs all four dimensions with the cone above the bore; up-to depths are used as given', () => {
    const counterdrill = { kind: 'counterdrill', diameter: 4, cboreDiameter: 8, cboreDepth: 4, cskDiameter: 10, cskAngle: 90 } as const;
    expect(holeToolProfile(counterdrill, { kind: 'through_all' }, 10)).not.toBeNull();
    expect(holeToolProfile({ ...counterdrill, cskAngle: undefined } as never, { kind: 'through_all' }, 10)).toBeNull();
    expect(holeToolProfile({ ...counterdrill, cboreDepth: 0.5 }, { kind: 'through_all' }, 10)).toBeNull();
    const faceBottom = holeToolProfile({ kind: 'simple', diameter: 4 }, { kind: 'up_to_face', depth: 7 }, 99);
    expect(faceBottom?.at(-2)).toEqual([2, -7]);
    const nextBottom = holeToolProfile({ kind: 'simple', diameter: 4 }, { kind: 'up_to_next', depth: 7 }, 99);
    expect((nextBottom?.at(-2)?.[1] ?? 0) < -7).toBe(true);
  });
});

describe('code export and hole table of the new features', () => {
  const ribbed = (): { doc: CadDocument; id: string } => {
    const stock = plate();
    const rib = execute(stock.doc, 'add_rib', {
      target: stock.id,
      plane: { origin: [0, 0, 10], normal: [0, 0, 1] },
      path: [
        [10, 30],
        [90, 30],
      ],
      thickness: 3,
      height: 20,
    });
    const drilled = execute(rib.document, 'add_hole', {
      target: idOf(rib),
      face: { near: [50, 5, 10] },
      points: [[50, 10]],
      pointsFrame: 'world_xy',
      hole: { kind: 'counterdrill', diameter: 4, cboreDiameter: 8, cboreDepth: 4, cskDiameter: 10, cskAngle: 90 },
      extent: { kind: 'through_all' },
    });
    const pocket = execute(drilled.document, 'add_pocket', {
      target: idOf(drilled),
      face: { near: [5, 55, 10] },
      outline: { kind: 'rectangle', center: [20, 48], size: [20, 10] },
      islands: [
        [
          [17, 46],
          [23, 46],
          [23, 50],
          [17, 50],
        ],
      ],
      depth: 3,
      cornerRadius: 0,
      floorFillet: 0,
    });
    expect(pocket.rejected).toBeUndefined();
    return { doc: pocket.document, id: idOf(pocket) };
  };

  it.each(['cadquery', 'build123d', 'freecad', 'openscad'])('%s: rib fuse, counterdrill idiom and island note', (language) => {
    const { doc } = ribbed();
    const code = execute(doc, 'export_code', { language }).data as { text: string };
    expect(code.text).toContain('add_rib: 2-point path thickened 3 (centred), height 20');
    expect(code.text).toContain('add_pocket: 4-vertex outline, 1 island, depth 3');
    expect(code.text).toContain('.cboreHole(4, 8, 4) + countersink');
    expect(code.text).toMatch(language === 'openscad' ? /union\(\)/ : language === 'freecad' ? /\.fuse\(/ : /fuse|union/);
  });

  it('hole_table lists a counterdrill and an up_to_face hole with their depth; ribs are no hole', () => {
    const { doc, id } = ribbed();
    const table = execute(doc, 'hole_table', { id }).data as HoleTableData;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ subtype: 'counterdrill', through: true, cboreDiameter: 8, cskDiameter: 10, cskDepth: 1 });
    const features = authoredFeatures(recipeOf(meshOf(doc, id)));
    expect(features.holes).toHaveLength(1);
    expect(features.pockets).toHaveLength(1);
  });

  it('an up_to_face hole is a non-through row with the resolved depth', () => {
    const stock = plate();
    const pocket = execute(stock.doc, 'add_pocket', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      outline: { kind: 'rectangle', center: [20, 30], size: [30, 20] },
      depth: 4,
      cornerRadius: 0,
      floorFillet: 0,
    });
    const hole = execute(pocket.document, 'add_hole', {
      target: idOf(pocket),
      face: { near: [80, 30, 10] },
      points: [[80, 30]],
      pointsFrame: 'world_xy',
      hole: { kind: 'simple', diameter: 4 },
      extent: { kind: 'up_to_face', face: { near: [20, 30, 6] } },
    });
    expect(hole.rejected).toBeUndefined();
    const table = execute(hole.document, 'hole_table', { id: idOf(hole) }).data as HoleTableData;
    expect(table.rows[0]).toMatchObject({ through: false, depth: 4 });
  });
});
