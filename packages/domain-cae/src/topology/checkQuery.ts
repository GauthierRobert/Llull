/** check_topology: readiness and review check of a topology study with stable codes (PHY-17 7.1, AF-20). */

import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { item, REVIEW_NOTE, statusOfItems, type Item } from '../fatigue/items';
import { REMEDIATION, refuseTopology } from './codes';
import { COMPLIANCE_RATIO_TARGET, IOU_TARGET } from './defaults';
import { buildTopologyJob } from './job';
import { findStudy } from './model';
import { compareRebuild } from './rebuild';
import { rebuildCompliance } from './rebuildCompliance';
import { studyIdSchema } from './schemas';
import { trustedTopology } from './trust';
import { topologyDocument } from './guard';

const entry = (code: string, severity: Item['severity'], message: string, ids: readonly string[] = []): Item =>
  item(code, severity, message, REMEDIATION[code] ?? 'see the command description', ids);

/**
 * @invariant read-only; the release hook (TR-TOP-12): an entity id in `release` that is a topology-derived iso-surface is TOP_RESULT_NOT_RELEASABLE;
 *   TOP_INPUT_UNVERIFIED cannot be suppressed; reviewRequired is always true
 * @failure unknown study -> TOP_STUDY_NOT_FOUND (rejected no-op)
 */
export const checkTopology = defineCommand({
  name: 'check_topology',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Readiness and review check of a topology study; call it last. Items with stable codes: set-up problems (TOP_SETUP_INVALID, ' +
    'TOP_TARGET_UNMAPPED, TOP_LOAD_OUTSIDE_DOMAIN, TOP_REGION_OUTSIDE_DOMAIN, TOP_KEEPIN_EXCEEDS_BUDGET, TOP_GRID_TOO_LARGE), TOP_FILTER_TOO_SMALL, ' +
    'result state (TOP_RESULT_MISSING, TOP_RESULT_STALE), TOP_NOT_CONVERGED, TOP_GREY_HIGH, TOP_CONSTRAINT_VIOLATED (a volume or compliance limit ' +
    'not met), TOP_INPUT_UNVERIFIED (material values not verified), ' +
    'and the rebuild: TOP_REBUILD_MISSING when no `rebuildEntityIds` are given for a solved study, TOP_REBUILD_DEVIATION (IoU below the 0.85 target) ' +
    'and, for each rebuilt solid you pass, the compliance ratio F^T u / optimum from its current 05 static result (TOP_REBUILD_DEVIATION above 1.15, TOP_REBUILD_NOT_ANALYSED when there is no such result). `release` lists entity ids about to be released or exported: a topology iso-surface ' +
    'among them is TOP_RESULT_NOT_RELEASABLE (release the rebuilt part instead). status is fail on any error / fail item, warn on a warning, else pass; ' +
    'reviewRequired is always true (concept result).',
  params: z.object({
    studyId: studyIdSchema,
    rebuildEntityIds: z
      .array(z.string())
      .optional()
      .describe('Ids of the solids that rebuild the optimized layout; each is compared with the optimum (IoU).'),
    release: z
      .array(z.string())
      .optional()
      .describe('Ids of entities about to be released or exported; topology-derived iso-surfaces among them are refused.'),
  }),
  run: (doc: CadDocument, { studyId, rebuildEntityIds, release = [] }, ctx): CommandResult => {
    const found = findStudy(doc, studyId);
    if (found === undefined)
      return refuseTopology(doc, 'check_topology', 'TOP_STUDY_NOT_FOUND', `no topology study '${studyId}'`, [studyId]);
    const { study } = found;
    const items: Item[] = [];
    const job = buildTopologyJob(doc, study);
    if (!job.ok) items.push(entry(job.code, 'error', job.message, job.ids));
    else {
      const budget = study.volumeFraction * job.job.grid.active;
      if (job.job.grid.keepIn >= budget)
        items.push(
          entry(
            'TOP_KEEPIN_EXCEEDS_BUDGET',
            'error',
            `${job.job.grid.keepIn} keep-in voxels (regions and protected load / support layers) reach the budget of ${budget}`,
            [studyId],
          ),
        );
      const reasons = job.job.material.unverifiedReasons;
      if (reasons.length > 0)
        items.push(entry('TOP_INPUT_UNVERIFIED', 'warning', `material inputs are unverified: ${reasons.join('; ')}`, [studyId]));
    }
    if (study.settings.filter.radius.value < study.voxel)
      items.push(
        entry(
          'TOP_FILTER_TOO_SMALL',
          'warning',
          `filter radius ${study.settings.filter.radius.value} ${doc.units} is below 1 voxel (${study.voxel})`,
          [studyId],
        ),
      );
    const trusted = trustedTopology(doc, study, ctx?.feaArtifacts);
    if (trusted.state === 'unsolved' || trusted.state === 'missing')
      items.push(entry('TOP_RESULT_MISSING', 'error', trusted.problem?.message ?? 'no result is recorded for the study', [studyId]));
    else if (trusted.state === 'stale')
      items.push(entry('TOP_RESULT_STALE', 'error', 'the study or the analysis changed after the last solve', [studyId]));
    else if (trusted.state === 'untrusted')
      items.push(
        entry('TOP_SUMMARY_MISMATCH', 'error', trusted.problem?.message ?? 'the recorded result differs from its artifact', [studyId]),
      );
    const summary = trusted.summary;
    if (summary !== null && trusted.artifact !== null && trusted.field !== null) {
      if (summary.status === 'max_iterations')
        items.push(
          entry(
            'TOP_NOT_CONVERGED',
            'warning',
            `stopped at the iteration cap (${summary.iterations}) before the design change fell below the tolerance`,
            [studyId],
          ),
        );
      if (summary.grey > study.settings.greyLimit.value)
        items.push(
          entry('TOP_GREY_HIGH', 'warning', `grey level ${summary.grey} exceeds the limit ${study.settings.greyLimit.value}`, [studyId]),
        );
      for (const constraint of summary.constraints)
        if (!constraint.satisfied)
          items.push(
            entry('TOP_CONSTRAINT_VIOLATED', 'fail', `${constraint.name} ${constraint.value} exceeds its limit ${constraint.limit}`, [
              studyId,
            ]),
          );
      const rebuilds = rebuildEntityIds ?? [];
      if (rebuilds.length === 0)
        items.push(entry('TOP_REBUILD_MISSING', 'warning', 'no rebuilt solid was given to compare with the optimum', [studyId]));
      for (const entityId of rebuilds) {
        const comparison = compareRebuild(doc, study, trusted.artifact, trusted.field, entityId);
        if (typeof comparison === 'string') items.push(entry('TOP_REBUILD_DEVIATION', 'fail', comparison, [entityId]));
        else {
          if (comparison.iou < IOU_TARGET.value)
            items.push(entry('TOP_REBUILD_DEVIATION', 'fail', `IoU ${comparison.iou} is below the target ${IOU_TARGET.value}`, [entityId]));
          const compliance = rebuildCompliance(
            doc,
            study,
            trusted.artifact.compliance,
            Object.keys(trusted.artifact.perLoadCase),
            entityId,
            ctx?.feaArtifacts,
          );
          if (!compliance.available)
            items.push(
              entry('TOP_REBUILD_NOT_ANALYSED', 'warning', `the compliance of '${entityId}' is not compared: ${compliance.message}`, [
                entityId,
              ]),
            );
          else if (compliance.ratio > COMPLIANCE_RATIO_TARGET.value)
            items.push(
              entry(
                'TOP_REBUILD_DEVIATION',
                'fail',
                `compliance ratio ${compliance.ratio} of '${entityId}' exceeds the target ${COMPLIANCE_RATIO_TARGET.value}`,
                [entityId],
              ),
            );
        }
      }
    }
    const derived = topologyDocument.derivedEntityIds(doc);
    const forbidden = release.filter((id) => derived.has(id));
    if (forbidden.length > 0)
      items.push(
        entry(
          'TOP_RESULT_NOT_RELEASABLE',
          'error',
          `${forbidden.join(', ')} ${forbidden.length === 1 ? 'is a' : 'are'} topology iso-surface(s)`,
          forbidden,
        ),
      );
    const status = statusOfItems(items);
    return report(
      doc,
      `check_topology: ${studyId} ${status}${items.length === 0 ? '' : ` — ${items.map((i) => i.code).join(', ')}`}; ${REVIEW_NOTE}`,
      { status, state: trusted.state, items, reviewRequired: true, note: REVIEW_NOTE },
    );
  },
});
