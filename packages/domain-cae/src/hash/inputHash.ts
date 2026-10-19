/** Input hash of an analysis (05 TR-FEA-06): equal hashes <=> the same set-up on the same geometry and materials. */

import type { AnalysisCase, NonlinearSettings, ThermalSetup } from '@core/model/analysis';
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
      return [
        entityId,
        { idealization, geometry: entity === undefined ? null : geometryHash(entity), materialId: entity?.materialId ?? null },
      ];
    }),
  ),
  documentUnit: doc.units,
  controls: analysisCase.mesh,
  targets: keyedTargets(analysisCase),
});

/** The physical part of a material: what a solve reads. Name, colour, PBR values and finish are presentation and never part of a hash. */
function physicalMaterial(material: Material | null | undefined): Record<string, unknown> | null {
  if (material === null || material === undefined) return null;
  return {
    density: material.density,
    ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}),
    ...(material.materialModels !== undefined ? { materialModels: material.materialModels } : {}),
    ...(material.constitutiveSets !== undefined ? { constitutiveSets: material.constitutiveSets } : {}),
    ...(material.defaultConstitutiveSet !== undefined ? { defaultConstitutiveSet: material.defaultConstitutiveSet } : {}),
  };
}

function materialsUsed(doc: CadDocument, analysisCase: AnalysisCase): Record<string, Record<string, unknown> | null> {
  const used: Record<string, Record<string, unknown> | null> = {};
  for (const entityId of Object.keys(analysisCase.parts)) {
    const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
    if (materialId !== undefined)
      used[materialId] = Object.hasOwn(doc.materials, materialId) ? physicalMaterial(doc.materials[materialId]) : null;
  }
  return used;
}

/**
 * Results hash and current input hash of the thermal case a thermo-mechanical field reads: a re-solved OR an edited thermal case makes
 * this one stale (PHY-04 VC-TMC-50). The source is a heat case (no field of its own), so this never recurses; a self-reference is ignored.
 */
function sourceResultsHash(doc: CadDocument, analysisCase: AnalysisCase): string | null {
  const field = analysisCase.thermomech?.field;
  if (field?.kind !== 'thermal_result' || field.analysisId === analysisCase.id) return null;
  const source = caseOf(doc, field.analysisId);
  if (source === undefined) return null;
  return `${source.results?.resultsHash ?? ''}:${source.thermomech === undefined ? analysisInputHash(doc, source.id, 'full') : ''}`;
}

/** A recorded human disposition does not change the solution: it must not make the results stale. */
function withoutDispositions(thermal: ThermalSetup | undefined): Omit<ThermalSetup, 'dispositions'> | null {
  if (thermal === undefined) return null;
  const { dispositions, ...rest } = thermal;
  void dispositions;
  return rest;
}

/** Display names of steps and curve probes are presentation: renaming never makes results stale. */
function withoutNames(
  nonlinear: NonlinearSettings,
): Omit<NonlinearSettings, 'steps' | 'probes'> & { readonly steps: Record<string, unknown>; readonly probes: Record<string, unknown> } {
  const strip = <T extends { readonly name: string }>(bag: Readonly<Record<string, T>>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(bag).map(([id, entry]) => {
        const { name, ...rest } = entry;
        void name;
        return [id, rest];
      }),
    );
  return { ...nonlinear, steps: strip(nonlinear.steps), probes: strip(nonlinear.probes) };
}

const fullInputs = (doc: CadDocument, analysisCase: AnalysisCase): Record<string, unknown> => ({
  ...meshInputs(doc, analysisCase),
  type: analysisCase.type,
  solver: analysisCase.solver,
  modes: analysisCase.modes ?? null,
  ...(analysisCase.frequencyRangeHz !== undefined ? { frequencyRangeHz: analysisCase.frequencyRangeHz } : {}),
  factors: analysisCase.factors,
  materials: materialsUsed(doc, analysisCase),
  constraints: analysisCase.constraintOrder.map((id) => analysisCase.constraints[id]),
  loads: analysisCase.loadOrder.map((id) => analysisCase.loads[id]),
  probes: analysisCase.probes,
  thermal: withoutDispositions(analysisCase.thermal),
  thermomech:
    analysisCase.thermomech === undefined
      ? null
      : { ...analysisCase.thermomech, thermal: withoutDispositions(analysisCase.thermomech.thermal) },
  sourceResultsHash: sourceResultsHash(doc, analysisCase),
  ...(analysisCase.nonlinear !== undefined ? { nonlinear: withoutNames(analysisCase.nonlinear) } : {}),
});

/**
 * Hash of what an artifact depends on. `mesh`: part geometry + idealization, mesh controls and the targets (a mesh holds their node/face
 * sets). `full`: also type, solver, factors, constraints, loads, probes, thermal, thermo-mechanical and nonlinear set-ups (only when present: a linear case hashes as before), the materials of the parts
 * (physical part only: density, property / material models, constitutive sets; and the material id of each part) and the document length unit and, for a thermal-result field, the results hash of the source case. Names of the case, results
 * and mesh summaries are never part of it.
 * @failure unknown analysisId -> '' (never equal to an artifact's inputHash, so it reads as stale)
 */
export function analysisInputHash(doc: CadDocument, analysisId: string, scope: 'mesh' | 'full'): string {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return '';
  return sha256Hex(canonicalJson({ scope, ...(scope === 'mesh' ? meshInputs(doc, analysisCase) : fullInputs(doc, analysisCase)) }));
}
