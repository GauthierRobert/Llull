/**
 * 12 CFD M3a with the real `llull-compute` (cargo build --profile compute -p llull-compute in solver/; skipped with a logged reason when it is
 * absent): a step-limited sphere solve, then cfd_probe on the solve's own probe point answers the solve's probe values exactly (same field,
 * same trilinear rule), a slice and CPU streamlines are stored and bit-reproducible, and cfd_stop kills a long solve that then records nothing.
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
import { runCfdQuery } from '../src/cfd/flowQuery';
import { runCfdSolve, runCfdStop } from '../src/cfd/flowSolve';
import { cfdResultPort } from '../src/cfd/resultPort';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { roundDeep } from '@lib/significant';
import { requireTool } from '../../tests/requireTool';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('cfdQueryNative: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): skipped');
const native = it.skipIf(requireTool('native:llull-compute', BINARY !== null));

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-query-native-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function hostOver(): FeaHost & { current(): CadDocument } {
  let doc: CadDocument = { ...createEmptyDocument(), units: 'm' };
  const added = execute(doc, 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
  doc = execute(added.document, 'create_cfd_case', {
    id: 'ball',
    entityIds: [added.affected[0] as string],
    freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.05 } },
    reference: { areaM2: 0.7853981634, lengthM: 1 },
    cellsPerReferenceLength: 8,
    domain: { rule: 'custom', box: { min: [-2, -2.6, -2.6], max: [4, 2.6, 2.6] } },
    outputs: { probes: [[2, 0.1, -0.2]] },
  }).document;
  return {
    current: () => doc,
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store, cfdResults: cfdResultPort(store) });
      if (result.rejected !== true) doc = result.document;
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
    },
  };
}

describe('cfd result queries with the real llull-compute', () => {
  native(
    'probes equal the solve probes, slices and CPU streamlines are stored and reproducible',
    async () => {
      const host = hostOver();
      const deps = { store, runner: createComputeRunner({}, BINARY) };
      const solved = await runCfdSolve('ball', { maxSteps: 150, device: 'cpu', timeoutS: 600 }, host, deps);
      expect(solved.isError, solved.summary).toBe(false);
      const artifact = store.getAny((solved.data as { resultsHash: string }).resultsHash) as CfdResultArtifact;
      const before = host.current();

      const probe = await runCfdQuery(
        'probe',
        {
          caseId: 'ball',
          points: [
            [2, 0.1, -0.2],
            [0, 0, 0],
            [50, 0, 0],
          ],
        },
        host,
        deps,
      );
      expect(probe.isError, probe.summary).toBe(false);
      const probes = (probe.data as { probes: Array<{ velocityMS: number[] | null; pressurePa: number | null; miss: string | null }> })
        .probes;
      // The report rounds to 10 significant digits like cfd_report; the solve's own probe, rounded the same, is the exact oracle.
      expect(probes[0]?.velocityMS).toEqual(roundDeep(artifact.probes[0]?.velocityMS, 10));
      expect(probes[0]?.pressurePa).toEqual(roundDeep(artifact.probes[0]?.pressurePa, 10));
      expect(probes[1]?.miss).toBe('solid');
      expect(probes[2]?.miss).toBe('outside');

      const slice = await runCfdQuery('slice', { caseId: 'ball', origin: [0, 0, 0], normal: [0, 1, 0], field: 'speed' }, host, deps);
      expect(slice.isError, slice.summary).toBe(false);
      expect((slice.data as { slice: { validSamples: number } }).slice.validSamples).toBeGreaterThan(100);

      const rake = { kind: 'line', start: [-1.5, -0.6, 0], end: [-1.5, 0.6, 0], count: 9 };
      const trace = (): ReturnType<typeof runCfdQuery> =>
        runCfdQuery('streamlines', { caseId: 'ball', rake, device: 'cpu', maxSteps: 400 }, host, deps);
      const lines = await trace();
      expect(lines.isError, lines.summary).toBe(false);
      const data = lines.data as { deterministic: boolean; points: number; file: { sha256: string }; stopCounts: Record<string, number> };
      expect(data.deterministic).toBe(true);
      expect(data.points).toBeGreaterThan(9);
      expect((await trace()).data).toMatchObject({ file: { sha256: data.file.sha256 } });
      expect(host.current()).toBe(before);
    },
    300_000,
  );

  native(
    'cfd_stop kills a long running solve, which then records nothing',
    async () => {
      const host = hostOver();
      const before = host.current();
      let progressed = false;
      const solving = runCfdSolve('ball', { maxSteps: 2_000_000, device: 'cpu', timeoutS: 3600 }, host, {
        store,
        runner: createComputeRunner({}, BINARY),
        onProgress: () => {
          progressed = true;
        },
      });
      await expect.poll(() => progressed, { timeout: 120_000, interval: 50 }).toBe(true);
      expect(runCfdStop('ball').isError).toBe(false);
      const stopped = await solving;
      expect(stopped).toMatchObject({ isError: true, data: { code: 'CFD_CANCELLED' } });
      expect(host.current()).toBe(before);
    },
    300_000,
  );
});
