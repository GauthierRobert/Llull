/** fea_solve limits (review fixes 8-9): timeout clamp, result-file size cap, non-finite results, summary built from the stored artifact. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { applyExchangeToolCall, buildFeaToolDefinitions, FEA_SOLVE_TIMEOUT_S, type FeaToolResult, type FeaToolsPort } from '@mcp/index';
import { createFeArtifactStore, type FeArtifactStore } from '../src/fea/artifactStore';
import { caeHooks, type CaeHooks } from '../src/fea/caeHooks';
import type { CcxRunner } from '../src/fea/ccxProcess';
import { runFeaSolve } from '../src/fea/feaSolve';

const MESH: FeMeshArtifact = {
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '1',
  inputHash: 'h',
  nodes: [],
  blocks: [],
  nodeSets: {},
  faceSets: {},
  targets: {},
};

let directory = '';
let store: FeArtifactStore;
let meshHash = '';
let doc: CadDocument;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-solve-guards-'));
  store = createFeArtifactStore(directory);
  meshHash = store.put(MESH);
  const base = createEmptyDocument();
  doc = {
    ...base,
    analysis: { cases: { an: { id: 'an', meshSummary: { meshHash, inputHash: 'h' } } }, caseOrder: ['an'] },
  } as unknown as CadDocument;
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const ok = (summary: string): FeaToolResult => ({ summary, affected: [], isError: false });
const summaryOf = (hash: string): ResultsSummary => ({
  resultsHash: hash,
  inputHash: 'h',
  solver: 'calculix',
  solverVersion: '2.21',
  loadCases: [],
  units: 'N-mm-t-s',
});
const STEP = { step: 1, time: 1, fields: { DISP: { components: ['D1'], values: { '1': [0.5] } } } };

interface Harness {
  readonly timeouts: number[];
  readonly commands: { name: string; params: unknown }[];
  readonly ccx: CcxRunner;
  readonly host: { getDoc: () => CadDocument; applyCommand: (name: string, params: unknown) => FeaToolResult };
  readonly hooks: CaeHooks;
}

function harness(frdText: string, hooks: Partial<CaeHooks> = {}): Harness {
  const timeouts: number[] = [];
  const commands: { name: string; params: unknown }[] = [];
  const ccx: CcxRunner = {
    run: async (jobDirectory, job, timeoutMs) => {
      timeouts.push(timeoutMs);
      await writeFile(path.join(jobDirectory, `${job}.frd`), frdText);
      return { exitCode: 0, log: '', timedOut: false };
    },
    version: () => Promise.resolve('2.21'),
  };
  const host = {
    getDoc: () => doc,
    applyCommand: (name: string, params: unknown): FeaToolResult => {
      commands.push({ name, params });
      return ok('recorded');
    },
  };
  const merged: CaeHooks = {
    ...caeHooks,
    analysisInputHash: () => 'h',
    writeInp: () => ({ text: '*DECK\n' }),
    parseFrd: () => [STEP],
    resultsSummary: (_doc, _id, _mesh, _results, hash) => summaryOf(hash),
    ...hooks,
  };
  return { timeouts, commands, ccx, host, hooks: merged };
}

describe('timeoutS bounds (review finding 9)', () => {
  it('the tool schema states minimum and maximum', () => {
    const tool = buildFeaToolDefinitions().find((entry) => entry.name === 'fea_solve');
    expect(tool?.inputSchema.properties['timeoutS']).toMatchObject({ minimum: 1, maximum: 86400 });
    expect(FEA_SOLVE_TIMEOUT_S).toEqual({ min: 1, max: 86400 });
  });

  it('the MCP dispatch and the transport clamp the value to [1, 86400] seconds', async () => {
    const seen: (number | undefined)[] = [];
    const port: FeaToolsPort = {
      mesh: () => Promise.resolve(ok('')),
      solve: (_id, options) => {
        seen.push(options.timeoutS);
        return Promise.resolve(ok(''));
      },
      exportDeck: () => Promise.resolve(ok('')),
      importField: () => Promise.resolve(ok('')),
    };
    const deps = { port: null, allowCodeExecution: false, getDoc: createEmptyDocument, applyCommand: () => ok(''), fea: port };
    for (const timeoutS of [1e12, 0.001, 30]) await applyExchangeToolCall('fea_solve', { analysisId: 'an', timeoutS }, deps);
    expect(seen).toEqual([86400, 1, 30]);

    const high = harness('x');
    await runFeaSolve('an', 1e12, high.host, { store, hooks: high.hooks, ccx: high.ccx });
    const low = harness('x');
    await runFeaSolve('an', 0, low.host, { store, hooks: low.hooks, ccx: low.ccx });
    expect(high.timeouts).toEqual([86_400_000]);
    expect(low.timeouts).toEqual([1000]);
  });
});

describe('result handling (review findings 8-9)', () => {
  it('refuses a result file above the cap without parsing it', async () => {
    const parseFrd = vi.fn(() => [STEP]);
    const run = harness('x'.repeat(50), { parseFrd });
    const result = await runFeaSolve('an', undefined, run.host, { store, hooks: run.hooks, ccx: run.ccx, maxResultsBytes: 10 });
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('FEA_RESULTS_TOO_LARGE');
    expect(parseFrd).not.toHaveBeenCalled();
    expect(run.commands).toEqual([]);
  });

  it('refuses non-finite results as FEA_SOLVER_FAILED and records nothing', async () => {
    const nan = { ...STEP, fields: { DISP: { components: ['D1'], values: { '1': [Number.NaN] } } } };
    const run = harness('x', { parseFrd: () => [nan] });
    const result = await runFeaSolve('an', undefined, run.host, { store, hooks: run.hooks, ccx: run.ccx });
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('FEA_SOLVER_FAILED');
    expect(result.summary).toContain('non-finite');
    expect(result.summary).toContain('step 1 field DISP node 1');
    expect(run.commands).toEqual([]);
  });

  it('summarises the results artifact read back from the store, under its hash', async () => {
    const received: { results: FeResultsArtifact; hash: string }[] = [];
    const resultsSummary: CaeHooks['resultsSummary'] = (_doc, _id, _mesh, results, hash) => {
      received.push({ results, hash });
      return summaryOf(hash);
    };
    const reads: string[] = [];
    const spying: FeArtifactStore = {
      ...store,
      directory: store.directory,
      put: (a) => store.put(a),
      get: (hash) => (reads.push(hash), store.get(hash)),
    };
    const run = harness('x', { resultsSummary });
    const result = await runFeaSolve('an', undefined, run.host, { store: spying, hooks: run.hooks, ccx: run.ccx });
    expect(result.isError).toBe(false);
    const hash = received[0]?.hash ?? '';
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reads).toContain(hash);
    expect(received[0]?.results).toEqual(store.get(hash));
    expect(run.commands.map((command) => command.name)).toEqual(['record_fea_results']);
  });
});
