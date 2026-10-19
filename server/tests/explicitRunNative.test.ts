/**
 * explicit_run end to end with the real `llull-compute` (cargo build --profile compute -p llull-compute in solver/); skipped with a logged reason
 * when it is absent. VC-EXP-67 (bar plan): the 10 x 10 x 200 mm steel-like bar of exp_bar_rigid_wall at 10 m/s on a rigid wall, set up through
 * commands with a structured 2.5 mm hex mesh: wall force plateau rho c0 v A = 39 623 N and contact 2L/c0 = 79.2 us within the pack's 3 %
 * (VC-EXP-50), normal termination, energy error < 2 %, recorded through record_explicit_results and read back by explicit_report; two runs give the
 * same artifact hash (AF-13).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExplicitResultsSummary, FeExplicitArtifact } from '@core/model/explicit';
import type { FeaHost } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runExplicitRun } from '../src/native/explicitRun';
import { barModel } from '../../tests/unit/cae/explicit/support';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('explicitRunNative: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): skipped');
const native = BINARY === null ? it.skip : it;

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-explicit-native-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const C0 = Math.sqrt(200_000 / 7.85e-9);
const FORCE = 7.85e-9 * C0 * 10_000 * 100;
const DURATION = 400 / C0;

describe('explicit_run with the real llull-compute', () => {
  native(
    'bar on a rigid wall matches rho c0 v and 2L/c0 (VC-EXP-67 / VC-EXP-50) and is deterministic',
    async () => {
      const model = barModel({ size: 2.5 });
      const solveOnce = async (): Promise<{ hash: string; doc: ReturnType<FeaHost['getDoc']> }> => {
        let doc = model.doc;
        const host: FeaHost = {
          getDoc: () => doc,
          applyCommand: (name, params) => {
            const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
            if (result.rejected !== true) doc = result.document;
            return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
          },
        };
        const lines: string[] = [];
        const result = await runExplicitRun(model.analysisId, { timeoutS: 300 }, host, {
          store,
          runner: createComputeRunner({}, BINARY),
          onProgress: (line) => lines.push(line),
        });
        expect(result.isError, result.summary).toBe(false);
        expect(lines.length).toBeGreaterThan(10);
        return { hash: (result.data as { artifactHash: string }).artifactHash, doc };
      };
      const first = await solveOnce();
      const artifact = store.get(first.hash) as FeExplicitArtifact;
      expect(artifact.termination).toBe('normal');
      expect(artifact.solver).toMatchObject({ name: 'llull-explicit', device: 'cpu', deterministic: true });
      expect(artifact.elements).toEqual({ hex8: 4 * 4 * 80, tet4: 0 });
      const wall = artifact.walls[0];
      if (wall === undefined) throw new Error('no wall history');
      const peak = Math.max(...wall.force);
      const on = wall.force.map((force, index) => (force > 0.01 * peak ? index : -1)).filter((index) => index >= 0);
      const start = (on[0] ?? 0) === 0 ? 0 : (wall.t[(on[0] ?? 1) - 1] ?? 0);
      const end = wall.t[on[on.length - 1] ?? 0] ?? 0;
      const window = on.filter(
        (index) => (wall.t[index] ?? 0) > start + 0.15 * (end - start) && (wall.t[index] ?? 0) < start + 0.85 * (end - start),
      );
      const plateau = window.reduce((sum, index) => sum + (wall.force[index] ?? 0), 0) / window.length;
      expect(Math.abs(plateau / FORCE - 1)).toBeLessThan(0.03);
      expect(Math.abs((end - start) / DURATION - 1)).toBeLessThan(0.03);
      const summary = first.doc.analysis?.cases[model.analysisId]?.explicit?.results as ExplicitResultsSummary;
      expect(summary.artifactHash).toBe(first.hash);
      expect(Math.abs(summary.energy.errorMaxAbs)).toBeLessThan(0.02);
      expect(summary.walls['anvil']?.impulse).toBeGreaterThan(0);
      const report = execute(first.doc, 'explicit_report', { analysisId: model.analysisId }, { ...defaultContext(), feaArtifacts: store });
      expect((report.data as { state: string }).state).toBe('solved');
      const second = await solveOnce();
      expect(second.hash).toBe(first.hash);
    },
    300_000,
  );
});
