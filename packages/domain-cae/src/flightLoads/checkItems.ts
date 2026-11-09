/** check_analysis items of the 14 FLL lane: stale flight run, unsupported inertial loads, unbalanced inertial relief. */

import type { AnalysisCase } from '@core/model/analysis';
import type { MassContext } from '@core/geometry/resolveMassProperties';
import type { CadDocument } from '@core/model/types';
import { fllRemediation } from './codes';
import { flightDesignHash } from './designHash';
import { reliefAssessment, RELIEF_TOLERANCE } from './rigidBalance';

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

/**
 * FLL_INERTIAL_UNSUPPORTED (error): an inertial load in a non-static analysis; FLL_RUN_STALE (error): a flight load whose recorded design hash differs from the
 * current one; FLL_RELIEF_RESIDUAL (error): a load case of a free-body analysis whose net force or moment on the rigid body exceeds 1e-4 of the applied load
 * (the 3-2-1 reactions would equal it); FLL_RELIEF_UNASSESSED (warning): loads or mass the balance could not use.
 * @invariant empty for an analysis with no inertial / flight load and no free-body support
 */
export function flightLoadItems(doc: CadDocument, analysis: AnalysisCase, ctx?: MassContext): FlightLoadItem[] {
  const items: FlightLoadItem[] = [];
  const loads = analysis.loadOrder.flatMap((id) => analysis.loads[id] ?? []);
  const inertial = loads.filter((load) => load.kind === 'inertial');
  if (inertial.length > 0 && analysis.type !== 'static')
    items.push(
      item(
        'FLL_INERTIAL_UNSUPPORTED',
        'error',
        `inertial load(s) ${inertial.map((load) => `'${load.id}'`).join(', ')} in a ${analysis.type} analysis: only static decks apply them`,
        inertial.map((load) => load.id),
      ),
    );
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
  return items;
}
