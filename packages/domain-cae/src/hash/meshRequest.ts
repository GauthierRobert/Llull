/** What the host's mesher needs from a case: the parts to mesh, the targets to resolve to node / face sets, the controls. */

import type { AnalysisCase, MeshControls, UnitSystem } from '@core/model/analysis';
import type { CadDocument, DocumentUnit } from '@core/model/types';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import { signedMeshVolume } from '@core/geometry/meshVolume';
import { toMetres } from '@core/model/units';
import { caseOf } from '../shared/access';
import { analysisLengthMetres } from '../shared/defaults';
import { implicitFieldConflict } from '../fieldMesh/controls';
import { analysisInputHash } from './inputHash';
import { keyedTargets, type KeyedTarget } from './targets';

/** Named guard (05 §5.5 VNV_LEVEL cap analogue): most tetrahedra a mesh request may be expected to produce. */
const MAX_ESTIMATED_ELEMENTS = 2e6;
/** A cube of edge `globalSize` holds about this many tetrahedra. */
const TETS_PER_CUBE = 6;

/** A body-centred cubic lattice cell of edge `globalSize` holds 12 tetrahedra; cut cells at the surface add about a quarter (measured on spheres and gyroid sheets). */
const FIELD_TETS_PER_CUBE = 12 * 1.25;

/**
 * Tetrahedra expected at `globalSize` (refinements ignored: an estimate, not a bound): bounding boxes for the geometry mesher; for the field mesher
 * the volume of a mesh entity's stored triangles (an implicit body is mostly void in its box), the bounding box otherwise.
 */
function estimatedElements(doc: CadDocument, entityIds: readonly string[], controls: MeshControls): number {
  let total = 0;
  for (const entityId of entityIds) {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined) continue;
    if (controls.source === 'implicit_field' && entity.kind === 'mesh') {
      total += (Math.abs(signedMeshVolume(entity.mesh.positions, entity.mesh.indices)) / controls.globalSize ** 3) * FIELD_TETS_PER_CUBE;
      continue;
    }
    const { min, max } = entityBoundsInDoc(doc, entity);
    total += (((max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2])) / controls.globalSize ** 3) * TETS_PER_CUBE;
  }
  return total;
}

/** Why the parts of a field-meshed case cannot be meshed from a field, or null. */
function fieldSourceProblem(analysisCase: AnalysisCase): { readonly code: string; readonly message: string } | null {
  const conflict = implicitFieldConflict(analysisCase.mesh);
  if (conflict !== null) return { code: 'FLL_IMPLICIT_MESH_UNSUPPORTED', message: conflict };
  const surface = Object.entries(analysisCase.parts).find(([, idealization]) => idealization.kind !== 'solid');
  if (analysisCase.mesh.source === 'implicit_field' && surface !== undefined)
    return {
      code: 'FLL_IMPLICIT_MESH_UNSUPPORTED',
      message: `part '${surface[0]}' is a ${surface[1].kind} part: source implicit_field meshes solid parts only (set_part_idealization solid, or source geometry)`,
    };
  return null;
}

export interface MeshRequest {
  readonly analysisId: string;
  /** Solid parts to mesh (every key of `case.parts`). */
  readonly entityIds: readonly string[];
  readonly unitSystem: UnitSystem;
  readonly documentUnit: DocumentUnit;
  /** Multiply document-unit lengths by this to get the analysis length unit (mesh nodes are written in the analysis unit). */
  readonly lengthToAnalysis: number;
  readonly targets: readonly KeyedTarget[];
  /** Sizes are in document units. */
  readonly controls: MeshControls;
  /** `analysisInputHash(doc, analysisId, 'mesh')`: copied into the mesh artifact. */
  readonly inputHash: string;
}

/**
 * Mesher request for `analysisId`.
 * @invariant refuses a request whose estimated element count (bounding-box volume / globalSize^3 x 6 per part; source implicit_field: body volume /
 *   globalSize^3 x 15) exceeds 2e6
 * @failure unknown analysis, or no part -> `{ code, message }` (FEA_ANALYSIS_NOT_FOUND / FEA_PART_INVALID); too many elements -> FEA_MESH_TOO_LARGE;
 *   source implicit_field with refinements, conformal bonding or a non-solid part -> FLL_IMPLICIT_MESH_UNSUPPORTED
 */
export function meshRequest(doc: CadDocument, analysisId: string): MeshRequest | { readonly code: string; readonly message: string } {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return { code: 'FEA_ANALYSIS_NOT_FOUND', message: `no analysis '${analysisId}'` };
  const entityIds = Object.keys(analysisCase.parts);
  if (entityIds.length === 0) return { code: 'FEA_PART_INVALID', message: `analysis '${analysisId}' has no part (set_part_idealization)` };
  const fieldProblem = fieldSourceProblem(analysisCase);
  if (fieldProblem !== null) return fieldProblem;
  const estimate = estimatedElements(doc, entityIds, analysisCase.mesh);
  if (!(estimate <= MAX_ESTIMATED_ELEMENTS))
    return {
      code: 'FEA_MESH_TOO_LARGE',
      message: `about ${Math.round(estimate).toExponential(2)} tetrahedra expected at globalSize ${analysisCase.mesh.globalSize} (cap ${MAX_ESTIMATED_ELEMENTS.toExponential(0)}): raise globalSize with set_mesh_controls`,
    };
  return {
    analysisId,
    entityIds,
    unitSystem: analysisCase.unitSystem,
    documentUnit: doc.units,
    lengthToAnalysis: toMetres(doc, 1) / analysisLengthMetres(analysisCase.unitSystem),
    targets: keyedTargets(analysisCase),
    controls: analysisCase.mesh,
    inputHash: analysisInputHash(doc, analysisId, 'mesh'),
  };
}
