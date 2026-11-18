/** PERF1 gate, FEA: what llull itself costs around the mesher and the solver, and how fast a solved case answers (budgets.ts `fea.*`). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createFeArtifactStore } from '../../src/fea/artifactStore';
import { caeHooks } from '../../src/fea/caeHooks';
import { runFeaSolve } from '../../src/fea/feaSolve';
import type { BudgetId } from './budgets';
import { buildFeaCase, contextOf, hostOf, instantSolver, syntheticFrd, type FeaCase } from './feaFixture';
import { expectWithinBudget, medianMs, reportMeasurements } from './harness';

const directory = mkdtempSync(path.join(tmpdir(), 'llull-perf-fea-'));
const store = createFeArtifactStore(directory);
let feaCase: FeaCase;
let frd = '';

beforeAll(() => {
  feaCase = buildFeaCase();
  frd = syntheticFrd(feaCase.mesh);
});

afterAll(() => {
  console.warn(reportMeasurements());
  rmSync(directory, { recursive: true, force: true });
});

describe('FEA performance budgets (PERF1)', () => {
  it('fea.mesh.record: storing, summarising and recording the mesh', () => {
    const started = performance.now();
    const meshHash = store.put(feaCase.mesh);
    const recorded = hostOf(feaCase, store).applyCommand('record_fe_mesh', {
      analysisId: feaCase.analysisId,
      summary: caeHooks.meshSummary(feaCase.mesh, meshHash),
    });
    const elapsed = performance.now() - started;
    expect(recorded.summary).toContain('68121 nodes');
    expectWithinBudget('fea.mesh.record', elapsed);
  });

  it('fea.solve.overhead: fea_solve around an instant solver', async () => {
    const started = performance.now();
    const solved = await runFeaSolve(feaCase.analysisId, { timeoutS: 60 }, hostOf(feaCase, store), {
      store,
      hooks: caeHooks,
      ccx: instantSolver(frd),
    });
    const elapsed = performance.now() - started;
    expect(solved.isError, solved.summary).not.toBe(true);
    expect(solved.summary).toContain('1 load case(s)');
    expectWithinBudget('fea.solve.overhead', elapsed);
  });

  it('fea.query.cold: the first read of a new process', () => {
    const fresh = createFeArtifactStore(directory);
    const started = performance.now();
    const report = execute(feaCase.doc, 'analysis_report', { analysisId: feaCase.analysisId }, contextOf(fresh));
    const elapsed = performance.now() - started;
    expect(report.summary).toContain('solved');
    expectWithinBudget('fea.query.cold', elapsed);
  });

  const queries: readonly (readonly [BudgetId, string, Record<string, unknown>, string])[] = [
    ['fea.query.analysis_report', 'analysis_report', {}, 'solved'],
    ['fea.query.fea_result_field', 'fea_result_field', { field: 'von_mises', points: [[100, 20, 20]] }, '68121 node(s)'],
    ['fea.query.describe_analysis', 'describe_analysis', {}, 'solved'],
    ['fea.query.compute_margins', 'compute_margins', {}, 'compute_margins'],
    ['fea.query.check_analysis', 'check_analysis', {}, 'check_analysis'],
  ];

  it.each(queries)('%s: a read in the same process', async (id, name, params, expected) => {
    const context = contextOf(store);
    const run = (): string => execute(feaCase.doc, name, { analysisId: feaCase.analysisId, ...params }, context).summary;
    expect(run()).toContain(expected);
    expectWithinBudget(id, await medianMs(run));
  });
});
