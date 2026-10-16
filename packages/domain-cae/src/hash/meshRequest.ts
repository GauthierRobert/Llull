/** What the host's mesher needs from a case: the parts to mesh, the targets to resolve to node / face sets, the controls. */

import type { MeshControls, UnitSystem } from '@core/model/analysis';
import type { CadDocument, DocumentUnit } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { caseOf } from '../shared/access';
import { analysisLengthMetres } from '../shared/defaults';
import { analysisInputHash } from './inputHash';
import { keyedTargets, type KeyedTarget } from './targets';

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
 * @failure unknown analysis, or no part -> `{ code, message }` (FEA_ANALYSIS_NOT_FOUND / FEA_PART_INVALID)
 */
export function meshRequest(doc: CadDocument, analysisId: string): MeshRequest | { readonly code: string; readonly message: string } {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return { code: 'FEA_ANALYSIS_NOT_FOUND', message: `no analysis '${analysisId}'` };
  const entityIds = Object.keys(analysisCase.parts);
  if (entityIds.length === 0) return { code: 'FEA_PART_INVALID', message: `analysis '${analysisId}' has no part (set_part_idealization)` };
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
