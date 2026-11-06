/**
 * Meshes at a stated accuracy for consumers that must not read the display mesh (fabrication exports, deform sources, exact-volume inertia).
 * @invariant the display mesh of a kernel result scales its deflection with the size of the part, so its chord error is not bounded in absolute units;
 *            these helpers ask the kernel for explicit absolute deflections and report whether it honoured them
 * @invariant kernel-optional: a kernel that does not honour `TessellationOptions` (Manifold) or an entity without an exact recipe yields null / the display mesh
 */

import type { Entity, MeshData } from '../model/types';
import type { GeometryKernel, ShapeHandle, TessellationOptions } from './kernel';

/** The accuracy of the display mesh before it scaled with the part: 0.1 document units of chord error, 0.5 rad between facet normals. */
export const PREVIOUS_DISPLAY_TOLERANCE: TessellationOptions = { linearDeflection: 0.1, angularDeflection: 0.5 };

/** `PREVIOUS_DISPLAY_TOLERANCE` with another chord error (document units). */
export const chordOptions = (chordTolerance: number): TessellationOptions => ({
  linearDeflection: chordTolerance,
  angularDeflection: PREVIOUS_DISPLAY_TOLERANCE.angularDeflection,
});

/** True when `kernel` builds meshes at the deflections it is given. */
const honoursOptions = (kernel: GeometryKernel | null | undefined): kernel is GeometryKernel => kernel?.honoursTessellationOptions === true;

/** Mesh of `shape` at `options` when the kernel honours them, else its display mesh. */
export function tessellateAt(kernel: GeometryKernel, shape: ShapeHandle, options: TessellationOptions): MeshData | null {
  return kernel.tessellate(shape, honoursOptions(kernel) ? options : undefined);
}

/**
 * `entity` with its stored mesh replaced by the kernel's mesh of its exact recipe at `options` (position and rotation still apply to it).
 * @failure no kernel honouring options, not a kernel-result mesh (no `brep`, or an asset-backed scan), a recipe the kernel refuses, an empty mesh -> null
 */
export function withExactMesh(entity: Entity, kernel: GeometryKernel | null | undefined, options: TessellationOptions): Entity | null {
  if (!honoursOptions(kernel) || entity.kind !== 'mesh' || entity.brep === undefined || entity.asset !== undefined) return null;
  const shape = kernel.evaluate(entity.brep);
  const mesh = shape === null ? null : kernel.tessellate(shape, options);
  return mesh === null || mesh.indices.length === 0 ? null : { ...entity, mesh };
}
