/** Input hash of an analysis (05 TR-FEA-06): equal hashes <=> the same set-up on the same geometry and materials. */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument, Entity, Material } from '@core/model/types';
import { geometryKey } from '@core/geometry/shapeRecipe';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { caseOf } from '../shared/access';
import { keyedTargets } from './targets';

const geometryHashes = new WeakMap<Entity, string>();

/** sha256 of the entity's geometry definition (presentation fields excluded); memoized per entity object. */
function geometryHash(entity: Entity): string {
  let hash = geometryHashes.get(entity);
  if (hash === undefined) {
    hash = sha256Hex(geometryKey(entity));
    geometryHashes.set(entity, hash);
  }
  return hash;
}

const meshInputs = (doc: CadDocument, analysisCase: AnalysisCase): Record<string, unknown> => ({
  unitSystem: analysisCase.unitSystem,
  parts: Object.fromEntries(
    Object.entries(analysisCase.parts).map(([entityId, idealization]) => {
      const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
      return [entityId, { idealization, geometry: entity === undefined ? null : geometryHash(entity) }];
    }),
  ),
  controls: analysisCase.mesh,
  targets: keyedTargets(analysisCase),
});

function materialsUsed(doc: CadDocument, analysisCase: AnalysisCase): Record<string, Material | null> {
  const used: Record<string, Material | null> = {};
  for (const entityId of Object.keys(analysisCase.parts)) {
    const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
    if (materialId !== undefined) used[materialId] = Object.hasOwn(doc.materials, materialId) ? (doc.materials[materialId] ?? null) : null;
  }
  return used;
}

/** Results hash of the thermal case a thermo-mechanical field reads, so a re-solved thermal case makes this one stale. */
function sourceResultsHash(doc: CadDocument, analysisCase: AnalysisCase): string | null {
  const field = analysisCase.thermomech?.field;
  if (field?.kind !== 'thermal_result') return null;
  return caseOf(doc, field.analysisId)?.results?.resultsHash ?? null;
}

const fullInputs = (doc: CadDocument, analysisCase: AnalysisCase): Record<string, unknown> => ({
  ...meshInputs(doc, analysisCase),
  type: analysisCase.type,
  solver: analysisCase.solver,
  modes: analysisCase.modes ?? null,
  factors: analysisCase.factors,
  materials: materialsUsed(doc, analysisCase),
  constraints: analysisCase.constraintOrder.map((id) => analysisCase.constraints[id]),
  loads: analysisCase.loadOrder.map((id) => analysisCase.loads[id]),
  probes: analysisCase.probes,
  thermal: analysisCase.thermal ?? null,
  thermomech: analysisCase.thermomech ?? null,
  sourceResultsHash: sourceResultsHash(doc, analysisCase),
});

/**
 * Hash of what an artifact depends on. `mesh`: part geometry + idealization, mesh controls and the targets (a mesh holds their node/face
 * sets). `full`: also type, solver, factors, constraints, loads, probes, thermal and thermo-mechanical set-ups, the materials of the parts
 * (with their property / material models) and, for a thermal-result field, the results hash of the source case. Names of the case, results
 * and mesh summaries are never part of it.
 * @failure unknown analysisId -> '' (never equal to an artifact's inputHash, so it reads as stale)
 */
export function analysisInputHash(doc: CadDocument, analysisId: string, scope: 'mesh' | 'full'): string {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return '';
  return sha256Hex(canonicalJson({ scope, ...(scope === 'mesh' ? meshInputs(doc, analysisCase) : fullInputs(doc, analysisCase)) }));
}
