/** topology_report: read-only report of a topology study (PHY-17, AF-20/21/35). */

import type { TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { refuseTopology } from './codes';
import { findStudy } from './model';
import { studyIdSchema } from './schemas';
import { trustedTopology } from './trust';

const FORMULATION =
  'modified SIMP E(x) = Emin + x^p (E0 - Emin), Q4 plane-stress / H8 elements on a voxel grid, optimality-criteria update with bisection on the volume multiplier, ' +
  'sensitivity or density filter with linear-hat weights (Andreassen et al. 2011, doi:10.1007/s00158-010-0594-7)';

/** The study as the agent should read it: definition without the bulky region geometry. */
function studyView(doc: CadDocument, study: TopologyStudy): Record<string, unknown> {
  return {
    id: study.id,
    name: study.name,
    analysisId: study.analysisId,
    dimension: study.dimension,
    ...(study.plane !== undefined ? { plane: study.plane } : {}),
    designDomain: study.designDomain,
    voxel: study.voxel,
    lengthUnit: doc.units,
    volumeFraction: study.volumeFraction,
    objective: study.objective,
    keepIn: study.keepIn,
    keepOut: study.keepOut,
  };
}

/**
 * @invariant read-only; numbers come from the summary RE-VERIFIED against the artifact (state `solved`), a stale / missing / untrusted
 *   record shows none; the result is a concept shape (concept: true), never a released design
 * @failure unknown study -> TOP_STUDY_NOT_FOUND (rejected no-op)
 */
export const topologyReport = defineCommand({
  name: 'topology_report',
  annotations: { readOnly: true },
  description:
    'Read-only report of a topology study: state (unsolved | solved | stale | missing | untrusted), the study definition, the named settings, ' +
    'and - when solved - the verified result: compliance and its unit, iterations, status (converged | max_iterations), volume fraction, grey level ' +
    '(share of intermediate densities), solid volume, per-load-case compliance, the last `historyRows` iteration rows, the solver and its provenance. ' +
    'A stale result (study or analysis changed since the run) shows no numbers: re-run topology_solve. The result is a concept shape that must be ' +
    'rebuilt with ordinary modelling commands (suggest_rebuild) and reviewed by an engineer; it is never releasable.',
  params: z.object({
    studyId: studyIdSchema,
    historyRows: z.number().int().optional().describe('How many of the last iteration history rows to return, 0 to 1000. Default 20.'),
  }),
  run: (doc, { studyId, historyRows = 20 }, ctx): CommandResult => {
    const found = findStudy(doc, studyId);
    if (found === undefined)
      return refuseTopology(doc, 'topology_report', 'TOP_STUDY_NOT_FOUND', `no topology study '${studyId}'`, [studyId]);
    const { study } = found;
    const trusted = trustedTopology(doc, study, ctx?.feaArtifacts);
    const summary = trusted.summary;
    const rows = Math.max(0, Math.min(1000, historyRows));
    const derived = study.derivedEntityId;
    const data = {
      state: trusted.state,
      study: studyView(doc, study),
      result: summary === null ? null : { ...summary, history: summary.history.slice(Math.max(0, summary.history.length - rows)) },
      settings: study.settings,
      manufacturing: study.manufacturing,
      provenance: {
        formulation: FORMULATION,
        solver: summary?.solver ?? null,
        inputHash: study.result?.inputHash ?? null,
        settingsHash: study.result?.settingsHash ?? null,
        fieldHash: study.result?.fieldHash ?? null,
      },
      derivedEntityId: derived ?? null,
      derivedGeometry: derived === undefined ? 'none' : Object.hasOwn(doc.entities, derived) ? 'present' : 'absent',
      problem: trusted.problem,
      concept: true,
      unverified: summary?.unverified ?? false,
      unverifiedReasons: summary?.unverifiedReasons ?? [],
      reviewRequired: true,
    };
    const text =
      summary === null
        ? `topology_report: ${studyId} state ${trusted.state}${trusted.problem === null ? '' : ` (${trusted.problem.code}: ${trusted.problem.message})`}.`
        : `topology_report: ${studyId} solved — ${summary.iterations} iterations (${summary.status}), compliance ${significantNumber(summary.compliance, 6)} ${summary.complianceUnit}, volume fraction ${significantNumber(summary.volumeFraction, 4)}, grey ${significantNumber(summary.grey, 3)}, solid volume ${significantNumber(summary.thresholdedVolume, 6)} ${summary.volumeUnit}; concept shape, review required.`;
    return report(doc, text, data);
  },
});
