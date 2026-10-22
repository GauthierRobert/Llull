/**
 * cfd_solve end to end with the real `llull-compute` (cargo build --profile compute -p llull-compute in solver/); skipped with a logged reason
 * when it is absent. A unit sphere at Re 20 on a coarse custom box, step-limited (VC-CFD-55: recorded with converged false and
 * CFD_NOT_CONVERGED), the bundle hash-checked in the store, cfd_report trusted, and the CPU run deterministic (same bundle twice, wall time apart).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { canonicalJson } from '@lib/canonicalJson';
import { cfdResultPort } from '../src/cfd/resultPort';
import { runCfdSolve } from '../src/cfd/flowSolve';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { LBM_BYTES_PER_CELL } from '@aero/cfd/memoryEstimate';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('cfdSolveNative: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): skipped');
const native = BINARY === null ? it.skip : it;

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-native-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function model(): CadDocument {
  let doc: CadDocument = { ...createEmptyDocument(), units: 'm' };
  const added = execute(doc, 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
  doc = added.document;
  return execute(doc, 'create_cfd_case', {
    id: 're100',
    entityIds: [added.affected[0] as string],
    freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.05 } },
    reference: { areaM2: 0.7853981634, lengthM: 1 },
    cellsPerReferenceLength: 8,
    domain: { rule: 'custom', box: { min: [-2, -2.6, -2.6], max: [4, 2.6, 2.6] } },
    outputs: { probes: [[2, 0, 0]], slices: [{ origin: [0, 0, 0], normal: [0, 1, 0], field: 'speed' }] },
  }).document;
}

describe('cfd_solve with the real llull-compute', () => {
  native(
    'runs a step-limited sphere case on the CPU, records it not converged and is deterministic',
    async () => {
      const lines: string[] = [];
      const solveOnce = async (): Promise<{ hash: string; doc: CadDocument }> => {
        let doc = model();
        const host: FeaHost = {
          getDoc: () => doc,
          applyCommand: (name, params) => {
            const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store, cfdResults: cfdResultPort(store) });
            if (result.rejected !== true) doc = result.document;
            return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
          },
        };
        const result = await runCfdSolve('re100', { maxSteps: 120, device: 'cpu', timeoutS: 600 }, host, {
          store,
          runner: createComputeRunner({}, BINARY),
          onProgress: (line) => lines.push(line),
        });
        expect(result.isError, result.summary).toBe(false);
        const data = result.data as {
          resultsHash: string;
          converged: boolean;
          steps: number;
          warnings: Array<{ code: string }>;
          device: string;
          precision: string;
        };
        expect(data.converged).toBe(false);
        expect(data.steps).toBe(120);
        expect(data.device).toBe('cpu');
        expect(data.precision).toBe('f64');
        expect(data.warnings.map((entry) => entry.code)).toContain('CFD_NOT_CONVERGED');
        return { hash: data.resultsHash, doc };
      };
      const first = await solveOnce();
      const artifact = store.getAny(first.hash) as CfdResultArtifact | null;
      expect(artifact?.kind).toBe('cfd_result');
      expect(artifact?.deterministic).toBe(true);
      expect(artifact?.grid.solidCells).toBeGreaterThan(0);
      expect(artifact?.probes[0]?.speedMS).not.toBeNull();
      expect(artifact?.slices).toHaveLength(1);
      expect(artifact?.surfaceBase64.length).toBeGreaterThan(8);
      // The host's bytes-per-cell figures are the solver's real layouts (finding 3 of the M2 review).
      expect(artifact?.memory).toMatchObject({
        gpuBytesPerCell: LBM_BYTES_PER_CELL.gpu,
        cpuBytesPerCell: LBM_BYTES_PER_CELL.cpu,
        bytesPerCell: LBM_BYTES_PER_CELL.cpu,
      });
      expect(artifact?.halfModel).toBe(false);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^cfd_solve: step \d+\/120 drag/);
      const report = execute(first.doc, 'cfd_report', { caseId: 're100' }, { ...defaultContext(), cfdResults: cfdResultPort(store) });
      expect(report.data).toMatchObject({ stale: false, trusted: true, converged: false });
      // 120 steps of an impulsive start: the drag is a transient number, only its presence is checked here (VC-CFD-21 is the solver test).
      expect(Number.isFinite((report.data as { forces: { cd: number } }).forces.cd)).toBe(true);
      // Deterministic CPU twin: the second run's bundle equals the first apart from the wall time it records.
      const second = await solveOnce();
      const timeless = (hash: string): string => canonicalJson({ ...(store.getAny(hash) as CfdResultArtifact), elapsedS: 0 });
      expect(timeless(second.hash)).toBe(timeless(first.hash));
    },
    300_000,
  );
});
