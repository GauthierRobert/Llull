/** check_analysis items of the 14 FLL lane: stale flight run, unsupported inertial loads, unbalanced inertial relief. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { MassContext } from '@core/geometry/resolveMassProperties';
import type { CadDocument } from '@core/model/types';
import { appendAll } from '@lib/appendAll';
import { fllRemediation } from './codes';
import { flightDesignHash } from './designHash';
import { inertialUnsupported } from './inertialSupport';
import { reliefAssessment, RELIEF_TOLERANCE, type ReliefAssessment } from './rigidBalance';
import { solvedRelief, SOLVED_RELIEF_TOLERANCE } from './solvedReactions';

export interface FlightLoadItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (code: string, severity: FlightLoadItem['severity'], message: string, ids: readonly string[]): FlightLoadItem => ({
  code,
  severity,
  ids,
  message,
  remediation: fllRemediation(code),
});

const number = (value: number): number => Number(value.toPrecision(4));
const percent = (part: number, whole: number): number => number((100 * part) / Math.max(whole, 1e-300));

/** Mesh and results of a trusted solve (check_analysis state `solved`). */
interface SolvedArtifacts {
  readonly meshArtifact: FeMeshArtifact | null;
  readonly resultsArtifact: FeResultsArtifact | null;
}

/**
 * FLL_RELIEF_REACTION (error): a solved free-body case whose 3-2-1 reactions exceed SOLVED_RELIEF_TOLERANCE of the applied load;
 * FLL_RELIEF_REACTION_UNREAD (warning): a case whose solved reactions could not be read.
 */
function solvedReliefItems(doc: CadDocument, analysis: AnalysisCase, relief: ReliefAssessment, solved: SolvedArtifacts): FlightLoadItem[] {
  if (solved.meshArtifact === null || solved.resultsArtifact === null || relief.centreOfMass === null) return [];
  const applied = new Map(relief.balances.map((balance) => [balance.loadCase, balance]));
  const check = solvedRelief(doc, analysis, solved.meshArtifact, solved.resultsArtifact, applied, relief.centreOfMass);
  if (check === null) return [];
  return [
    ...check.cases
      .filter((entry) => !entry.balanced)
      .map((entry) =>
        item(
          'FLL_RELIEF_REACTION',
          'error',
          `load case '${entry.loadCase}': the solved 3-2-1 reactions are not near zero: net force ${number(entry.reactionForce)} (${percent(entry.reactionForce, entry.appliedForce)} % of the applied ${number(entry.appliedForce)}) and moment ${number(entry.reactionMoment)} (${percent(entry.reactionMoment, entry.momentScale)} % of ${number(entry.momentScale)}, the larger of the applied moment and the applied force x the support spread) about the centre of mass, above ${SOLVED_RELIEF_TOLERANCE * 100} % (printed RF minus the nodal loads of the support nodes)`,
          [analysis.id],
        ),
      ),
    ...check.unassessed.map((reason) =>
      item('FLL_RELIEF_REACTION_UNREAD', 'warning', `the solved reactions were not checked: ${reason}`, [analysis.id]),
    ),
  ];
}

/**
 * FLL_INERTIAL_UNSUPPORTED (error): an inertial load in a non-static analysis; FLL_RUN_STALE (error): a flight load whose recorded design hash differs from the
 * current one; FLL_RELIEF_RESIDUAL (error): a load case of a free-body analysis whose net force or moment on the rigid body exceeds 1e-4 of the applied load
 * (the 3-2-1 reactions would equal it); FLL_RELIEF_UNASSESSED (warning): loads or mass the balance could not use.
 * @invariant empty for an analysis with no inertial / flight load and no free-body support
 */
export function flightLoadItems(
  doc: CadDocument,
  analysis: AnalysisCase,
  ctx?: MassContext,
  solved?: SolvedArtifacts | null,
): FlightLoadItem[] {
  const items: FlightLoadItem[] = [];
  const loads = analysis.loadOrder.flatMap((id) => analysis.loads[id] ?? []);
  const unsupported = inertialUnsupported(analysis);
  if (unsupported !== null) items.push(item(unsupported.code, 'error', unsupported.message, unsupported.ids));
  const sourced = loads.filter((load) => load.flightSource?.designHash != null);
  if (sourced.length > 0) {
    const current = flightDesignHash(doc, analysis);
    const stale = sourced.filter((load) => load.flightSource?.designHash !== current);
    if (stale.length > 0)
      items.push(
        item(
          'FLL_RUN_STALE',
          'error',
          `the design changed after the flight run of scenario(s) ${[...new Set(stale.map((load) => `'${load.flightSource?.scenario}'`))].join(', ')} (${stale.length} load(s))`,
          stale.map((load) => load.id),
        ),
      );
  }
  const relief = reliefAssessment(doc, analysis, ctx);
  if (relief === null) return items;
  for (const balance of relief.balances)
    if (!balance.balanced)
      items.push(
        item(
          'FLL_RELIEF_RESIDUAL',
          'error',
          `load case '${balance.loadCase}' is not balanced: the supports would carry a net force ${number(balance.residualForce)} (${number((100 * balance.residualForce) / Math.max(balance.appliedForce, 1e-300))} % of the applied ${number(balance.appliedForce)}) and moment ${number(balance.residualMoment)} (${number((100 * balance.residualMoment) / Math.max(balance.appliedMoment, 1e-300))} % of ${number(balance.appliedMoment)}), above ${RELIEF_TOLERANCE * 100} % (computed from the loads, a force acting at the mean of its target points)`,
          [analysis.id],
        ),
      );
  for (const reason of relief.unassessed)
    items.push(item('FLL_RELIEF_UNASSESSED', 'warning', `the relief balance was not assessed: ${reason}`, [analysis.id]));
  if (solved !== undefined && solved !== null) appendAll(items, solvedReliefItems(doc, analysis, relief, solved));
  return items;
}
