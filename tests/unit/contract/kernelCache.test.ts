/** MG4.4 kernel memoization: identical operands hit the wrapped kernel once. */
import { describe, it, expect } from 'vitest';
import type { BoxEntity } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { geometryKey, memoizeKernel } from '@core/geometry/kernelCache';

const MESH: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };

function box(id: string, color: string, x = 0): BoxEntity {
  return {
    id,
    kind: 'box',
    position: [x, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-0',
    color,
    size: [1, 1, 1],
  };
}

function countingKernel(): { kernel: GeometryKernel; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const hit = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  return {
    calls,
    kernel: {
      booleanOp: () => (hit('boolean'), MESH),
      filletEdges: () => (hit('fillet'), MESH),
      chamferEdges: () => (hit('chamfer'), null),
      shellSolid: () => (hit('shell'), MESH),
      tessellate: () => (hit('tessellate'), MESH),
    },
  };
}

describe('memoizeKernel', () => {
  it('reuses results for identical geometry regardless of presentation fields', () => {
    const { kernel, calls } = countingKernel();
    const memo = memoizeKernel(kernel);
    expect(memo.booleanOp('union', box('a', '#fff'), box('b', '#fff', 1))).toBe(MESH);
    expect(memo.booleanOp('union', box('x', '#000'), box('y', '#123', 1))).toBe(MESH);
    expect(calls['boolean']).toBe(1);
    memo.booleanOp('subtract', box('a', '#fff'), box('b', '#fff', 1));
    memo.booleanOp('union', box('a', '#fff'), box('b', '#fff', 2));
    expect(calls['boolean']).toBe(3);
  });

  it('memoizes every operation, including null results', () => {
    const { kernel, calls } = countingKernel();
    const memo = memoizeKernel(kernel);
    for (let i = 0; i < 2; i++) {
      memo.filletEdges(MESH, [0, 1], 0.5);
      expect(memo.chamferEdges(MESH, [], 0.2)).toBeNull();
      memo.shellSolid(MESH, 0.1);
      memo.tessellate(box('t', '#fff'));
    }
    expect(calls).toEqual({ fillet: 1, chamfer: 1, shell: 1, tessellate: 1 });
    expect(memo.cachedResultCount()).toBe(4);
  });

  it('evicts the least recently used entry beyond capacity', () => {
    const { kernel, calls } = countingKernel();
    const memo = memoizeKernel(kernel, 2);
    memo.tessellate(box('a', '#fff', 1));
    memo.tessellate(box('a', '#fff', 2));
    memo.tessellate(box('a', '#fff', 1));
    memo.tessellate(box('a', '#fff', 3));
    expect(memo.cachedResultCount()).toBe(2);
    memo.tessellate(box('a', '#fff', 1));
    expect(calls['tessellate']).toBe(3);
    memo.tessellate(box('a', '#fff', 2));
    expect(calls['tessellate']).toBe(4);
  });

  it('geometryKey ignores id/name/color/layer/tags/material', () => {
    const a = { ...box('a', '#fff'), name: 'A', tags: ['x'], materialId: 'steel' };
    expect(geometryKey(a)).toBe(geometryKey(box('b', '#000')));
  });
});
