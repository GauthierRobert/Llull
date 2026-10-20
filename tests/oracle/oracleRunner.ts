/**
 * Oracle suite runner (SC-Q1): replays a case's `plan.json` through `execute`, measures the result with the query commands
 * (`mass_properties`, `measure_bounding_box`; never kernel internals) and compares it with the analytic `expected.json`.
 * Shared by the in-process Manifold test (tests/oracle) and the native OCCT test (server/tests).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument, is3D } from '@core/model/types';

export type OracleKernel = 'manifold' | 'occt';
type Vec3 = readonly [number, number, number];

interface OracleTolerance {
  readonly volume: number;
  readonly area: number;
  readonly centroid: number;
  readonly bbox: number;
}

interface OracleExpected {
  readonly id: string;
  readonly family: string;
  readonly description: string;
  readonly source: string;
  readonly formula: string;
  readonly kernels: readonly OracleKernel[];
  readonly bodies: number;
  readonly volume: number;
  readonly area: number | null;
  readonly centroid: Vec3 | null;
  readonly bbox: { readonly min: Vec3; readonly max: Vec3 } | null;
  readonly faces?: number;
  readonly tolerance: OracleTolerance;
  /** Wider relative tolerances for the mesh kernel (tessellated curved surfaces), with the reason. */
  readonly meshTolerance?: { readonly volume: number | null; readonly area: number | null; readonly reason: string };
  readonly stepRoundTrip?: boolean;
  /** Bodies after the STEP round trip when it differs from `bodies`: import makes one entity per solid of a compound. */
  readonly stepBodies?: number;
  /** A real defect the suite found: the listed fields (volume, area, bbox, centroid, bodies) are expected to be wrong on those kernels. */
  readonly knownFailure?: {
    readonly fields: readonly string[];
    readonly kernels?: readonly OracleKernel[];
    readonly measured: unknown;
    readonly diagnosis: string;
  };
}

export interface OracleCase {
  readonly id: string;
  readonly actions: readonly unknown[];
  readonly expected: OracleExpected;
}

interface Measured {
  readonly bodies: number;
  readonly volume: number;
  readonly area: number | null;
  readonly centroid: Vec3;
  readonly bbox: { readonly min: Vec3; readonly max: Vec3 };
  readonly methods: readonly string[];
}

export interface CaseResult {
  readonly id: string;
  readonly family: string;
  readonly source: string;
  readonly kernel: OracleKernel;
  readonly status: 'pass' | 'fail' | 'known-failure' | 'skipped';
  readonly volumeExpected: number;
  readonly volumeMeasured: number | null;
  readonly volumeRelError: number | null;
  readonly stepRoundTrip: 'pass' | 'fail' | 'n/a';
  readonly failures: readonly string[];
}

const ORACLE_DIR = __dirname;

export function loadCases(): OracleCase[] {
  return readdirSync(ORACLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{2,3}-/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((id) => {
      const read = (file: string): unknown => JSON.parse(readFileSync(path.join(ORACLE_DIR, id, file), 'utf8'));
      return { id, actions: (read('plan.json') as { actions: unknown[] }).actions, expected: read('expected.json') as OracleExpected };
    });
}

/** Replays the plan with `build_project`; throws when a step fails (a broken plan is a harness error, not a measurement). */
function buildPlan(actions: readonly unknown[]): CadDocument {
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  const steps = (result.data as { steps?: { index: number; command: string; ok: boolean; summary: string }[] } | undefined)?.steps ?? [];
  const failed = steps.filter((step) => !step.ok).map((step) => `#${step.index} ${step.command}: ${step.summary}`);
  if (failed.length > 0) throw new Error(`plan failed: ${failed.join(' | ')}`);
  return result.document;
}

const dataOf = (doc: CadDocument, command: string, params: Record<string, unknown>): Record<string, unknown> | null => {
  const result = execute(doc, command, params);
  return (result.data as Record<string, unknown> | undefined) ?? null;
};

/** Volume, area, centroid and bbox of all 3D bodies of `doc`, measured with the query commands only. */
function measureDocument(doc: CadDocument): Measured {
  const ids = doc.order.filter((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && is3D(entity);
  });
  let volume = 0;
  let area: number | null = 0;
  const moment: [number, number, number] = [0, 0, 0];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const methods = new Set<string>();
  for (const entityId of ids) {
    const mass = dataOf(doc, 'mass_properties', { entityId });
    const box = dataOf(doc, 'measure_bounding_box', { entityId });
    if (mass === null || box === null) throw new Error(`no measurement for ${entityId}`);
    const v = mass['volume'] as number;
    const c = mass['centroid'] as Vec3;
    volume += v;
    for (let i = 0; i < 3; i++) moment[i] = (moment[i] ?? 0) + v * (c[i] ?? 0);
    const a = mass['area'];
    area = area !== null && typeof a === 'number' ? area + a : null;
    if (typeof mass['method'] === 'string') methods.add(mass['method']);
    const lo = box['min'] as Vec3;
    const hi = box['max'] as Vec3;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] ?? Infinity, lo[i] ?? Infinity);
      max[i] = Math.max(max[i] ?? -Infinity, hi[i] ?? -Infinity);
    }
  }
  return {
    bodies: ids.length,
    volume,
    area,
    centroid: [moment[0] / volume, moment[1] / volume, moment[2] / volume],
    bbox: { min, max },
    methods: [...methods],
  };
}

const rel = (measured: number, expected: number): number => Math.abs(measured - expected) / Math.max(Math.abs(expected), 1e-12);

/** The tolerances that apply to `kernel` (mesh kernels get the case's recorded envelope). */
function tolerancesFor(expected: OracleExpected, kernel: OracleKernel): OracleTolerance {
  const base = expected.tolerance;
  if (kernel !== 'manifold' || expected.meshTolerance === undefined) return base;
  const volume = expected.meshTolerance.volume ?? base.volume;
  const area = expected.meshTolerance.area ?? base.area;
  return { volume, area, centroid: Math.max(base.centroid, volume), bbox: Math.max(base.bbox, volume) };
}

/** Differences between the measurement and the expectation; empty when the case passes. */
function compare(expected: OracleExpected, measured: Measured, kernel: OracleKernel): string[] {
  const tol = tolerancesFor(expected, kernel);
  const problems: string[] = [];
  if (measured.bodies !== expected.bodies) problems.push(`bodies ${measured.bodies} != ${expected.bodies}`);
  const volumeError = rel(measured.volume, expected.volume);
  if (volumeError > tol.volume)
    problems.push(`volume ${measured.volume} vs ${expected.volume} (rel ${volumeError.toExponential(2)} > ${tol.volume})`);
  if (expected.area !== null) {
    if (measured.area === null) problems.push('area not reported by mass_properties');
    else if (rel(measured.area, expected.area) > tol.area)
      problems.push(`area ${measured.area} vs ${expected.area} (rel ${rel(measured.area, expected.area).toExponential(2)} > ${tol.area})`);
  }
  if (expected.bbox !== null) {
    const size = [0, 1, 2].map((i) => (expected.bbox?.max[i] ?? 0) - (expected.bbox?.min[i] ?? 0));
    for (let i = 0; i < 3; i++) {
      const lo = Math.abs((measured.bbox.min[i] ?? 0) - (expected.bbox.min[i] ?? 0));
      const hi = Math.abs((measured.bbox.max[i] ?? 0) - (expected.bbox.max[i] ?? 0));
      if (lo > tol.bbox * (size[i] ?? 1) || hi > tol.bbox * (size[i] ?? 1))
        problems.push(
          `bbox axis ${i}: [${measured.bbox.min[i]}, ${measured.bbox.max[i]}] vs [${expected.bbox.min[i]}, ${expected.bbox.max[i]}]`,
        );
    }
    if (expected.centroid !== null) {
      const extent = Math.max(...size);
      for (let i = 0; i < 3; i++)
        if (Math.abs((measured.centroid[i] ?? 0) - (expected.centroid[i] ?? 0)) > tol.centroid * extent)
          problems.push(`centroid axis ${i}: ${measured.centroid[i]} vs ${expected.centroid[i]} (abs tol ${tol.centroid * extent})`);
    }
  }
  return problems;
}

/** Exports every solid with `export_step_exact`, re-imports it into an empty document with `import_step_exact` and returns that document. */
function stepRoundTrip(doc: CadDocument): CadDocument {
  const exported = dataOf(doc, 'export_step_exact', {});
  const step = exported?.['step'];
  if (typeof step !== 'string') throw new Error('export_step_exact produced no STEP text');
  const imported = execute(createEmptyDocument(), 'import_step_exact', { text: step });
  if (imported.affected.length === 0) throw new Error(`import_step_exact failed: ${imported.summary}`);
  return imported.document;
}

/** Face count by `inspect_topology` (exact kernels only); null when the kernel reports no topology. */
function faceCount(doc: CadDocument): number | null {
  const id = doc.order[0];
  if (id === undefined) return null;
  const data = dataOf(doc, 'inspect_topology', { id });
  const faces = data?.['faces'];
  if (Array.isArray(faces)) return faces.length;
  return typeof data?.['faceCount'] === 'number' ? data['faceCount'] : null;
}

/** Runs one case on `kernel` (installed by the caller) and returns the report row. */
export function runCase(oracle: OracleCase, kernel: OracleKernel, options: { stepRoundTrip: boolean }): CaseResult {
  const { expected } = oracle;
  const row = { id: oracle.id, family: expected.family, source: expected.source, kernel, volumeExpected: expected.volume };
  if (!expected.kernels.includes(kernel))
    return {
      ...row,
      status: 'skipped',
      volumeMeasured: null,
      volumeRelError: null,
      stepRoundTrip: 'n/a',
      failures: [`needs ${expected.kernels.join('/')}`],
    };
  const failures: string[] = [];
  let measured: Measured | null = null;
  let roundTrip: CaseResult['stepRoundTrip'] = 'n/a';
  try {
    const doc = buildPlan(oracle.actions);
    measured = measureDocument(doc);
    failures.push(...compare(expected, measured, kernel));
    if (expected.faces !== undefined && kernel === 'occt') {
      const faces = faceCount(doc);
      if (faces !== null && faces !== expected.faces) failures.push(`faces ${faces} != ${expected.faces}`);
    }
    if (options.stepRoundTrip && expected.stepRoundTrip !== false) {
      const back = measureDocument(stepRoundTrip(doc));
      const stepProblems = compare({ ...expected, bodies: expected.stepBodies ?? expected.bodies }, back, kernel);
      roundTrip = stepProblems.length === 0 ? 'pass' : 'fail';
      failures.push(...stepProblems.map((problem) => `after STEP round trip: ${problem}`));
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const known =
    expected.knownFailure !== undefined && (expected.knownFailure.kernels ?? ['manifold', 'occt']).includes(kernel)
      ? expected.knownFailure.fields
      : [];
  const fieldOf = (problem: string): string => problem.replace(/^after STEP round trip: /, '').split(' ')[0] ?? problem;
  const unexpected = failures.filter((problem) => !known.includes(fieldOf(problem)));
  for (const field of known) {
    if (failures.some((problem) => fieldOf(problem) === field)) continue;
    const message = `known failure no longer fails (remove it from expected.json): ${field}`;
    unexpected.push(message);
    failures.push(message);
  }
  const status = unexpected.length > 0 ? 'fail' : known.length > 0 ? 'known-failure' : 'pass';
  return {
    ...row,
    status,
    volumeMeasured: measured?.volume ?? null,
    volumeRelError: measured === null ? null : rel(measured.volume, expected.volume),
    stepRoundTrip: roundTrip,
    failures,
  };
}

/** Appends this kernel's rows to the file named by `ORACLE_RESULTS_DIR` (scripts/oracle.mjs reads them to write docs/ORACLE.md). */
export function saveResults(kernel: OracleKernel, kernelName: string, rows: readonly CaseResult[]): void {
  const dir = process.env['ORACLE_RESULTS_DIR'];
  if (dir === undefined || dir === '') return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${kernel}.json`), `${JSON.stringify({ kernel, kernelName, rows }, null, 2)}\n`);
}
