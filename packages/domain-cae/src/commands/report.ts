/** fea_report: read-only state, mesh, results and probe values of an analysis. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { buildDeckContext } from '../decks/context';
import { eigenNote, eigenReport } from '../results/eigenReport';
import { eigenSummaryText } from '../results/summary';
import { transientSummaryText } from '../thermomech/transientSummary';
import { evaluateProbes } from '../results/probes';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';

/**
 * @invariant read-only; every number shown is RECOMPUTED from the artifact store (05 §4.1): state is unmeshed | meshed | solved | stale |
 *   missing (no artifact store, artifact absent, or recorded without it) | untrusted (a recorded summary differs from its artifact:
 *   FEA_SUMMARY_MISMATCH in data.problem); mesh / results are null unless verified, and the results of a stale case are withheld; probe
 *   values come from the results artifact at the nearest mesh node
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND
 */
export const feaReport = defineCommand({
  name: 'fea_report',
  description:
    'Read the finite-element status of an analysis: data { state: unmeshed | meshed | solved | stale | missing | untrusted, unitSystem, ' +
    'mesh (node and element counts, quality, warnings), results (per load case max von Mises and max displacement with positions and units, ' +
    'or the thermal summary), eigen (modal: modes [{ mode, frequencyHz, participation, effectiveMass, effectiveMassFraction }], totalEffectiveMass, ' +
    'cumulativeMassFraction, massUnit, rigidBodyModes; buckling: factors, criticalFactor, criticalMode, negativeFactors; null for other types), ' +
    'problem { code, message } | null, probes [{ probeId, quantity, unit, nodeId, nodeDistance, values per load ' +
    'case or time }] }. Numbers are recomputed from the artifact store, never read from the document: "missing" = an artifact is not ' +
    'available on this machine (or no artifact store; re-run fea_mesh / fea_solve) and "untrusted" = the recorded summary differs from its ' +
    'artifact (FEA_SUMMARY_MISMATCH); in both cases mesh and results are null. Probe values are read at the nearest mesh node (no ' +
    'interpolation). Values are in the analysis unitSystem (N-mm-t-s: mm, MPa).',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }, ctx): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseFe(doc, 'fea_report', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const trust = trustedRecord(doc, analysisCase, ctx?.feaArtifacts);
    const { state, mesh: meshRecord, results: resultsRecord, meshArtifact: mesh, resultsArtifact: results } = trust;
    const lengthToAnalysis = mesh === null ? 1 : (buildDeckContext(doc, analysisId, mesh)?.lengthToAnalysis ?? 1);
    const probes = mesh !== null && results !== null ? evaluateProbes(analysisCase, mesh, results, lengthToAnalysis) : [];
    const eigen = results === null ? null : eigenReport(analysisCase, results);
    const data = {
      analysisId,
      state,
      unitSystem: analysisCase.unitSystem,
      mesh: meshRecord,
      results: resultsRecord,
      eigen,
      problem: trust.problem,
      probes,
      probesNote:
        probes.length > 0
          ? 'values at the nearest mesh node'
          : Object.keys(analysisCase.probes).length > 0
            ? 'probe values need the results artifact (state must be solved)'
            : 'no probes defined (add_result_probe)',
    };
    const parts = [
      `fea_report: '${analysisId}' (${analysisCase.name}) — ${state}${trust.problem === null ? '' : ` (${trust.problem.code}: ${trust.problem.message})`}`,
      meshRecord === null ? 'no verified mesh' : `${meshRecord.nodes} nodes, ${meshRecord.quality.inverted} inverted`,
      resultsRecord === null
        ? 'no verified results'
        : `${resultsRecord.loadCases.length} load case(s)${resultsRecord.loadCases.map((lc) => ` ${lc.name} vm ${significantNumber(lc.maxVonMises.value, 6)}`).join(',')}${eigenSummaryText(resultsRecord)}${transientSummaryText(resultsRecord)}${eigen === null || eigenNote(eigen) === '' ? '' : `; ${eigenNote(eigen)}`}`,
      `${probes.length} probe(s) evaluated`,
    ];
    return report(doc, `${parts.join('; ')}.`, data);
  },
});
