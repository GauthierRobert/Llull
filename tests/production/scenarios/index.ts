import type { Scenario } from '../contract';
import { civilSite } from './civilSite';
import { extractionBuilding } from './extractionBuilding';
import { extractionRevision } from './extractionRevision';
import { pipeRack } from './pipeRack';

/**
 * @layer tests/production/scenarios
 *
 * Every production scenario, in run order (a scenario's `startsFrom` comes before it).
 */
export const SCENARIOS: readonly Scenario[] = [
  extractionBuilding,
  extractionRevision,
  pipeRack,
  civilSite,
];

export function scenarioById(id: string): Scenario {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`unknown production scenario ${id}`);
  return scenario;
}

/** The scenario chain to run from an empty document: [..., startsFrom, scenario]. */
export function chainOf(scenario: Scenario): Scenario[] {
  return scenario.startsFrom === undefined
    ? [scenario]
    : [...chainOf(scenarioById(scenario.startsFrom)), scenario];
}
