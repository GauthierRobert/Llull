import type { Entity } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { MeshData } from '@core/model/types';
import type { BooleanOp } from '@core/model/types';

export function meshOf(kernel: GeometryKernel, entity: Entity): MeshData | null {
  const shape = kernel.evaluate({ op: 'solid', entity });
  return shape === null ? null : kernel.tessellate(shape);
}

export function booleanMesh(kernel: GeometryKernel, boolean: BooleanOp, a: Entity, b: Entity): MeshData | null {
  const shape = kernel.evaluate({ op: 'boolean', boolean, a: { op: 'solid', entity: a }, b: { op: 'solid', entity: b } });
  return shape === null ? null : kernel.tessellate(shape);
}
