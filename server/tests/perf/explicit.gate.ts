/** PERF1 gate, explicit dynamics: `explicit_run` on the native solver (budgets.ts `explicit.*`); skipped without llull-compute. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeaHost } from '@protocol/index';
import { createFeArtifactStore } from '../../src/fea/artifactStore';
import { createComputeRunner } from '../../src/native/computeJob';
import { runExplicitRun } from '../../src/native/explicitRun';
import { nativeBinaryPath } from '../../src/native/nativeBinary';
import { barModel } from '../../../tests/unit/cae/explicit/support';
import { requireTool } from '../../../tests/requireTool';
import { expectWithinBudget, reportMeasurements } from './harness';

const directory = mkdtempSync(path.join(tmpdir(), 'llull-perf-explicit-'));

afterAll(() => {
  console.warn(reportMeasurements());
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(requireTool('native:llull-compute', nativeBinaryPath('llull-compute') !== null))(
  'explicit dynamics performance budgets (PERF1)',
  () => {
    it('explicit.run.hex10k: a 10 240 hex8 bar to 0.16 ms (1 206 cycles)', async () => {
      const store = createFeArtifactStore(directory);
      const model = barModel({ size: 1.25 });
      let doc = model.doc;
      const host: FeaHost = {
        getDoc: () => doc,
        applyCommand: (name, params) => {
          const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
          if (result.rejected !== true) doc = result.document;
          return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
        },
      };
      const started = performance.now();
      const run = await runExplicitRun(model.analysisId, { timeoutS: 300 }, host, {
        store,
        runner: createComputeRunner(),
        onProgress: () => undefined,
      });
      const elapsed = performance.now() - started;
      expect(run.isError, run.summary).not.toBe(true);
      expect(run.summary).toContain('normal termination');
      expectWithinBudget('explicit.run.hex10k', elapsed);
    });
  },
);
