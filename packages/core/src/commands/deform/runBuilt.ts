/** The built result of a deformation (kernel shape or core mesh warp) and its volume. */

import type { Entity, MeshData } from '../../model/types';
import type { DeformNode } from '../../geometry/deform/laws';
import { warpMesh } from '../../geometry/deform/meshWarp';
import type { ShapeHandle } from '../../geometry/kernel';
import { signedMeshVolume } from '../../geometry/meshVolume';
import { newEntity } from '../entity/newEntity';
import { evaluateRecipe } from '../kernelShape';
import type { DeformTarget, Refusal } from './target';

export interface Built {
  readonly recipe: DeformNode;
  readonly mesh: MeshData;
  readonly shape: ShapeHandle | null;
  readonly exact: boolean;
  readonly edgeLength: number | null;
  readonly chordError: number | null;
}

export function meshEntityOf(id: string, built: Built, source: Entity): Entity {
  return newEntity('mesh', id, { mesh: built.mesh, brep: built.recipe }, [0, 0, 0], source.color, { layerId: source.layerId });
}

export function volumeOf(target: DeformTarget, built: Built): { value: number; method: 'exact' | 'mesh' } {
  const { kernel } = target;
  const exact = built.exact && built.shape !== null ? kernel?.massProperties?.(built.shape)?.volume : undefined;
  return exact === undefined
    ? { value: Math.abs(signedMeshVolume(built.mesh.positions, built.mesh.indices)), method: 'mesh' }
    : { value: exact, method: 'exact' };
}

/** The kernel result of `node`, or a refusal; `useKernel` false skips straight to the core mesh path. */
export function build(target: DeformTarget, node: DeformNode, useKernel: boolean): Built | Refusal {
  const { kernel } = target;
  if (useKernel && kernel !== null) {
    const evaluated = evaluateRecipe(kernel, node);
    if (typeof evaluated === 'string') {
      // the kernel says why it refused (approximation above the tolerance, folded map, invalid result); else a failure the core mesh warp also
      // reports (budget, frame) keeps its own code, the same on every host
      const reported = kernel.deformReport?.(node);
      if (reported !== undefined && reported !== null && !reported.ok && reported.code !== '')
        return {
          code: reported.code,
          message: reported.message,
          paths: reported.code === 'DEF_APPROX_TOLERANCE' ? ['params.output.tolerance'] : [],
        };
      const diagnosis = warpMesh(target.mesh, node, { tolerance: node.output.tolerance });
      if (!diagnosis.ok) return { code: diagnosis.code, message: diagnosis.message, paths: [] };
      return {
        code: 'DEF_KERNEL_REFUSED',
        message: `the kernel ${evaluated === 'empty' ? 'built an empty shape' : 'refused the deformation'}`,
        paths: [],
      };
    }
    return {
      recipe: node,
      mesh: evaluated.mesh,
      shape: evaluated.shape,
      exact: kernel.topology(evaluated.shape) !== null,
      edgeLength: null,
      chordError: null,
    };
  }
  const warped = warpMesh(target.mesh, node, { tolerance: node.output.tolerance });
  if (!warped.ok) return { code: warped.code, message: warped.message, paths: [] };
  return {
    recipe: node,
    mesh: warped.mesh,
    shape: null,
    exact: false,
    edgeLength: Number.isFinite(warped.edgeLength) ? warped.edgeLength : null,
    chordError: warped.maxChordError,
  };
}
