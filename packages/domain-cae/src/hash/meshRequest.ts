/** What the host's mesher needs from a case: the parts to mesh, the targets to resolve to node / face sets, the controls. */

import type { MeshControls, UnitSystem } from '@core/model/analysis';
import type { CadDocument, DocumentUnit } from '@core/model/types';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import { toMetres } from '@core/model/units';
import { caseOf } from '../shared/access';
import { analysisLengthMetres } from '../shared/defaults';
import { analysisInputHash } from './inputHash';
import { keyedTargets, type KeyedTarget } from './targets';

/** Named guard (05 §5.5 VNV_LEVEL cap analogue): most tetrahedra a mesh request may be expected to produce. */
const MAX_ESTIMATED_ELEMENTS = 2e6;
/** A cube of edge `globalSize` holds about this many tetrahedra. */
const TETS_PER_CUBE = 6;

/** Tetrahedra expected from the bounding boxes of the parts at `globalSize` (refinements ignored: an estimate, not a bound). */
function estimatedElements(doc: CadDocument, entityIds: readonly string[], globalSize: number): number {
  let total = 0;
  for (const entityId of entityIds) {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined) continue;
    const { min, max } = entityBoundsInDoc(doc, entity);
    total += (((max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2])) / globalSize ** 3) * TETS_PER_CUBE;
  }
  return total;
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
 * @invariant refuses a request whose estimated element count (bounding-box volume / globalSize^3 x 6 per part) exceeds 2e6
 * @failure unknown analysis, or no part -> `{ code, message }` (FEA_ANALYSIS_NOT_FOUND / FEA_PART_INVALID); too many elements -> FEA_MESH_TOO_LARGE
 */
export function meshRequest(doc: CadDocument, analysisId: string): MeshRequest | { readonly code: string; readonly message: string } {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return { code: 'FEA_ANALYSIS_NOT_FOUND', message: `no analysis '${analysisId}'` };
  const entityIds = Object.keys(analysisCase.parts);
  if (entityIds.length === 0) return { code: 'FEA_PART_INVALID', message: `analysis '${analysisId}' has no part (set_part_idealization)` };
  const estimate = estimatedElements(doc, entityIds, analysisCase.mesh.globalSize);
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
