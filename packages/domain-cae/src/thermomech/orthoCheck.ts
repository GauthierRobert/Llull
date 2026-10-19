/** Readiness of a part with an orthotropic CTE for `check_thermo_mechanical` (PHY-04 M4b). */

import type { ThermoMechSetup } from '@core/model/analysis';
import { isCteRefusal } from '@core/model/materialCte';
import type { CadDocument } from '@core/model/types';
import { providerFor, REFERENCE_PROBE_KELVIN } from './cte';
import { incompleteOrthoRefusal, ORTHO_DIRECTIONS } from './orthoCte';

export interface CheckProblem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly ids: readonly string[];
}

/**
 * Directions complete, a CTE evaluable at the reference in every direction, an orientation when the part is rotated, unverified models, and
 * the isotropic-elasticity reminder.
 * @failure TMC_CTE_ORTHO_INCOMPLETE, TMC_CTE_BASIS_UNKNOWN, TMC_PROPERTY_OUT_OF_RANGE, TMC_ORIENTATION_REQUIRED (errors); TMC_MATERIAL_UNVERIFIED,
 *   TMC_CTE_ORTHO_ELASTIC_ISOTROPIC (warnings)
 */
export function orthoPartProblems(
  doc: CadDocument,
  setup: ThermoMechSetup,
  entityId: string,
  materialId: string,
  referenceKelvin: number,
): CheckProblem[] {
  const ids = [materialId, entityId];
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  const incomplete = incompleteOrthoRefusal(material, materialId);
  if (incomplete !== null) return [{ code: incomplete.code, severity: 'error', message: incomplete.reason, ids }];
  const problems: CheckProblem[] = [];
  const reasons: string[] = [];
  for (const direction of ORTHO_DIRECTIONS) {
    const provider = providerFor(doc, setup, materialId, `material direction ${direction}`, direction);
    const probe = isCteRefusal(provider) ? provider : provider.strainAt(referenceKelvin + REFERENCE_PROBE_KELVIN, referenceKelvin);
    if (isCteRefusal(probe)) {
      problems.push({ code: probe.code, severity: 'error', message: `direction ${direction}: ${probe.reason}`, ids });
      continue;
    }
    reasons.push(...probe.unverifiedReasons.map((reason) => `direction ${direction}: ${reason}`));
  }
  if (reasons.length > 0)
    problems.push({
      code: 'TMC_MATERIAL_UNVERIFIED',
      severity: 'warning',
      message: `material '${materialId}' (part ${entityId}) is unverified: ${[...new Set(reasons)].join('; ')}`,
      ids,
    });
  const rotation = Object.hasOwn(doc.entities, entityId) ? (doc.entities[entityId]?.rotation ?? []) : [];
  if (rotation.some((angle) => angle !== 0) && !Object.hasOwn(setup.orientations ?? {}, entityId))
    problems.push({
      code: 'TMC_ORIENTATION_REQUIRED',
      severity: 'error',
      message: `part '${entityId}' is rotated and has an orthotropic CTE: set_material_orientation must give its material directions`,
      ids: [entityId],
    });
  problems.push({
    code: 'TMC_CTE_ORTHO_ELASTIC_ISOTROPIC',
    severity: 'warning',
    message: `part '${entityId}': the CTE of '${materialId}' is orthotropic but E and nu are written isotropic (05 elastic cards); stiffness anisotropy is not modelled`,
    ids,
  });
  return problems;
}
