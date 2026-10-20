/** Input hash of an explicit run (TR-EXP-51 analogue): equal hashes <=> the same explicit problem. */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { geometryKey } from '@core/geometry/shapeRecipe';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { explicitMaterial } from './laws';

/**
 * Hash of what a run reads: parts (geometry, idealization, resolved material view), the spec without its recorded results (values only for the
 * named settings), the unit system, the document unit and - for an fea_mesh source - the recorded mesh hash.
 * @failure no spec -> '' (never equal to an artifact's inputHash)
 */
export function explicitInputHash(doc: CadDocument, analysisCase: AnalysisCase): string {
  const spec = analysisCase.explicit;
  if (spec === undefined) return '';
  const { results, timeStepScale, hourglassCoefficient, bulkViscosity, ...rest } = spec;
  void results;
  const parts = Object.keys(analysisCase.parts)
    .sort()
    .map((entityId) => {
      const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
      const material = explicitMaterial(doc, analysisCase, entityId);
      return {
        entityId,
        geometry: entity === undefined ? null : sha256Hex(geometryKey(entity)),
        idealization: analysisCase.parts[entityId] ?? null,
        material: 'code' in material ? material.code : { ...material, source: null },
      };
    });
  return sha256Hex(
    canonicalJson({
      scope: 'explicit',
      documentUnit: doc.units,
      unitSystem: analysisCase.unitSystem,
      parts,
      constraints: analysisCase.constraintOrder.map((id) => analysisCase.constraints[id] ?? null),
      spec: {
        ...rest,
        timeStepScale: timeStepScale.value,
        hourglassCoefficient: hourglassCoefficient.value,
        bulkViscosity: { linear: bulkViscosity.linear.value, quadratic: bulkViscosity.quadratic.value },
      },
      meshHash: spec.mesh.kind === 'fea_mesh' ? (analysisCase.meshSummary?.meshHash ?? null) : null,
    }),
  );
}
