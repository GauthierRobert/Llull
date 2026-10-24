/**
 * `RTE_VALVE_OPERATOR_CLASH` (02 RTE §5.8, V1): the operator envelope of a valve (handwheel disc, gear box, actuator; `operator.ts`) against the other
 * bodies of the model, found with the `check_clashes` boxes: every pipe part and insulation envelope of every run, and the building solids (steel,
 * equipment, walls ...). Bodies of the valve's own run never count, nor do runs attached to it or the equipment it is connected to.
 */

import type { CadDocument } from '@core/model/types';
import { accessoryClashes } from '../../industrial/clash/clashPlant';
import { pipingClashBodies } from './clashBodies';
import type { RunDerivation } from './deriveTypes';

export interface OperatorClashFinding {
  /** Id of the valve (the inline component id `check_piping` uses for RTE_VALVE_OPERATOR_HEIGHT). */
  readonly valveId: string;
  readonly valvePartId: string;
  readonly runId: string;
  readonly operatorBody: string;
  readonly operatorKind: string;
  /** The other body: a part id of a run, or a building element id. */
  readonly other: string;
  readonly kind: 'hard' | 'insulation';
  readonly depthMm: number;
}

/**
 * The operator clashes of the valves in `derived` (run id -> derivation), deeper than `toleranceMm`.
 * @invariant none in a non-mm document (the clash bodies are mm), none without an operator envelope; one finding per (operator body, other body)
 */
export function operatorClashFindings(
  doc: CadDocument,
  derived: ReadonlyMap<string, RunDerivation>,
  toleranceMm: number,
): OperatorClashFinding[] {
  const bodies = pipingClashBodies(doc);
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const valves = new Map<string, { valveId: string; runId: string; kind: string }>();
  for (const [runId, derivation] of derived)
    for (const placed of derivation.inline)
      if (placed.operator !== undefined) valves.set(placed.valvePartId, { valveId: placed.id, runId, kind: placed.operator.kind });
  const findings: OperatorClashFinding[] = [];
  for (const clash of accessoryClashes(doc, bodies, toleranceMm)) {
    const operatorIsA = byId.get(clash.a)?.accessoryOf !== undefined;
    const [operatorBody, other] = operatorIsA ? [clash.a, clash.b] : [clash.b, clash.a];
    const valvePartId = byId.get(operatorBody)?.accessoryOf;
    const valve = valvePartId === undefined ? undefined : valves.get(valvePartId);
    if (valvePartId === undefined || valve === undefined) continue;
    findings.push({ ...valve, valvePartId, operatorBody, operatorKind: valve.kind, other, kind: clash.kind, depthMm: clash.depth });
  }
  return findings.sort((x, y) => (x.operatorBody < y.operatorBody ? -1 : x.operatorBody > y.operatorBody ? 1 : x.other < y.other ? -1 : 1));
}
