/**
 * Shared harness of the PHY-04 FE benchmark suites: run a plan through the `llull` CLI on a temp document, mesh and solve it with the real
 * Netgen (llull-mesh) + CalculiX, read probes, and judge a measurement against the pack's `expected_results.json` (recorded for `quality:physics`).
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { judgeCase, type Measured } from '@cae/vnv/judge';
import type { JsonValue } from '@cae/vnv/expected';
import { isRecord } from '@lib/isRecord';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { FEA_TOOL_ENV } from './feaTestSupport';

export const PACK = '04-thermo-mechanical';
const PACK_FILE = path.resolve(__dirname, `../../docs/physics/${PACK}/validation/expected_results.json`);
const PLAN_DIR = path.resolve(__dirname, 'fixtures/thermomech');

type RawCase = { readonly id: string } & Record<string, unknown>;
const cases = new Map((JSON.parse(readFileSync(PACK_FILE, 'utf8')) as { cases: RawCase[] }).cases.map((c) => [c.id, c]));

/** The PHY-00 judge must pass `value` for `caseId`; the measurement is appended to `LLULL_PHYSICS_MEASUREMENTS` when set. */
export function expectCase(caseId: string, value: JsonValue, unit?: string): void {
  const expected = cases.get(caseId);
  if (expected === undefined) throw new Error(`no case ${caseId} in ${PACK}`);
  const measured: Measured = { value, unit: unit ?? String(expected['unit']) };
  const target = process.env['LLULL_PHYSICS_MEASUREMENTS'];
  if (target !== undefined && target !== '') appendFileSync(target, `${JSON.stringify({ pack: PACK, caseId, measured })}\n`);
  const judgement = judgeCase(expected, measured);
  expect(judgement.verdict, `${caseId}: measured ${JSON.stringify(value)} — ${judgement.message}`).toBe('pass');
}

export const planPath = (name: string): string => path.join(PLAN_DIR, `${name}.plan.json`);

export const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});

export interface CliResult {
  readonly code: number;
  readonly json: Record<string, unknown>;
}

/** One document in a temp directory; commands run through `runCli` against it. */
export class Session {
  constructor(
    readonly dir: string,
    readonly docPath: string,
  ) {}

  async cli(...argv: string[]): Promise<CliResult> {
    const out: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
      readStdin: () => Promise.resolve(''),
      env: { ...FEA_TOOL_ENV },
      prepareKernel: () => Promise.resolve(),
    };
    const code = await runCli([...argv, '--doc', this.docPath, '--json'], io);
    const parsed: unknown = JSON.parse(out.join('') || '{}');
    return { code, json: isRecord(parsed) ? parsed : {} };
  }

  /** Run a plan file; returns the alias map of the run (alias -> ids). */
  async run(plan: string): Promise<Record<string, string[]>> {
    const { code, json } = await this.cli('run', plan);
    expect(code, String(json['summary'])).toBe(EXIT_OK);
    const aliases = dataOf(json)['aliases'];
    const found: Record<string, string[]> = {};
    if (isRecord(aliases)) for (const [alias, ids] of Object.entries(aliases)) found[alias] = Array.isArray(ids) ? ids.map(String) : [];
    return found;
  }

  /** The first id of an alias (the run must have bound it). */
  async idOf(plan: string, alias: string): Promise<string> {
    const id = (await this.run(plan))[alias]?.[0];
    if (id === undefined) throw new Error(`plan ${plan} bound no alias '${alias}'`);
    return id;
  }

  async mesh(analysisId: string): Promise<string> {
    const { code, json } = await this.cli('fea_mesh', `analysisId=${analysisId}`);
    expect(code, String(json['summary'])).toBe(EXIT_OK);
    return String(dataOf(json)['meshHash']);
  }

  async solve(analysisId: string): Promise<string> {
    const { code, json } = await this.cli('fea_solve', `analysisId=${analysisId}`, 'timeoutS=300');
    expect(code, String(json['summary'])).toBe(EXIT_OK);
    return String(dataOf(json)['resultsHash']);
  }

  /** Mesh then solve; returns the probe values by probe name (last result set), each read at a node within `maxNodeDistance` of its point. */
  async solved(analysisId: string, maxNodeDistance = 1e-6): Promise<Record<string, number>> {
    await this.mesh(analysisId);
    await this.solve(analysisId);
    return this.probes(analysisId, maxNodeDistance);
  }

  async probes(analysisId: string, maxNodeDistance = 1e-6): Promise<Record<string, number>> {
    const { code, json } = await this.cli('analysis_report', `analysisId=${analysisId}`);
    expect(code, String(json['summary'])).toBe(EXIT_OK);
    const list = dataOf(json)['probes'];
    const found: Record<string, number> = {};
    for (const probe of Array.isArray(list) ? list : []) {
      if (!isRecord(probe) || !Array.isArray(probe['values'])) continue;
      const last: unknown = probe['values'].at(-1);
      const value = isRecord(last) ? last['value'] : null;
      if (typeof value !== 'number') throw new Error(`probe ${String(probe['name'])} has no value: ${JSON.stringify(probe)}`);
      expect(Number(probe['nodeDistance']), `probe ${String(probe['name'])} node distance`).toBeLessThanOrEqual(maxNodeDistance);
      found[String(probe['name'])] = value;
    }
    return found;
  }
}

/** A temp work directory with its own FE artifact cache; `open` starts a fresh document in it. */
export class Workspace {
  readonly dir = mkdtempSync(path.join(tmpdir(), 'llull-tmc-'));

  constructor() {
    process.env['LLULL_FEA_CACHE'] = path.join(this.dir, 'cache');
  }

  open(name: string): Session {
    return new Session(this.dir, path.join(this.dir, `${name}.llull.json`));
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
