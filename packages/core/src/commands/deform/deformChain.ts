/**
 * The mesh of a chain of deformations with the rest position of every vertex in the input space of each node (01 DEF §18.1): `sourceMeshOf` gives the triangles of an inner deformation
 * but forgets where each vertex came from. Re-running the inner nodes on the mesh path with `warpMesh` carries, through every refinement, the rest position of each vertex at each stage
 * (barycentric for the vertices a split creates), so the determinants of the nodes can be read at the matching rest points and multiplied: the composed det J = the volume ratio against the original body.
 */

import type { CadDocument, MeshData, ShapeRecipe } from '../../model/types';
import type { DeformNode } from '../../geometry/deform/laws';
import { warpMesh } from '../../geometry/deform/meshWarp';
import type { GeometryKernel } from '../../geometry/kernel';
import { sourceMeshOf } from './sourceMesh';

export interface DeformChain {
  /** The mesh the chain's last node moves (its input). */
  readonly mesh: MeshData;
  /** One array per node of `nodes`, inner first: the rest position (flat xyz) of every vertex of `mesh` in the input space of that node. */
  readonly stages: number[][];
  /** The deformation nodes, inner first. */
  readonly nodes: readonly DeformNode[];
}

export interface ChainFailure {
  readonly code: string;
  readonly message: string;
}

export const isChainFailure = (value: DeformChain | ChainFailure): value is ChainFailure => 'code' in value;

/**
 * The chain under `recipe`: for a `deform` node the inner chain warped by it (mesh path, at the node's own tolerance, rest positions carried); for any other recipe its triangles
 * (kernel or core) with no stage.
 * @failure the base body cannot be rebuilt -> DEF_SOURCE_UNAVAILABLE; an inner node the mesh warp refuses -> its code (DEF_BUDGET_EXCEEDED, DEF_APPROX_TOLERANCE, DEF_FRAME_DEGENERATE)
 */
export function chainOf(kernel: GeometryKernel | null, recipe: ShapeRecipe, doc: CadDocument): DeformChain | ChainFailure {
  if (recipe.op !== 'deform') {
    const mesh = sourceMeshOf(kernel, recipe, doc);
    return mesh === null
      ? { code: 'DEF_SOURCE_UNAVAILABLE', message: 'the deformation source cannot be rebuilt without a geometry kernel' }
      : { mesh, stages: [], nodes: [] };
  }
  const inner = chainOf(kernel, recipe.source, doc);
  if (isChainFailure(inner)) return inner;
  const warped = warpMesh(inner.mesh, recipe, { tolerance: recipe.output.tolerance, attributes: inner.stages });
  if (!warped.ok) return { code: warped.code, message: warped.message };
  return { mesh: warped.mesh, stages: [...warped.attributes, warped.restPositions], nodes: [...inner.nodes, recipe] };
}
