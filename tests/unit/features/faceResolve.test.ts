/** Resolving `face: { near }` to a planar frame: from the exact face query (OCC) and from the triangles of a mesh kernel. */
import { describe, expect, it } from 'vitest';
import { resolveFace } from '@core/commands/features/faceResolve';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { FaceDetail } from '@core/geometry/kernelPorts';
import { recipeOf } from '@core/geometry/shapeRecipe';
import type { ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { fixtureKernel, loadFixture } from '../../helpers/recognitionFixture';
import { manifoldSuite, plate } from '../../helpers/featureSupport';

const kernelOf = manifoldSuite();
const LEAF: ShapeRecipe = recipeOf(plate().doc.entities[plate().id]!);

/** The fixture kernel with a scripted nearest-face answer and canned face details. */
function exactKernel(
  nearest: { distance: number; face: number } | null,
  surface: string,
  normal?: [number, number, number],
): GeometryKernel {
  const base = fixtureKernel(loadFixture('machinedPlate'));
  const port = base.faceQuery!;
  const details: FaceDetail[] = [
    {
      index: 0,
      surface: surface as FaceDetail['surface'],
      area: 1,
      centroid: [5, 5, 10],
      ...(normal === undefined ? {} : { normal }),
      samples: [],
    },
  ];
  return {
    ...base,
    tessellate: () => ({ positions: [0, 0, 0, 100, 60, 10, 0, 0, 10], indices: [0, 1, 2] }),
    faceQuery: {
      ...port,
      distance: () => (nearest === null ? null : [{ distance: nearest.distance, signed: 0, face: nearest.face }]),
      faceDetails: () => details,
      faceContains: (_shape, _face, point) => point[0] >= 0,
    },
  } as GeometryKernel;
}

describe('resolveFace on an exact kernel', () => {
  it('returns the frame of the planar face and delegates containment to the kernel', () => {
    const resolved = resolveFace(exactKernel({ distance: 0, face: 0 }, 'plane', [0, 0, 1]), LEAF, [5, 5, 10]);
    if (typeof resolved === 'string') throw new Error(resolved);
    expect(resolved.frame).toEqual({ origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] });
    expect(resolved.contains([1, 1, 10])).toBe(true);
    expect(resolved.contains([-1, 1, 10])).toBe(false);
  });

  it('reports a point that is too far, a curved face, and falls back to the mesh when the port cannot answer', () => {
    expect(resolveFace(exactKernel({ distance: 50, face: 0 }, 'plane', [0, 0, 1]), LEAF, [5, 5, 10])).toBe('not_found');
    expect(resolveFace(exactKernel({ distance: 0, face: 0 }, 'cylinder'), LEAF, [5, 5, 10])).toBe('not_planar');
    expect(resolveFace(exactKernel({ distance: 0, face: 0 }, 'plane'), LEAF, [5, 5, 10])).toBe('not_planar');
    expect(resolveFace(exactKernel({ distance: 0, face: 7 }, 'plane', [0, 0, 1]), LEAF, [5, 5, 10])).toBe('not_planar');
    expect(resolveFace(exactKernel(null, 'plane', [0, 0, 1]), LEAF, [5, 5, 10])).toBe('not_found');
  });
});

describe('resolveFace on a mesh kernel (Manifold)', () => {
  const resolve = (near: [number, number, number], recipe: ShapeRecipe = LEAF): ReturnType<typeof resolveFace> =>
    resolveFace(kernelOf(), recipe, near);

  it('finds each side of a box with its outward normal; the bottom frame is mirrored', () => {
    const top = resolve([50, 30, 10]);
    const bottom = resolve([50, 30, 0]);
    const side = resolve([100, 30, 5]);
    if (typeof top === 'string' || typeof bottom === 'string' || typeof side === 'string') throw new Error('no face');
    expect(top.frame.normal).toEqual([0, 0, 1]);
    expect(bottom.frame.normal).toEqual([0, 0, -1]);
    expect(side.frame.normal).toEqual([1, 0, 0]);
    expect(side.frame.xDir).toEqual([0, 1, 0]);
    expect(top.contains([50, 30, 10])).toBe(true);
    expect(top.contains([500, 30, 10])).toBe(false);
  });

  it('is not found away from every face', () => {
    expect(resolve([50, 30, 200])).toBe('not_found');
  });

  it('a hole in the face does not hide it: the cluster surrounds the bore', () => {
    const stock = plate();
    const drilled = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      points: [[50, 30]],
      hole: { kind: 'simple', diameter: 10 },
      extent: { kind: 'through_all' },
    });
    const recipe = recipeOf(drilled.document.entities[drilled.affected[0] as string]!);
    const again = resolve([10, 10, 10], recipe);
    if (typeof again === 'string') throw new Error(again);
    expect(again.contains([10, 10, 10])).toBe(true);
    expect(again.contains([50, 30, 10])).toBe(false);
  });
});
