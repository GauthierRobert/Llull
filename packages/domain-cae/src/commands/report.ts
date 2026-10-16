/** fea_report: read-only state, mesh, results and probe values of an analysis. */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { buildDeckContext } from '../decks/context';
import { evaluateProbes } from '../results/probes';
import { caseOf } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { stateOf } from '../shared/state';

/**
 * @invariant read-only; state is unmeshed | meshed | solved | stale, or `missing` when a recorded mesh / results artifact is not in the
 *   artifact store of this machine (TR-FEA-05); probe values come from the results artifact at the nearest mesh node
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND
 */
export const feaReport = defineCommand({
  name: 'fea_report',
  description:
    'Read the finite-element status of an analysis: data { state: unmeshed | meshed | solved | stale | missing, unitSystem, mesh (node and ' +
    'element counts, quality, warnings), results (per load case max von Mises and max displacement with positions and units, or the thermal ' +
    'summary), probes [{ probeId, quantity, unit, nodeId, nodeDistance, values per load case or time }] }. "missing" = a recorded artifact is ' +
    'not available on this machine (re-run fea_mesh / fea_solve). Probe values are read at the nearest mesh node (no interpolation). ' +
    'Values are in the analysis unitSystem (N-mm-t-s: mm, MPa).',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }, ctx): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseFe(doc, 'fea_report', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const base = stateOf(doc, analysisCase);
    const port = ctx?.feaArtifacts ?? null;
    const meshRecord = analysisCase.meshSummary;
    const resultsRecord = analysisCase.results;
    const meshArtifact = meshRecord === undefined ? null : (port?.get(meshRecord.meshHash) ?? null);
    const resultsArtifact = resultsRecord === undefined ? null : (port?.get(resultsRecord.resultsHash) ?? null);
    const mesh: FeMeshArtifact | null = meshArtifact?.kind === 'fe_mesh' ? meshArtifact : null;
    const results: FeResultsArtifact | null = resultsArtifact?.kind === 'fe_results' ? resultsArtifact : null;
    const absent = (meshRecord !== undefined && mesh === null) || (resultsRecord !== undefined && results === null);
    const state = base === 'unmeshed' || base === 'stale' ? base : absent ? 'missing' : base;
    const lengthToAnalysis = mesh === null ? 1 : (buildDeckContext(doc, analysisId, mesh)?.lengthToAnalysis ?? 1);
    const probes = mesh !== null && results !== null ? evaluateProbes(analysisCase, mesh, results, lengthToAnalysis) : [];
    const data = {
      analysisId,
      state,
      unitSystem: analysisCase.unitSystem,
      mesh: meshRecord ?? null,
      results: resultsRecord ?? null,
      probes,
      probesNote:
        probes.length > 0
          ? 'values at the nearest mesh node'
          : Object.keys(analysisCase.probes).length > 0
            ? 'probe values need the results artifact (state must be solved)'
            : 'no probes defined (add_result_probe)',
    };
    const parts = [
      `fea_report: '${analysisId}' (${analysisCase.name}) — ${state}`,
      meshRecord === undefined ? 'no mesh' : `${meshRecord.nodes} nodes, ${meshRecord.quality.inverted} inverted`,
      resultsRecord === undefined
        ? 'no results'
        : `${resultsRecord.loadCases.length} load case(s)${resultsRecord.loadCases.map((lc) => ` ${lc.name} vm ${significantNumber(lc.maxVonMises.value, 6)}`).join(',')}`,
      `${probes.length} probe(s) evaluated`,
    ];
    return report(doc, `${parts.join('; ')}.`, data);
  },
});
