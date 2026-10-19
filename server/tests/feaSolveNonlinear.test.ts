/** fea_solve of a nonlinear_static case: the .sta increment table becomes convergence info, abnormal stops get their NLS_* code (fake ccx). */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaToolResult } from '@mcp/index';
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

const STA = `
 SUMMARY OF JOB INFORMATION
  STEP      INC     ATT   ITRS     TOT TIME     STEP TIME      INC TIME
     1        1       1      2  2.50000E-01  2.50000E-01  2.50000E-01
     1        2       3      6  5.00000E-01  5.00000E-01  2.50000E-01
     1        3       1      3  7.50000E-01  7.50000E-01  2.50000E-01
`;
const STEP = { step: 1, time: 0.75, fields: { DISP: { components: ['D1'], values: { '1': [0.5] } } } };

let directory = '';
let store: FeArtifactStore;
let docOf: (type: string) => CadDocument;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-solve-nonlinear-'));
  store = createFeArtifactStore(directory);
  const meshHash = store.put(MESH);
  const base = createEmptyDocument();
  docOf = (type) =>
    ({
      ...base,
      analysis: { cases: { an: { id: 'an', type, meshSummary: { meshHash, inputHash: 'h' } } }, caseOrder: ['an'] },
    }) as unknown as CadDocument;
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const ok = (summary: string): FeaToolResult => ({ summary, affected: [], isError: false });

interface Run {
  readonly result: FeaToolResult;
  readonly seen: FeResultsArtifact[];
}

async function solve(type: string, outcome: { exitCode: number; log: string }): Promise<Run> {
  const seen: FeResultsArtifact[] = [];
  const ccx: CcxRunner = {
    run: async (jobDirectory, job) => {
      await writeFile(path.join(jobDirectory, `${job}.frd`), 'x');
      await writeFile(path.join(jobDirectory, `${job}.sta`), STA);
      return { exitCode: outcome.exitCode, log: outcome.log, timedOut: false };
    },
    version: () => Promise.resolve('2.21'),
  };
  const hooks: CaeHooks = {
    ...caeHooks,
    analysisInputHash: () => 'h',
    writeInp: () => ({ text: '*DECK\n' }),
    parseFrd: () => [STEP],
    resultsSummary: (_doc, _id, _mesh, results, hash): ResultsSummary => {
      seen.push(results);
      return { resultsHash: hash, inputHash: 'h', solver: 'calculix', solverVersion: '2.21', loadCases: [], units: 'N-mm-t-s' };
    },
  };
  const doc = docOf(type);
  const host = { getDoc: () => doc, applyCommand: (): FeaToolResult => ok('recorded') };
  return { result: await runFeaSolve('an', undefined, host, { store, hooks, ccx }), seen };
}

describe('fea_solve convergence of a nonlinear_static case', () => {
  it('stores the .sta rows in the results artifact and reports increments, cutbacks and iterations', async () => {
    const { result, seen } = await solve('nonlinear_static', { exitCode: 0, log: '' });
    expect(result.isError).toBe(false);
    expect(seen[0]?.convergence).toEqual([
      { step: 1, increment: 1, attempts: 1, iterations: 2, totalTime: 0.25 },
      { step: 1, increment: 2, attempts: 3, iterations: 6, totalTime: 0.5 },
      { step: 1, increment: 3, attempts: 1, iterations: 3, totalTime: 0.75 },
    ]);
    expect(result.summary).toContain('3 increment(s), 2 cutback(s), 11 iteration(s), total time reached 0.75');
    expect(result.data).toMatchObject({ convergence: { increments: 3, cutbacks: 2, iterations: 11, lastTotalTime: 0.75 } });
  });

  it.each([
    [' divergence; the increment size is decreased to 1.25e-01\n *ERROR: increment size smaller than minimum', 'NLS_INCREMENT_TOO_SMALL'],
    [' *ERROR in nonlingeo: max. # of increments reached', 'NLS_MAX_INCREMENTS'],
    [' *ERROR: too many cutbacks', 'NLS_NOT_CONVERGED'],
    ['*ERROR in readinput: unknown keyword', 'FEA_SOLVER_FAILED'],
  ])('maps the stop "%s" to %s and keeps the convergence reached so far', async (log, code) => {
    const { result, seen } = await solve('nonlinear_static', { exitCode: 1, log });
    expect(result.isError).toBe(true);
    expect(result.summary).toContain(code);
    expect(result.summary).toContain('after 3 increment(s), 2 cutback(s)');
    expect(result.data).toMatchObject({ code, convergence: { increments: 3, lastTotalTime: 0.75 } });
    expect(seen).toEqual([]);
  });

  it('leaves linear cases untouched: no .sta read, no convergence in the artifact, the old failure text and data', async () => {
    const solved = await solve('static', { exitCode: 0, log: '' });
    expect(solved.seen[0]).not.toHaveProperty('convergence');
    expect(solved.result.summary).not.toContain('increment(s)');
    expect(solved.result.data).not.toHaveProperty('convergence');
    const failed = await solve('static', { exitCode: 1, log: ' *ERROR: increment size smaller than minimum' });
    expect(failed.result.summary).toContain('FEA_SOLVER_FAILED');
    expect(failed.result.summary).not.toContain(' after ');
    expect(failed.result.data).toEqual({ code: 'FEA_SOLVER_FAILED', log: ' *ERROR: increment size smaller than minimum' });
  });
});
