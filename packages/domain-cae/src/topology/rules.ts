/** The V1 rules a study runs under, as one statement each (FR-TOP-13: every manufacturing constraint is listed in the report). */

import type { TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';

/** Manufacturing constraints, the minimum member rule and the projection of `study`, in reading order. */
export function studyRules(doc: CadDocument, study: TopologyStudy): string[] {
  const { manufacturing, settings } = study;
  const rules: string[] = [];
  if (manufacturing.symmetry.length > 0)
    rules.push(`symmetry: the density field is mirrored across the ${manufacturing.symmetry.join(', ')} plane(s)`);
  if (manufacturing.extrusion !== undefined)
    rules.push(
      `extrusion: the design is uniform along world axis ${manufacturing.extrusion.axis} (one design variable per column of voxels)`,
    );
  if (manufacturing.minMemberSize !== undefined) {
    const half = manufacturing.minMemberSize / 2;
    const effective = Math.max(settings.filter.radius.value, half);
    rules.push(
      `minimum member size ${manufacturing.minMemberSize} ${doc.units}: filter radius >= ${half} ${doc.units} (llull rule rmin >= size / 2; effective radius ${effective} ${doc.units} = ${effective / study.voxel} voxels)`,
    );
  }
  if (settings.projection !== undefined) {
    const { beta, eta, betaStart, betaEvery } = settings.projection;
    rules.push(
      `Heaviside projection on the density filter: beta ${betaStart.value} -> ${beta.value}, doubling every ${betaEvery.value} iterations or on convergence, eta ${eta.value}`,
    );
  }
  if (study.objective.kind === 'min_volume')
    rules.push(
      `objective min_volume: least material with weighted compliance <= ${study.objective.maxCompliance} ${study.objective.unit} (optimizer mma)`,
    );
  return rules;
}
