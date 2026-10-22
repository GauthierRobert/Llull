/** Read-only analysis of a deformed entity (01 DEF §7.2): Jacobian, volume check, displacement, creases, fibres, approximation error. Shared by analyze_deformation and check_deformation. */

import type { CadDocument, Entity } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import {
  type BendFibres,
  type JacobianRange,
  type LocalExtent,
  type RegionCrease,
  bendFibres,
  jacobianRange,
  localExtentOf,
  regionCreases,
} from '../../geometry/deform/bounds';
import { type DeformNode, type Warp, warpOf } from '../../geometry/deform/laws';
import { storedChordError } from '../../geometry/deform/storedError';
import { predictedVolume } from '../../geometry/deform/predictedVolume';
import type { GeometryKernel } from '../../geometry/kernel';
import { orientOutward, signedMeshVolume } from '../../geometry/meshVolume';
import { recipeOf } from '../../geometry/shapeRecipe';
import { MESH_TS_TRIANGLE_CAP } from '../../geometry/mesh/engineTypes';
import { hasUnverifiedLeaf, sourceMeshOf } from './sourceMesh';

/** Vertices sampled for the Jacobian and displacement at most (a stride over larger meshes). */
const MAX_SAMPLES = 200_000;

export interface DeformAnalysis {
  readonly node: DeformNode;
  readonly path: 'exact' | 'mesh';
  readonly extent: LocalExtent;
  readonly range: JacobianRange;
  readonly sampled: { readonly min: number; readonly max: number; readonly minAt: Vec3; readonly count: number };
  readonly maxDisplacement: number;
  readonly volume: {
    readonly source: number;
    readonly predicted: number;
    readonly measured: number;
    readonly driftRel: number;
    readonly method: 'exact' | 'mesh';
  };
  readonly approximationError: number | null;
  readonly creases: RegionCrease[];
  readonly fibres: BendFibres | null;
  readonly unverified: boolean;
  readonly sourceTriangles: number;
}

export interface AnalysisFailure {
  readonly code: 'DEF_SOURCE_UNAVAILABLE' | 'DEF_FRAME_DEGENERATE';
  readonly message: string;
}

function sampleJacobian(positions: ReadonlyArray<number>, warp: Warp): { sampled: DeformAnalysis['sampled']; maxDisplacement: number } {
  const count = positions.length / 3;
  const stride = Math.max(1, Math.ceil(count / MAX_SAMPLES));
  let min = Infinity;
  let max = -Infinity;
  let minAt: Vec3 = [0, 0, 0];
  let displacement = 0;
  let used = 0;
  for (let v = 0; v < count; v += stride) {
    const p: Vec3 = [positions[v * 3] as number, positions[v * 3 + 1] as number, positions[v * 3 + 2] as number];
    const det = warp.determinant(p);
    if (det < min) {
      min = det;
      minAt = p;
    }
    max = Math.max(max, det);
    const image = warp.point(p);
    displacement = Math.max(displacement, Math.hypot(image[0] - p[0], image[1] - p[1], image[2] - p[2]));
    used++;
  }
  return { sampled: { min, max, minAt, count: used }, maxDisplacement: displacement };
}

/** Whether the installed kernel builds this node exactly (an exact B-rep result): the recipe then describes the true geometry. */
function exactShape(kernel: GeometryKernel | null, entity: Entity): ReturnType<GeometryKernel['evaluate']> {
  if (kernel === null || !kernel.supports('deform')) return null;
  const recipe = recipeOf(entity);
  if (recipe.op === 'deform' && kernel.supportsDeform?.(recipe.law) === false) return null;
  const shape = kernel.evaluate(recipe);
  return shape !== null && kernel.topology(shape) !== null ? shape : null;
}

const meshVolume = (positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): number =>
  Math.abs(signedMeshVolume(positions, orientOutward(positions, indices)));

/**
 * Analyse `entity`, whose recipe's outermost node is `node`.
 * @failure the source cannot be rebuilt (no kernel and not a solid leaf / deform chain) -> DEF_SOURCE_UNAVAILABLE
 */
export function analyzeDeformed(
  doc: CadDocument,
  entity: Entity,
  node: DeformNode,
  kernel: GeometryKernel | null,
): DeformAnalysis | AnalysisFailure {
  const warp = warpOf(node);
  if (warp === null) return { code: 'DEF_FRAME_DEGENERATE', message: 'the recorded frame axis is zero or the reference is parallel to it' };
  const source = sourceMeshOf(kernel, node.source, doc);
  if (source === null)
    return {
      code: 'DEF_SOURCE_UNAVAILABLE',
      message: 'the deformation source cannot be rebuilt without a geometry kernel (only solid leaves and deform chains can)',
    };
  const extent = localExtentOf(warp.frame, source.positions);
  const sampling = sampleJacobian(source.positions, warp);
  const shape = exactShape(kernel, entity);
  const sourceShape = kernel === null ? null : kernel.evaluate(node.source);
  const exactSource = sourceShape === null ? undefined : kernel?.massProperties?.(sourceShape)?.volume;
  const volumes = predictedVolume(source, node);
  const exactMeasured = shape === null ? undefined : kernel?.massProperties?.(shape)?.volume;
  const measured = exactMeasured ?? (entity.kind === 'mesh' ? meshVolume(entity.mesh.positions, entity.mesh.indices) : 0);
  const sourceVolume = exactSource ?? volumes?.source ?? 0;
  const meanDeterminant = volumes === null || volumes.source === 0 ? 1 : volumes.predicted / volumes.source;
  const predicted = meanDeterminant * sourceVolume;
  const path = shape === null ? 'mesh' : 'exact';
  const stored = entity.kind === 'mesh' ? entity.mesh : null;
  const approximationError =
    path === 'mesh' && stored !== null && stored.indices.length / 3 <= MESH_TS_TRIANGLE_CAP ? storedChordError(stored, node) : null;
  return {
    node,
    path,
    extent,
    range: jacobianRange(node, extent),
    sampled: sampling.sampled,
    maxDisplacement: sampling.maxDisplacement,
    volume: {
      source: sourceVolume,
      predicted,
      measured,
      driftRel: predicted === 0 ? 0 : Math.abs(measured - predicted) / Math.abs(predicted),
      method: exactMeasured === undefined ? 'mesh' : 'exact',
    },
    approximationError,
    creases: regionCreases(node, extent),
    fibres: bendFibres(node, extent),
    unverified: hasUnverifiedLeaf(node.source),
    sourceTriangles: source.indices.length / 3,
  };
}
