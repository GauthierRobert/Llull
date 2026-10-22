/** set_topology_objective: what a topology study minimises (PHY-17 V1: min_compliance or min_volume). */

import type { TopologyStudy } from '@core/model/topology';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf } from '../shared/access';
import { refuseTopology } from './codes';
import { COMPLIANCE_UNIT } from './defaults';
import { findStudy, withStudy } from './model';
import { badWeight, objectiveSchema, studyIdSchema, toObjective } from './schemas';

/**
 * @affects doc.analysis.cases[a].topology[studyId].objective (and settings.optimizer, set to mma for min_volume)
 * @invariant min_volume needs maxCompliance > 0 in the analysis compliance unit; a recorded result reads stale afterwards (the objective is input)
 * @failure unknown study -> TOP_STUDY_NOT_FOUND; maxCompliance <= 0, a load case weight <= 0, an unchanged objective -> TOP_SETUP_INVALID (unchanged doc)
 */
export const setTopologyObjective = defineCommand({
  name: 'set_topology_objective',
  description:
    'Change what a topology study minimises: min_compliance (the stiffest layout within volumeFraction, the default) or min_volume (the least ' +
    'material whose weighted compliance stays at or below maxCompliance, given in the force x length unit of the analysis unit system, e.g. N*mm; ' +
    'read a solved min_compliance report to pick it). min_volume needs the MMA optimizer, so settings.optimizer switches to mma. loadCaseWeights ' +
    'apply to both objectives (a case not listed weighs 1). A recorded result becomes stale: re-run topology_solve.',
  params: z.object({
    studyId: studyIdSchema,
    objective: objectiveSchema.describe(
      'min_compliance (stiffest within volumeFraction) or min_volume (least material with compliance <= maxCompliance).',
    ),
  }),
  run: (doc, { studyId, objective }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseTopology(doc, 'set_topology_objective', code, message, [studyId], paths);
    const found = findStudy(doc, studyId);
    if (found === undefined) return fail('TOP_STUDY_NOT_FOUND', `no topology study '${studyId}'`, ['studyId']);
    const weight = badWeight(objective);
    if (weight !== undefined)
      return fail('TOP_SETUP_INVALID', `load case weight '${weight[0]}' = ${weight[1]} must be > 0`, ['objective.loadCaseWeights']);
    if (objective.kind === 'min_volume' && !(objective.maxCompliance > 0 && Number.isFinite(objective.maxCompliance)))
      return fail('TOP_SETUP_INVALID', `maxCompliance ${objective.maxCompliance} must be > 0`, ['objective.maxCompliance']);
    const unitSystem = caseOf(doc, found.study.analysisId)?.unitSystem ?? 'N-mm-t-s';
    const next = toObjective(objective, COMPLIANCE_UNIT[unitSystem]);
    const switched = next.kind === 'min_volume' && found.study.settings.optimizer !== 'mma';
    const study: TopologyStudy = {
      ...found.study,
      objective: next,
      settings: switched ? { ...found.study.settings, optimizer: 'mma' } : found.study.settings,
    };
    if (JSON.stringify(study) === JSON.stringify(found.study))
      return fail('TOP_SETUP_INVALID', 'nothing to change: the objective is already set so');
    const what =
      next.kind === 'min_volume'
        ? `min_volume with weighted compliance <= ${next.maxCompliance} ${next.unit}${switched ? ' (optimizer switched to mma: min_volume needs it)' : ''}`
        : 'min_compliance within the volume fraction';
    const weights = Object.entries(next.loadCaseWeights);
    return changed(
      withStudy(doc, study),
      `set_topology_objective: ${studyId} — ${what}${weights.length === 0 ? '' : `; load case weights ${weights.map(([name, w]) => `${name}=${w}`).join(', ')}`}${found.study.result === undefined ? '' : '; the recorded result is now stale'}.`,
      [studyId],
    );
  },
});
