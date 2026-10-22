/**
 * topology_solve end to end with the real `llull-compute` (cargo build --profile compute -p llull-compute in solver/); skipped with a logged reason
 * when it is absent. The MBB 60 x 20 study of the PHY-17 validation plan, set up through commands (E = 1 MPa, nu = 0.3, unit load, half beam:
 * symmetry-left ux = 0 and a roller at the bottom right), is VC-TOP-10 (top88 sensitivity filter): last-iteration compliance 203.19245764, and
 * VC-TOP-27 determinism (same field hash twice).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { FeTopologyArtifact, TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runTopologySolve } from '../src/native/topologySolve';
import { mbbModel, studyOf } from '../../tests/unit/cae/topology/support';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('topologySolveNative: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): skipped');
const native = BINARY === null ? it.skip : it;

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-topology-native-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('topology_solve with the real llull-compute', () => {
  native(
    'solves the MBB 60 x 20 benchmark (VC-TOP-10) and is deterministic (VC-TOP-27)',
    async () => {
      const model = mbbModel();
      const lines: string[] = [];
      const solveOnce = async (): Promise<{ hash: string; study: TopologyStudy; artifact: FeTopologyArtifact }> => {
        let doc = model.doc;
        const host: FeaHost = {
          getDoc: () => doc,
          applyCommand: (name, params) => {
            const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
            if (result.rejected !== true) doc = result.document;
            return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
          },
        };
        const runner = createComputeRunner({}, BINARY);
        const result = await runTopologySolve(model.studyId, { timeoutS: 300 }, host, {
          store,
          runner,
          onProgress: (line) => lines.push(line),
        });
        expect(result.isError, result.summary).toBe(false);
        const hash = (result.data as { fieldHash: string }).fieldHash;
        return { hash, study: studyOf(doc, model.analysisId, model.studyId), artifact: store.get(hash) as FeTopologyArtifact };
      };
      const first = await solveOnce();
      const { artifact } = first;
      expect(artifact.solver).toMatchObject({ job: 'topopt', device: 'cpu', deterministic: true });
      expect(artifact.iterations).toBe(94);
      expect(artifact.status).toBe('converged');
      const last = artifact.history.at(-1)?.compliance ?? 0;
      expect(Math.abs(last - 203.19245764) / 203.19245764).toBeLessThan(1e-6);
      expect(Math.abs(artifact.compliance - 203.182593257) / 203.182593257).toBeLessThan(1e-6);
      expect(first.study.result).toMatchObject({ fieldHash: first.hash, iterations: 94, solver: { job: 'topopt' } });
      expect(first.study.result?.volumeFraction).toBeCloseTo(0.4999701, 6);
      expect(lines).toHaveLength(94);
      expect(lines[0]).toContain('iteration 1/300');
      const second = await solveOnce();
      expect(second.hash).toBe(first.hash);
    },
    120_000,
  );
  native(
    'resumeFromLast continues a finished run bit for bit (VC-TOP-31)',
    async () => {
      const solve = async (maxIterations: number, resumeFromLast: boolean): Promise<FeTopologyArtifact> => {
        const model = mbbModel({ maxIterations });
        let doc = model.doc;
        const host: FeaHost = {
          getDoc: () => doc,
          applyCommand: (name, params) => {
            const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
            if (result.rejected !== true) doc = result.document;
            return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
          },
        };
        const result = await runTopologySolve(model.studyId, { resumeFromLast, timeoutS: 300 }, host, {
          store,
          runner: createComputeRunner({}, BINARY),
        });
        expect(result.isError, result.summary).toBe(false);
        return store.get((result.data as { fieldHash: string }).fieldHash) as FeTopologyArtifact;
      };
      const whole = await solve(30, false);
      await solve(12, false);
      const resumed = await solve(30, true);
      expect(whole.iterations).toBe(30);
      expect(resumed.iterations).toBe(30);
      expect(resumed.xPhys).toBe(whole.xPhys);
      expect(resumed.compliance).toBe(whole.compliance);
      expect(resumed.history.at(-1)).toEqual(whole.history.at(-1));
    },
    120_000,
  );

  /** The MBB study solved with `options`, through a fresh host; returns the tool result and the document it left. */
  const solveWith = async (
    settings: Record<string, unknown>,
    options: { timeoutS?: number; resumeFromLast?: boolean },
    base?: CadDocument,
  ): Promise<{ result: Awaited<ReturnType<typeof runTopologySolve>>; doc: CadDocument; model: ReturnType<typeof mbbModel> }> => {
    const model = mbbModel(settings);
    let doc = base ?? model.doc;
    const host: FeaHost = {
      getDoc: () => doc,
      applyCommand: (name, params) => {
        const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
        if (result.rejected !== true) doc = result.document;
        return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
      },
    };
    const result = await runTopologySolve(model.studyId, { timeoutS: 300, ...options }, host, {
      store,
      runner: createComputeRunner({}, BINARY),
    });
    return { result, doc, model };
  };

  native(
    'solves the MBB benchmark with MMA close to the OC optimum and records the optimizer and the volume constraint (TOP-V1)',
    async () => {
      const { result, doc, model } = await solveWith({ optimizer: 'mma' }, {});
      expect(result.isError, result.summary).toBe(false);
      const summary = studyOf(doc, model.analysisId, model.studyId).result;
      expect(summary?.optimizer).toBe('mma');
      expect(summary?.status).toBe('converged');
      expect(Math.abs((summary?.compliance ?? 0) - 203.18259325743205) / 203.18259325743205).toBeLessThan(0.05);
      expect(summary?.constraints).toEqual([expect.objectContaining({ name: 'volume', satisfied: true })]);
      expect(summary?.objective).toEqual({ kind: 'min_compliance', value: summary?.compliance });
    },
    120_000,
  );

  native(
    'checkpoints at the deadline and resumeFromLast finishes the run with the same field as an uninterrupted one (TOP-V1 deadlineS)',
    async () => {
      // a changeTol no iteration meets keeps the density-filter run going for all 300 iterations (several seconds); timeoutS 8 gives a 3 s
      // deadline, so the job checkpoints part way
      const settings = { filter: { kind: 'density' }, maxIterations: 300, changeTol: 1e-9 };
      const whole = await solveWith(settings, {});
      expect(whole.result.isError, whole.result.summary).toBe(false);
      const stopped = await solveWith(settings, { timeoutS: 8 });
      expect(stopped.result).toMatchObject({
        isError: true,
        data: { code: 'TOP_SOLVER_TIMEOUT', nativeCode: 'TOP_DEADLINE', resumable: true },
      });
      const done = (stopped.result.data as { iterations: number }).iterations;
      expect(done).toBeGreaterThan(0);
      expect(done).toBeLessThan(300);
      const resumed = await solveWith(settings, { resumeFromLast: true }, stopped.doc);
      expect(resumed.result.isError, resumed.result.summary).toBe(false);
      expect((resumed.result.data as { resumedFromIteration: number }).resumedFromIteration).toBe(done);
      const a = store.get((whole.result.data as { fieldHash: string }).fieldHash) as FeTopologyArtifact;
      const b = store.get((resumed.result.data as { fieldHash: string }).fieldHash) as FeTopologyArtifact;
      expect(b.iterations).toBe(a.iterations);
      expect(b.xPhys).toBe(a.xPhys);
      expect(b.compliance).toBe(a.compliance);
    },
    180_000,
  );
});
