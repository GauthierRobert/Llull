/** fea_solve limits (review fixes 8-9): timeout clamp, result-file size cap, non-finite results, summary built from the stored artifact. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import {
  applyExchangeToolCall,
  buildFeaToolDefinitions,
  FEA_SOLVE_TIMEOUT_S,
  type FeaToolResult,
  type FeaToolsPort,
} from '@protocol/index';
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
  readonly threads: (number | undefined)[];
  readonly commands: { name: string; params: unknown }[];
  readonly ccx: CcxRunner;
  readonly host: { getDoc: () => CadDocument; applyCommand: (name: string, params: unknown) => FeaToolResult };
  readonly hooks: CaeHooks;
}

function harness(frdText: string, hooks: Partial<CaeHooks> = {}): Harness {
  const timeouts: number[] = [];
  const threads: (number | undefined)[] = [];
  const commands: { name: string; params: unknown }[] = [];
  const ccx: CcxRunner = {
    run: async (jobDirectory, job, timeoutMs, solverThreads) => {
      timeouts.push(timeoutMs);
      threads.push(solverThreads);
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
  return { timeouts, threads, commands, ccx, host, hooks: merged };
}

describe('solver threads (PERF1)', () => {
  it('runs on one thread unless asked, and a threaded run says so in the summary, the data and the artifact', async () => {
    const single = harness('x');
    const one = await runFeaSolve('an', {}, single.host, { store, hooks: single.hooks, ccx: single.ccx });
    expect(single.threads).toEqual([1]);
    expect(one.summary).not.toContain('solver threads');
    expect(one.data).toMatchObject({ threads: 1 });

    const many = harness('x');
    const four = await runFeaSolve('an', { threads: 4 }, many.host, { store, hooks: many.hooks, ccx: many.ccx });
    expect(many.threads).toEqual([4]);
    expect(four.summary).toContain('4 solver threads: the last digits vary between runs');
    expect(four.data).toMatchObject({ threads: 4 });
    const stored = store.get(String((four.data as { resultsHash: string }).resultsHash));
    expect(stored).toMatchObject({ kind: 'fe_results', solverThreads: 4 });
    const plain = store.get(String((one.data as { resultsHash: string }).resultsHash));
    expect(plain === null ? null : 'solverThreads' in plain).toBe(false);
  });

  it('takes the host default of the runner and clamps the request to [1, 256]', async () => {
    const hosted = harness('x');
    await runFeaSolve('an', {}, hosted.host, { store, hooks: hosted.hooks, ccx: { ...hosted.ccx, defaultThreads: 6 } });
    await runFeaSolve('an', { threads: 9999 }, hosted.host, { store, hooks: hosted.hooks, ccx: hosted.ccx });
    await runFeaSolve('an', { threads: 0 }, hosted.host, { store, hooks: hosted.hooks, ccx: hosted.ccx });
    expect(hosted.threads).toEqual([6, 256, 1]);
  });

  it('the tool schema states the bounds and the dispatch forwards a whole number of threads', async () => {
    const tool = buildFeaToolDefinitions().find((entry) => entry.name === 'fea_solve');
    expect(tool?.inputSchema.properties['threads']).toMatchObject({ type: 'integer', minimum: 1, maximum: 256 });
    const seen: (number | undefined)[] = [];
    const port: FeaToolsPort = {
      mesh: () => Promise.resolve(ok('')),
      solve: (_id, options) => {
        seen.push(options.threads);
        return Promise.resolve(ok(''));
      },
      exportDeck: () => Promise.resolve(ok('')),
      importField: () => Promise.resolve(ok('')),
      convergenceStudy: () => Promise.resolve(ok('')),
      importResults: () => Promise.resolve(ok('')),
    };
    const deps = { port: null, allowCodeExecution: false, getDoc: createEmptyDocument, applyCommand: () => ok(''), fea: port };
    for (const threads of [4.7, 100000, 0, 'many']) await applyExchangeToolCall('fea_solve', { analysisId: 'an', threads }, deps);
    await applyExchangeToolCall('fea_solve', { analysisId: 'an' }, deps);
    expect(seen).toEqual([4, 256, undefined, undefined, undefined]);
  });
});

describe('timeoutS bounds (review finding 9)', () => {
  it('the tool schema states minimum and maximum', () => {
    const tool = buildFeaToolDefinitions().find((entry) => entry.name === 'fea_solve');
    expect(tool?.inputSchema.properties['timeoutS']).toMatchObject({ minimum: 1, maximum: 86400 });
    expect(FEA_SOLVE_TIMEOUT_S).toEqual({ min: 1, max: 86400 });
  });

  it('the @protocol dispatch and the transport clamp the value to [1, 86400] seconds', async () => {
    const seen: (number | undefined)[] = [];
    const port: FeaToolsPort = {
      mesh: () => Promise.resolve(ok('')),
      solve: (_id, options) => {
        seen.push(options.timeoutS);
        return Promise.resolve(ok(''));
      },
      exportDeck: () => Promise.resolve(ok('')),
      importField: () => Promise.resolve(ok('')),
      convergenceStudy: () => Promise.resolve(ok('')),
      importResults: () => Promise.resolve(ok('')),
    };
    const deps = { port: null, allowCodeExecution: false, getDoc: createEmptyDocument, applyCommand: () => ok(''), fea: port };
    for (const timeoutS of [1e12, 0.001, 30]) await applyExchangeToolCall('fea_solve', { analysisId: 'an', timeoutS }, deps);
    expect(seen).toEqual([86400, 1, 30]);

    const high = harness('x');
    await runFeaSolve('an', { timeoutS: 1e12 }, high.host, { store, hooks: high.hooks, ccx: high.ccx });
    const low = harness('x');
    await runFeaSolve('an', { timeoutS: 0 }, low.host, { store, hooks: low.hooks, ccx: low.ccx });
    expect(high.timeouts).toEqual([86_400_000]);
    expect(low.timeouts).toEqual([1000]);
  });
});

describe('result handling (review findings 8-9)', () => {
  it('refuses a result file above the cap without parsing it', async () => {
    const parseFrd = vi.fn(() => [STEP]);
    const run = harness('x'.repeat(50), { parseFrd });
    const result = await runFeaSolve('an', {}, run.host, { store, hooks: run.hooks, ccx: run.ccx, maxResultsBytes: 10 });
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('FEA_RESULTS_TOO_LARGE');
    expect(parseFrd).not.toHaveBeenCalled();
    expect(run.commands).toEqual([]);
  });

  it('refuses non-finite results as FEA_SOLVER_FAILED and records nothing', async () => {
    const nan = { ...STEP, fields: { DISP: { components: ['D1'], values: { '1': [Number.NaN] } } } };
    const run = harness('x', { parseFrd: () => [nan] });
    const result = await runFeaSolve('an', {}, run.host, { store, hooks: run.hooks, ccx: run.ccx });
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
    const result = await runFeaSolve('an', {}, run.host, { store: spying, hooks: run.hooks, ccx: run.ccx });
    expect(result.isError).toBe(false);
    const hash = received[0]?.hash ?? '';
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reads).toContain(hash);
    expect(received[0]?.results).toEqual(store.get(hash));
    expect(run.commands.map((command) => command.name)).toEqual(['record_fea_results']);
  });
});
