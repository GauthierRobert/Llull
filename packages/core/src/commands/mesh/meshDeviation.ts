/** Symmetric (Hausdorff) deviation of two meshes or 3D solids: the `symmetric` mode of measure_deviation (07 MSH FR-MSH-25). */

import type { MeshAssetPort } from '../../geometry/mesh/assets';
import type { CadDocument } from '../../model/types';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import type { MeshProcessingEngine } from '../../geometry/mesh/engineTypes';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { DEVIATION_BASIS, engineDeviation } from './runMeshOp';
import { isLoadFailure, loadSolidMesh, meshRejection, withConventions } from './meshCommon';

/**
 * @affects none; data = { id, referenceId, forwardMax, backwardMax, hausdorff, mean, rms, samples, histogram, worst, tolerance?, pass?, unit, unverified }
 * @invariant forwardMax is reference -> target (as the one-way mode), backwardMax target -> reference; samples are vertices and triangle centroids
 * @failure unknown id / non-solid -> MESH_ENTITY_NOT_FOUND / MESH_NOT_A_MESH; an empty mesh -> MESH_NOT_A_MESH
 */
export function symmetricMeshDeviation(
  doc: CadDocument,
  id: string,
  referenceId: string,
  tolerance: number | undefined,
  assets: MeshAssetPort | null | undefined,
  extraEngine: MeshProcessingEngine | null | undefined,
): CommandResult {
  const target = loadSolidMesh(doc, id, undefined, assets);
  if (isLoadFailure(target)) return meshRejection(doc, 'measure_deviation', target.code, target.message, target.ids);
  const reference = loadSolidMesh(doc, referenceId, undefined, assets);
  if (isLoadFailure(reference))
    return meshRejection(doc, 'measure_deviation', reference.code, reference.message, reference.ids, ['params.referenceId']);
  const result = engineDeviation(resolveMeshEngine(extraEngine), reference.mesh, target.mesh);
  if ('code' in result) return meshRejection(doc, 'measure_deviation', result.code, result.message, [id, referenceId]);
  const pass = tolerance === undefined ? undefined : result.hausdorff <= tolerance;
  const data = withConventions(
    doc,
    {
      id,
      referenceId,
      symmetric: true,
      forwardMax: result.forwardMax,
      backwardMax: result.backwardMax,
      hausdorff: result.hausdorff,
      mean: result.mean,
      rms: result.rms,
      samples: result.samples,
      histogram: result.histogram,
      histogramBinWidth: result.hausdorff / 10,
      worst: { point: result.worst.point, from: result.worst.mesh === 'a' ? referenceId : id, distance: result.worst.distance },
      basis: DEVIATION_BASIS,
      ...(tolerance === undefined ? {} : { tolerance, pass }),
    },
    { unverified: target.unverified || reference.unverified },
  );
  return report(
    doc,
    `measure_deviation ${id} <-> ${referenceId} (symmetric): hausdorff ${result.hausdorff.toPrecision(8)} ${doc.units} (reference->target ${result.forwardMax.toPrecision(6)}, ` +
      `target->reference ${result.backwardMax.toPrecision(6)}), mean ${result.mean.toPrecision(6)}, rms ${result.rms.toPrecision(6)}` +
      (pass === undefined ? '.' : `; tolerance ${tolerance} -> ${pass ? 'PASS' : 'FAIL'}.`),
    data,
  );
}
