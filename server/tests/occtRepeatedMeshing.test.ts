/**
 * @layer server/tests
 * Live OpenCascade: meshing releases its per-node/triangle/face handles without corrupting the
 * heap, so repeated booleans, fillets and tessellations stay correct — also after the shape cache
 * is dropped and every shape is rebuilt from its recipe.
 */

import { describe, it, expect } from 'vitest';
import type { Entity } from '@core/model/types';
import type { ShapeRecipe } from '@core/geometry/shapeRecipe';
import { createNodeOcctKernel } from '../src/occtNode';
import { booleanRecipe, leaf, meshOf } from './kernelTestSupport';

function box(id: string, position: [number, number, number]): Entity {
  return {
    id,
    kind: 'box',
    position,
    rotation: [0, 0, 0],
    size: [2, 2, 2],
    layerId: 'layer-default',
    color: '#888888',
  } as unknown as Entity;
}

describe('occt kernel (live WASM)', () => {
  it('returns identical meshes across repeated rebuilt booleans and tessellations', async () => {
    const kernel = await createNodeOcctKernel();
    const union = booleanRecipe('union', box('a', [0, 0, 0]), box('b', [1, 0, 0]));
    const first = meshOf(kernel, union);
    expect(first).not.toBeNull();
    for (let i = 0; i < 25; i++) {
      kernel.clear();
      expect(meshOf(kernel, union)?.positions).toEqual(first?.positions);
      expect(meshOf(kernel, box('c', [0, 0, 0]))?.indices).toHaveLength(36);
    }
  }, 120_000);

  it('serves an unchanged recipe from the shape cache without rebuilding it', async () => {
    const kernel = await createNodeOcctKernel();
    kernel.clear();
    const union = booleanRecipe('union', box('a', [0, 0, 0]), box('b', [1, 0, 0]));
    meshOf(kernel, union);
    const builds = kernel.buildCount();
    for (let i = 0; i < 5; i++) meshOf(kernel, union);
    expect(kernel.buildCount()).toBe(builds);
  }, 120_000);

  it('fillets the same exact edge repeatedly with identical results (no use-after-release)', async () => {
    const kernel = await createNodeOcctKernel();
    const cube = leaf(box('c', [0, 0, 0]));
    const fillet: ShapeRecipe = { op: 'fillet', source: cube, edges: [0], size: 0.2 };
    const first = meshOf(kernel, fillet);
    expect(first).not.toBeNull();
    expect(first!.indices.length).toBeGreaterThan(36);
    for (let i = 0; i < 10; i++) {
      kernel.clear();
      expect(meshOf(kernel, fillet)?.positions).toEqual(first!.positions);
    }
  }, 120_000);
});
