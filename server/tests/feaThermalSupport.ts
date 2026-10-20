/** Shared harness of the thermal FE benchmark suites: a temp document driven through the `llull` CLI (plan -> fea_mesh -> fea_solve -> thermal_report). */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { judgeCase, type Measured } from '@core/commands/vnv/judge';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { isRecord } from '@lib/isRecord';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { FEA_TOOL_ENV } from './feaTestSupport';

export type PlanStep = { readonly command: string; readonly params: Record<string, unknown>; readonly as?: string };

const PACK = '03-thermal-analysis';
const FIXTURES = path.resolve(__dirname, 'fixtures/thermal');
const EXPECTED = path.resolve(__dirname, `../../docs/physics/${PACK}/validation/expected_results.json`);

export const loadPlan = (name: string): PlanStep[] =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.plan.json`), 'utf8')) as PlanStep[];

/** Plan step edit: replaces the params of every step whose command (and optional param `name`) matches. */
export function editStep(plan: PlanStep[], command: string, patch: Record<string, unknown>, name?: string): PlanStep[] {
  return plan.map((step) =>
    step.command === command && (name === undefined || step.params['name'] === name)
      ? { ...step, params: { ...step.params, ...patch } }
      : step,
  );
}

export interface Result {
  readonly code: number;
  readonly json: Record<string, unknown>;
}

export const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});
export const listOf = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function io(out: string[]): CliIo {
  return {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: { ...FEA_TOOL_ENV },
    prepareKernel: () => Promise.resolve(),
  };
}

/** One analysis document in a temp dir. */
export class ThermalCase {
  readonly docPath: string;
  analysisId = '';
  constructor(readonly dir: string) {
    this.docPath = path.join(dir, 'case.llull.json');
  }

  async cli(...argv: string[]): Promise<Result> {
    const out: string[] = [];
    const code = await runCli([...argv, '--doc', this.docPath, '--json'], io(out));
    const parsed: unknown = JSON.parse(out.join('') || '{}');
    return { code, json: isRecord(parsed) ? parsed : {} };
  }

  document(): ReturnType<typeof deserializeDocument> {
    return deserializeDocument(readFileSync(this.docPath, 'utf8'));
  }

  async runPlan(plan: readonly PlanStep[]): Promise<Result> {
    const planPath = path.join(this.dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(plan));
    rmSync(this.docPath, { force: true });
    const result = await this.cli('run', planPath);
    if (result.code === EXIT_OK) this.analysisId = Object.keys(this.document().analysis?.cases ?? {})[0] ?? '';
    return result;
  }

  /** Last [timeS, value] of the named probe in a thermal_report `data`. */
  probe(report: Record<string, unknown>, name: string): readonly [number, number] {
    const probes = this.document().analysis?.cases[this.analysisId]?.probes ?? {};
    const id = Object.keys(probes).find((key) => probes[key]?.name === name);
    const series = listOf(report['probes']).find((entry) => entry['probeId'] === id)?.['series'];
    const last = Array.isArray(series) ? (series.at(-1) as unknown) : undefined;
    if (!Array.isArray(last) || typeof last[0] !== 'number' || typeof last[1] !== 'number')
      throw new Error(`no probe '${name}' in the report`);
    return [last[0], last[1]];
  }

  /** Flow (W, positive into the part) of the BC with this display name. */
  flow(report: Record<string, unknown>, name: string): number {
    const bcs = this.document().analysis?.cases[this.analysisId]?.thermal?.bcs ?? {};
    const id = Object.keys(bcs).find((key) => bcs[key]?.name === name);
    const value = listOf(report['bcHeatFlows']).find((entry) => entry['bcId'] === id)?.['valueW'];
    if (typeof value !== 'number') throw new Error(`no flow for BC '${name}'`);
    return value;
  }

  /** fea_mesh + fea_solve + thermal_report; every step must succeed. */
  async solve(timeoutS = 300): Promise<Record<string, unknown>> {
    const meshed = await this.cli('fea_mesh', `analysisId=${this.analysisId}`, `timeoutS=${timeoutS}`);
    expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
    const solved = await this.cli('fea_solve', `analysisId=${this.analysisId}`, `timeoutS=${timeoutS}`);
    expect(solved.code, String(solved.json['summary'])).toBe(EXIT_OK);
    const report = await this.cli('thermal_report', `analysisId=${this.analysisId}`);
    expect(report.code, String(report.json['summary'])).toBe(EXIT_OK);
    return dataOf(report.json);
  }
}

export async function openCase(prefix: string): Promise<ThermalCase> {
  setGeometryKernel(await createManifoldKernel());
  const dir = mkdtempSync(path.join(tmpdir(), `llull-thermal-${prefix}-`));
  process.env['LLULL_FEA_CACHE'] = path.join(dir, 'cache');
  return new ThermalCase(dir);
}

export function closeCase(opened: ThermalCase | undefined): void {
  setGeometryKernel(null);
  if (opened !== undefined) rmSync(opened.dir, { recursive: true, force: true });
}

/** Judge a measurement against the pack's case with the PHY-00 judge; records it for `npm run quality:physics` when asked. */
export function expectCase(caseId: string, value: number, unit?: string): void {
  const file = JSON.parse(readFileSync(EXPECTED, 'utf8')) as { cases: ({ id: string; unit: string } & Record<string, unknown>)[] };
  const expected = file.cases.find((entry) => entry.id === caseId);
  if (expected === undefined) throw new Error(`no case ${caseId} in ${PACK}`);
  const measured: Measured = { value, unit: unit ?? expected.unit };
  const target = process.env['LLULL_PHYSICS_MEASUREMENTS'];
  if (target !== undefined && target !== '') appendFileSync(target, `${JSON.stringify({ pack: PACK, caseId, measured })}\n`);
  const judgement = judgeCase(expected, measured);
  expect(judgement.verdict, `${caseId}: ${judgement.message} (measured ${value})`).toBe('pass');
}

export { EXIT_OK };
