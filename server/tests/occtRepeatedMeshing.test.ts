/**
 * @layer server/tests
 * Live OpenCascade: meshing releases its per-node/triangle/face handles without corrupting the
 * heap, so repeated booleans and tessellations stay correct.
 */

import { describe, it, expect } from 'vitest';
import type { Entity } from '@core/model/types';
import { createNodeOcctKernel } from '../src/occtNode';

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
  it('returns identical meshes across repeated boolean and tessellate calls', async () => {
    const kernel = await createNodeOcctKernel();
    const first = kernel.booleanOp('union', box('a', [0, 0, 0]), box('b', [1, 0, 0]));
    expect(first).not.toBeNull();
    for (let i = 0; i < 25; i++) {
      const again = kernel.booleanOp('union', box('a', [0, 0, 0]), box('b', [1, 0, 0]));
      expect(again?.positions).toEqual(first?.positions);
      expect(kernel.tessellate(box('c', [0, 0, 0]))?.indices).toHaveLength(36);
    }
  }, 120_000);
});
