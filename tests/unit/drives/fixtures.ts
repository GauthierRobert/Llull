/** Shared fixtures of the PHY-23 drive tests: the maxon RE 40 148877 sheet, a plan runner and the analytic reference file. */
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { SimulationData } from '@dynamics/sim/simulationReport';

const VALIDATION = 'docs/physics/23-drives-physical-truth/validation';

const referenceFile = JSON.parse(readFileSync(`${VALIDATION}/drv_reference.json`, 'utf8')) as Record<string, unknown>;

/** One section of drv_reference.json, typed by the caller. */
export const section = <T>(name: string): T => referenceFile[name] as T;
export const expectedResults = JSON.parse(readFileSync(`${VALIDATION}/expected_results.json`, 'utf8')) as {
  cases: { id: string; value: number; tolerance: Record<string, number> }[];
};

/** maxon RE 40 148877 (48 V), the full catalogue sheet in SI units. */
export const MAXON_SHEET = {
  nominalVoltageV: 48,
  terminalResistanceOhm: 1.13,
  terminalInductanceH: 0.00033,
  torqueConstantNmPerA: 0.0603,
  rotorInertiaKgM2: 0.0000137,
  noLoadCurrentA: 0.0686,
  nominalCurrentA: 3.17,
  stallTorqueNm: 2.56,
  stallCurrentA: 42.4,
  noLoadSpeedRpm: 7590,
  speedConstantRpmPerV: 158,
  speedTorqueGradientRpmPerMNm: 2.97,
  mechanicalTimeConstantS: 0.00428,
  maxSpeedRpm: 12000,
};

export const MAXON_SOURCE = { name: 'maxon RE 40 148877, catalogue page CN-141 (2020-06)', grade: 'A' };

interface PlanStep {
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly as?: string;
}

/** Run `steps` in order; "$name" strings are replaced by the first affected id of the step declared `as: name`. Throws on the first refused step. */
export function runSteps(
  steps: readonly PlanStep[],
  start: CadDocument = createEmptyDocument(),
): { doc: CadDocument; last: ReturnType<typeof execute> } {
  const ids = new Map<string, string>();
  const substitute = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith('$')) return ids.get(value.slice(1)) ?? value;
    if (Array.isArray(value)) return value.map(substitute);
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
    return value;
  };
  let doc = start;
  let last = execute(doc, 'set_units', { units: 'mm' });
  for (const step of steps) {
    last = execute(doc, step.command, substitute(step.params) as Record<string, unknown>);
    if (last.document === doc && last.affected.length === 0 && /no-op|rejected/.test(last.summary)) throw new Error(last.summary);
    doc = last.document;
    if (step.as !== undefined) ids.set(step.as, last.affected[0] ?? '');
  }
  return { doc, last };
}

export const loadPlan = (name: string): PlanStep[] =>
  JSON.parse(readFileSync(`${VALIDATION}/plans/${name}.plan.json`, 'utf8')) as PlanStep[];

export interface DriveSeriesData {
  times: number[];
  voltageV: number[];
  currentA: number[];
  shaftTorqueNm: number[];
  jointTorqueNm: number[];
  shaftSpeedRpm: number[];
  electricalPowerW: number[];
  mechanicalPowerW: number[];
  limited: number[];
}

interface DriveRow {
  currentA: number;
  voltageV: number;
  jointTorqueNm: number;
  shaftSpeedRpm: number;
  electricalPowerW: number;
}

interface DriveData {
  joint: string;
  mode: string;
  verified: boolean;
  sourceGrade: string;
  limitedSamples: number;
  peak: DriveRow;
  final: DriveRow;
  tracking: { unit: string; rmsError: number; peakError: number; range: number };
  series: DriveSeriesData;
}

/** simulate_motion data of a run with datasheet motors (motors "m" or "m_re40"). */
export interface RunData extends SimulationData {
  drives: Record<'m' | 'm_re40', DriveData>;
  ledger: { entries: { element: string; kind: string; joules: number }[]; closureRelative: number; closure: string };
}

export const dataOf = (result: ReturnType<typeof execute>): RunData => result.data as RunData;

/** Element `k` of a series (NaN outside it). */
export const at = (values: readonly number[], k: number): number => values[k] ?? Number.NaN;

/** A 5 mm hub rotor of negligible mass on a revolute joint about Z, no gravity: the "rotor only" bench of the datasheet motor. */
export function rotorBench(extra: PlanStep[] = []): CadDocument {
  return runSteps([
    { command: 'add_cylinder', params: { radius: 5, height: 5, position: [0, 0, 0], axis: [0, 0, 1] }, as: 'hub' },
    { command: 'add_rigid_body', params: { entityIds: ['$hub'], id: 'rotor', massKg: 0.000001 } },
    {
      command: 'add_body_joint',
      params: { kind: 'revolute', child: 'rotor', parent: 'ground', anchor: [0, 0, 0], axis: [0, 0, 1], id: 'j_shaft' },
    },
    { command: 'set_gravity', params: { gravity: [0, 0, 0] } },
    ...extra,
  ]).doc;
}

/** A datasheet with a negligible rotor: the electrical side of an ideal torque source. */
export const IDEAL_SHEET = { nominalVoltageV: 48, terminalResistanceOhm: 1.13, torqueConstantNmPerA: 0.0603, rotorInertiaKgM2: 1e-9 };

/**
 * A disc of axial inertia `inertia` kg*m^2 on revolute joint "j" about Z (no gravity) with datasheet motor "m" on it (and optional steps after:
 * profiles, drive). The inertia is the whole load: the body's own geometry is irrelevant.
 */
export function inertiaBench(
  inertia: number,
  motor: { sheet?: Record<string, unknown>; gearhead?: Record<string, unknown> } = {},
  after: PlanStep[] = [],
): CadDocument {
  return runSteps([
    { command: 'add_cylinder', params: { radius: 50, height: 10, position: [0, 0, 0], axis: [0, 0, 1] }, as: 'disc' },
    {
      command: 'add_rigid_body',
      params: { entityIds: ['$disc'], id: 'load', massKg: 1, inertiaKgM2: [inertia / 2, inertia / 2, inertia, 0, 0, 0] },
    },
    {
      command: 'add_body_joint',
      params: { kind: 'revolute', child: 'load', parent: 'ground', anchor: [0, 0, 0], axis: [0, 0, 1], id: 'j' },
    },
    { command: 'set_gravity', params: { gravity: [0, 0, 0] } },
    {
      command: 'add_motor',
      params: {
        joint: 'j',
        kind: 'dc',
        id: 'm',
        datasheet: motor.sheet ?? IDEAL_SHEET,
        source: MAXON_SOURCE,
        ...(motor.gearhead === undefined ? {} : { gearhead: motor.gearhead }),
      },
    },
    ...after,
  ]).doc;
}

export const simulate = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'simulate_motion', params);

export const RPM = 60 / (2 * Math.PI);

/** Steps for a disc of axial inertia `inertia` kg*m^2 on a revolute joint `j_<id>` about Z at `anchor` (mm), body `b_<id>`. */
export function spinner(id: string, inertia: number, anchor: [number, number, number] = [0, 0, 0]): PlanStep[] {
  return [
    { command: 'add_cylinder', params: { radius: 50, height: 10, position: anchor, axis: [0, 0, 1] }, as: `geo_${id}` },
    {
      command: 'add_rigid_body',
      params: { entityIds: [`$geo_${id}`], id: `b_${id}`, massKg: 1, inertiaKgM2: [inertia / 2, inertia / 2, inertia, 0, 0, 0] },
    },
    { command: 'add_body_joint', params: { kind: 'revolute', child: `b_${id}`, parent: 'ground', anchor, axis: [0, 0, 1], id: `j_${id}` } },
  ];
}

/** A mass `kg` on a prismatic joint `j_<id>` along X (body `b_<id>`). */
export function slider(id: string, kg: number, parent = 'ground'): PlanStep[] {
  return [
    { command: 'add_box', params: { size: [20, 20, 20], position: [0, 0, 10], anchor: 'center' }, as: `geo_${id}` },
    { command: 'add_rigid_body', params: { entityIds: [`$geo_${id}`], id: `b_${id}`, massKg: kg } },
    {
      command: 'add_body_joint',
      params: { kind: 'prismatic', child: `b_${id}`, parent, anchor: [0, 0, 10], axis: [1, 0, 0], id: `j_${id}` },
    },
  ];
}

export const noGravity: PlanStep = { command: 'set_gravity', params: { gravity: [0, 0, 0] } };

/** The simulate_motion series `key` of `joint` (empty when absent). */
export const seriesOf = (result: ReturnType<typeof execute>, key: string, joint: string): number[] =>
  ((result.data as { series?: Record<string, Record<string, number[]>> }).series?.[key] ?? {})[joint] ?? [];

export const SOURCE_A = { name: 'PHY-23 validation (synthetic)', grade: 'A' };
