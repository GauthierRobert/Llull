/**
 * Kernel memoization: identical operand definitions never hit the WASM kernel twice,
 * so regenerating an unchanged boolean/fillet during replay is free.
 *
 * @layer core/geometry
 * @pure semantically transparent: a cached result equals what the wrapped kernel would return
 * @invariant keys cover every input the kernel reads (op/kind + operand geometry + numbers);
 *   presentation-only fields (id, name, color, layer, tags, material) are excluded
 */

import type { Entity } from '../model/types';
import { LruCache } from '../lib/lruCache';
import type { BooleanOp, GeometryKernel, MeshData } from './kernel';

const PRESENTATION_FIELDS = new Set(['id', 'name', 'color', 'layerId', 'tags', 'materialId']);

/** Stable key of an entity's geometry (presentation fields dropped, keys sorted). */
export function geometryKey(entity: Entity): string {
  const record = entity as unknown as Record<string, unknown>;
  const kept = Object.keys(record)
    .filter((key) => !PRESENTATION_FIELDS.has(key))
    .sort()
    .map((key) => [key, record[key]]);
  return JSON.stringify(kept);
}

function meshKey(mesh: MeshData): string {
  return JSON.stringify([mesh.positions, mesh.indices]);
}

interface MemoizedKernel extends GeometryKernel {
  /** Number of kernel results currently cached (observability/tests). */
  readonly cachedResultCount: () => number;
}

/**
 * Wrap `kernel` so repeated calls with identical operands return the cached result.
 * `null` (operation impossible) is cached too.
 */
export function memoizeKernel(kernel: GeometryKernel, capacity = 256): MemoizedKernel {
  const cache = new LruCache<MeshData | null>(capacity);
  const memo = (key: string, compute: () => MeshData | null): MeshData | null => {
    if (cache.has(key)) return cache.get(key) ?? null;
    const result = compute();
    cache.set(key, result);
    return result;
  };
  return {
    booleanOp: (op: BooleanOp, a: Entity, b: Entity) =>
      memo(`boolean:${op}:${geometryKey(a)}:${geometryKey(b)}`, () => kernel.booleanOp(op, a, b)),
    filletEdges: (shape, edgeIndices, radius) =>
      memo(`fillet:${radius}:${edgeIndices.join(',')}:${meshKey(shape)}`, () =>
        kernel.filletEdges(shape, edgeIndices, radius),
      ),
    chamferEdges: (shape, edgeIndices, distance) =>
      memo(`chamfer:${distance}:${edgeIndices.join(',')}:${meshKey(shape)}`, () =>
        kernel.chamferEdges(shape, edgeIndices, distance),
      ),
    shellSolid: (shape, thickness) =>
      memo(`shell:${thickness}:${meshKey(shape)}`, () => kernel.shellSolid(shape, thickness)),
    tessellate: (entity) =>
      memo(`tessellate:${geometryKey(entity)}`, () => kernel.tessellate(entity)),
    cachedResultCount: () => cache.size,
  };
}
