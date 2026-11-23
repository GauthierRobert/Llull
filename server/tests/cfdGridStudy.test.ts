/**
 * 12 CFD `cfd_solve gridStudy` host wiring (fake runner whose drag follows the cell size): three solves at ratio 2 (n, n/2, n/4), the finest
 * recorded with record_cfd_results and the study with record_cfd_grid_study through the registry; refusals by name before anything runs;
 * cfd_stop and the caller's signal cancel the whole study and record nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { _stopAllCfdSolves, activeStudies, runCfdStop } from '../src/cfd/flowSolve';
import { runCfdGridStudy } from '../src/cfd/flowGridStudy';
import { runCfdTool } from '../src/cfd/cfdTools';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { fakeRunner, hostOf, sphereModel, type Model } from './cfdTestSupport';

let dir = '';
let store: FeArtifactCache;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-study-'));
  store = createFeArtifactStore(dir);
});
afterEach(() => {
  _stopAllCfdSolves();
  rmSync(dir, { recursive: true, force: true });
});

/** The sphere case at `cells` per reference length. */
function modelAt(cells: number): Model {
  const base = sphereModel();
  const doc: CadDocument = execute(base.doc, 'update_cfd_case', { caseId: 're100', cellsPerReferenceLength: cells }).document;
  return { ...base, doc };
}

const cellMs = (runner: ReturnType<typeof fakeRunner>): number[] =>
  runner.calls.map((call) => (JSON.parse(call.files['case.json']?.toString('utf8') ?? '{}') as { grid: { cellM: number } }).grid.cellM);

describe('cfd_solve gridStudy', () => {
  it('solves n, n/2, n/4 (coarsest first), records the finest and the verified study through the registry', async () => {
    const host = hostOf(modelAt(32), store);
    const runner = fakeRunner({ byGrid: (h) => 0.5 + 8 * h * h });
    const lines: string[] = [];
    const solved = await runCfdGridStudy('re100', {}, host, { store, runner, onProgress: (line) => lines.push(line) });
    expect(solved.isError, solved.summary).toBe(false);
    expect(cellMs(runner)).toEqual([0.125, 0.0625, 0.03125]);
    expect(lines[0]).toMatch(/^cfd_solve gridStudy 1\/3 \(8 cells\/length\): cfd_solve: step/);
    const data = solved.data as { resultsHash: string; resultsHashes: string[]; levels: { cells: number }[] };
    expect(data.levels.map((level) => level.cells)).toEqual([32, 16, 8]);
    expect(new Set(data.resultsHashes).size).toBe(3);
    const doc = host.current();
    expect(doc.cfd?.results['re100']).toMatchObject({ resultsHash: data.resultsHash, verified: true });
    const study = doc.cfd?.studies?.['re100'];
    expect(study).toMatchObject({ caseId: 're100', status: 'monotone', verified: true });
    expect(study?.levels.map((level) => level.resultsHash)).toEqual(data.resultsHashes);
    expect(study?.orderP).toBeCloseTo(2, 3);
    expect(solved.summary).toContain('32 / 16 / 8 cells per reference length');
    expect(solved.affected).toEqual(['re100']);
  });

  it('is reachable through the transport tool with gridStudy=true (a plain call still runs one solve)', async () => {
    const host = hostOf(modelAt(32), store);
    const runner = fakeRunner({ byGrid: (h) => 0.5 + 8 * h * h });
    const outcome = await runCfdTool('cfd_solve', { caseId: 're100', gridStudy: true }, host, { store, runner });
    expect(outcome).toMatchObject({ isError: false, changed: true });
    expect(runner.calls).toHaveLength(3);
    const single = fakeRunner();
    await runCfdTool('cfd_solve', { caseId: 're100' }, hostOf(modelAt(32), store), { store, runner: single });
    expect(single.calls).toHaveLength(1);
  });

  it('refuses by name before anything runs when a level leaves 8..2048 or is not an integer', async () => {
    for (const cells of [8, 16, 28 + 6]) {
      const host = hostOf(modelAt(cells), store);
      const runner = fakeRunner();
      const refused = await runCfdGridStudy('re100', {}, host, { store, runner });
      expect(refused, String(cells)).toMatchObject({ isError: true, data: { code: 'CFD_PARAM_INVALID', gridStudy: true } });
      expect(refused.summary).toContain('8..2048');
      expect(runner.calls).toHaveLength(0);
      expect(host.current().cfd?.studies?.['re100']).toBeUndefined();
    }
  });

  it('refuses unknown cases, a missing binary and the memory check of any level without running', async () => {
    const host = hostOf(modelAt(32), store);
    const runner = fakeRunner();
    expect(await runCfdGridStudy('nope', {}, host, { store, runner })).toMatchObject({ data: { code: 'CFD_CASE_NOT_FOUND' } });
    const memory = await runCfdGridStudy('re100', { deviceMemoryBytes: 1000 }, host, { store, runner });
    expect(memory).toMatchObject({ isError: true, data: { code: 'CFD_MEMORY_EXCEEDED' } });
    expect(runner.calls).toHaveLength(0);
  });

  it('cfd_stop mid-study kills the run, cancels the remaining levels and records nothing', async () => {
    const model = modelAt(32);
    const host = hostOf(model, store);
    const runner = fakeRunner({ hold: true, byGrid: (h) => 0.5 + 8 * h * h });
    const solving = runCfdGridStudy('re100', {}, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    const stopped = runCfdStop('re100');
    expect(stopped.isError).toBe(false);
    expect(stopped.summary).toContain('1 grid study(ies)');
    const result = await solving;
    expect(result).toMatchObject({ isError: true, data: { code: 'CFD_CANCELLED' } });
    expect(runner.calls).toHaveLength(1);
    expect(host.current()).toBe(model.doc);
    expect(runCfdStop('re100').data).toMatchObject({ code: 'CFD_NOT_RUNNING' });
  });

  it('stops in the gap between two solves (cfd_stop after level 1 is stored, before level 2 starts)', async () => {
    const model = modelAt(32);
    const host = hostOf(model, store);
    const runner = fakeRunner({ byGrid: (h) => 0.5 + 8 * h * h });
    let stopped: ReturnType<typeof runCfdStop> | undefined;
    const gapStore: FeArtifactCache = {
      ...store,
      put: (artifact) => {
        const hash = store.put(artifact);
        stopped ??= runCfdStop('re100');
        return hash;
      },
    };
    const result = await runCfdGridStudy('re100', {}, host, { store: gapStore, runner });
    expect(result).toMatchObject({ isError: true, data: { code: 'CFD_CANCELLED' } });
    expect(runner.calls).toHaveLength(1);
    expect(stopped).toMatchObject({ isError: false, data: { stopped: [], studies: 1 } });
    expect(host.current()).toBe(model.doc);
    expect(activeStudies.size).toBe(0);
  });

  it('cancels mid-solve on the caller signal: one call, no study left registered, nothing to stop', async () => {
    const model = modelAt(32);
    const host = hostOf(model, store);
    const runner = fakeRunner({ hold: true });
    const controller = new AbortController();
    const solving = runCfdGridStudy('re100', { signal: controller.signal }, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    expect(activeStudies.size).toBe(1);
    controller.abort();
    expect(await solving).toMatchObject({ isError: true, data: { code: 'CFD_CANCELLED' } });
    expect(runner.calls).toHaveLength(1);
    expect(activeStudies.size).toBe(0);
    expect(runCfdStop('re100').data).toMatchObject({ code: 'CFD_NOT_RUNNING' });
    expect(host.current()).toBe(model.doc);
  });

  it('refuses an already aborted caller before any level starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = fakeRunner();
    const aborted = await runCfdGridStudy('re100', { signal: controller.signal }, hostOf(modelAt(32), store), { store, runner });
    expect(aborted).toMatchObject({ isError: true, data: { code: 'CFD_CANCELLED' } });
    expect(aborted.summary).toContain('cancelled by its caller');
    expect(runner.calls).toHaveLength(0);
  });

  it('records nothing and passes the study refusal through when the body moves during the solves (CFD_INPUT_STALE)', async () => {
    const model = modelAt(32);
    const host = hostOf(model, store);
    let moved: CadDocument | undefined;
    const runner = fakeRunner({ byGrid: (h) => 0.5 + 8 * h * h });
    const result = await runCfdGridStudy('re100', {}, host, {
      store,
      runner,
      onProgress: () => {
        if (moved !== undefined) return;
        moved = execute(model.doc, 'move_entities', { ids: [model.ballId], delta: [0.25, 0, 0] }).document;
        host.set(moved);
      },
    });
    expect(runner.calls).toHaveLength(3);
    expect(result).toMatchObject({ isError: true, data: { code: 'CFD_INPUT_STALE' } });
    expect(result.summary).toContain('nothing was recorded');
    // atomic: the three good solves left no result and no study in the document
    expect(host.current()).toBe(moved);
  });

  it('collects the warnings of every level, tagged by level, into the summary and data.warnings', async () => {
    const host = hostOf(modelAt(32), store);
    const warnings = [{ code: 'CFD_GPU_UNAVAILABLE', message: 'no usable GPU adapter' }];
    const runner = fakeRunner({ converged: false, warnings, byGrid: (h) => 0.5 + 8 * h * h });
    const solved = await runCfdGridStudy('re100', { maxSteps: 50 }, host, { store, runner });
    expect(solved.isError, solved.summary).toBe(false);
    const found = (solved.data as { warnings: { level: number; code: string }[] }).warnings;
    expect(found.filter((entry) => entry.code === 'CFD_NOT_CONVERGED').map((entry) => entry.level)).toEqual([32, 16, 8]);
    expect(found.filter((entry) => entry.code === 'CFD_GPU_UNAVAILABLE')).toHaveLength(3);
    expect(solved.summary).toContain('level 8: CFD_NOT_CONVERGED');
  });

  it('names the failing level and records nothing when a solve fails', async () => {
    const host = hostOf(modelAt(32), store);
    const runner = fakeRunner({ fail: { code: 'NATIVE_JOB_INPUT', message: 'bad grid' } });
    const failed = await runCfdGridStudy('re100', {}, host, { store, runner });
    expect(failed).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED' } });
    expect(failed.summary).toContain('level 1/3 (8 cells/length)');
    expect(runner.calls).toHaveLength(1);
    expect(host.current().cfd?.results['re100']).toBeUndefined();
  });
});
