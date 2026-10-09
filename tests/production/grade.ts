import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type {
  CheckReport,
  DeliverableId,
  DriverId,
  GradeContext,
  Scenario,
  ScenarioReport,
} from './contract';

/**
 * @layer tests/production
 *
 * Grades a driver's final document against a scenario's acceptance criteria, then applies the
 * known-issue ratchet. Deliverables the driver downloaded (UI) are graded as downloaded; the rest
 * are produced from the final document with the same export commands an engineer would run.
 */

/** Deliverable id → the command that issues it and the field of `data` that holds the file. */
function produce(doc: CadDocument, id: DeliverableId): string {
  const [kind, arg = ''] = id.split(':');
  const fromData = (tool: string, args: Record<string, unknown>, field: string): string => {
    const result = execute(doc, tool, args);
    const data = result.data as Record<string, unknown> | undefined;
    const text = data?.[field];
    return typeof text === 'string' ? text : '';
  };
  switch (kind) {
    case 'ifc':
      return fromData('export_ifc', {}, 'ifc');
    case 'dxf':
      return fromData('export_dxf', { levelId: arg }, 'dxf');
    case 'plan':
      return fromData('export_plan_sheet', { levelId: arg }, 'svg');
    case 'elevation':
      return fromData('export_elevation_sheet', { direction: arg }, 'svg');
    case 'schedule':
      return fromData('building_schedule', { kind: arg }, 'csv');
    case 'takeoff':
      return JSON.stringify(execute(doc, 'quantity_takeoff', {}).data ?? {});
    case 'landxml':
      return fromData('export_landxml', {}, 'text');
    case 'plan-profile': {
      const [, alignmentId = '', paper = 'A3'] = id.split(':');
      return fromData('export_plan_profile_sheet', { alignmentId, paper }, 'text');
    }
    case 'save':
      return serializeDocument(doc);
    default:
      throw new Error(`unknown deliverable ${id}`);
  }
}

export function gradeContext(
  document: CadDocument,
  baseline: CadDocument = createEmptyDocument(),
  provided: Readonly<Record<DeliverableId, string>> = {},
): GradeContext {
  const cache = new Map<string, string>();
  const memo = (key: string, make: () => string): string => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const made = make();
    cache.set(key, made);
    return made;
  };
  return {
    document,
    baseline,
    run: (tool, args = {}): CommandResult => execute(document, tool, args),
    deliverable: (id) => provided[id] ?? memo(`final:${id}`, () => produce(document, id)),
    baselineDeliverable: (id) => memo(`baseline:${id}`, () => produce(baseline, id)),
  };
}

export function gradeScenario(
  scenario: Scenario,
  driver: DriverId,
  context: GradeContext,
): ScenarioReport {
  const known = new Set(scenario.knownIssues[driver] ?? []);
  const checks: CheckReport[] = scenario.criteria.map((criterion) => {
    let outcome;
    try {
      outcome = criterion.check(context);
    } catch (error) {
      outcome = { pass: false, detail: `criterion threw: ${(error as Error).message}` };
    }
    return {
      id: criterion.id,
      area: criterion.area,
      requirement: criterion.requirement,
      known: known.has(criterion.id),
      ...outcome,
    };
  });
  const unknownKnown = [...known].filter((id) => !checks.some((check) => check.id === id));
  if (unknownKnown.length > 0) {
    throw new Error(`${scenario.id}: knownIssues name no criterion: ${unknownKnown.join(', ')}`);
  }
  return {
    scenario: scenario.id,
    title: scenario.title,
    driver,
    checks,
    passed: checks.filter((check) => check.pass).length,
    total: checks.length,
    regressions: checks.filter((check) => !check.pass && !check.known).map((check) => check.id),
    fixed: checks.filter((check) => check.pass && check.known).map((check) => check.id),
  };
}
