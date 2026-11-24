/**
 * cfd_solve gridStudy end to end with the real `llull-compute` on the CPU (cargo build --profile compute -p llull-compute in solver/); skipped
 * with a logged reason when it is absent. A sphere at Re 20 on a custom box at 32 / 16 / 8 cells per reference length (4 m: coarse cells, a cheap CPU run), step-limited: the bundles
 * land in the store with their own grids and the study is recorded verified through the registry.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { runCfdGridStudy } from '../src/cfd/flowGridStudy';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { requireTool } from '../../tests/requireTool';
import { hostOf } from './cfdTestSupport';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('cfdGridStudyNative: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): skipped');
const native = it.skipIf(requireTool('native:llull-compute', BINARY !== null));

let dir = '';
let store: FeArtifactCache;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-study-native-'));
  store = createFeArtifactStore(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function model(): CadDocument {
  let doc: CadDocument = { ...createEmptyDocument(), units: 'm' };
  const added = execute(doc, 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
  doc = added.document;
  return execute(doc, 'create_cfd_case', {
    id: 're20',
    entityIds: [added.affected[0] as string],
    freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.05 } },
    reference: { areaM2: 0.7853981634, lengthM: 4 },
    cellsPerReferenceLength: 32,
    domain: { rule: 'custom', box: { min: [-2, -2.6, -2.6], max: [4, 2.6, 2.6] } },
  }).document;
}

describe('cfd_solve gridStudy with the real llull-compute', () => {
  native(
    'solves the three levels on the CPU and records the study through the registry',
    async () => {
      const host = hostOf({ doc: model(), ballId: '' }, store);
      const solved = await runCfdGridStudy('re20', { maxSteps: 40, device: 'cpu', timeoutS: 900 }, host, {
        store,
        runner: createComputeRunner({}, BINARY),
      });
      expect(solved.isError, solved.summary).toBe(false);
      const data = solved.data as { resultsHashes: string[]; levels: { cells: number; cellM: number }[] };
      expect(data.levels.map((level) => level.cells)).toEqual([32, 16, 8]);
      expect(data.levels.map((level) => level.cellM)).toEqual([4 / 32, 4 / 16, 4 / 8]);
      for (const hash of data.resultsHashes) expect((store.getAny(hash) as CfdResultArtifact).kind).toBe('cfd_result');
      const study = host.current().cfd?.studies?.['re20'];
      expect(study).toMatchObject({ caseId: 're20', verified: true });
      expect(study?.levels.map((level) => level.resultsHash)).toEqual(data.resultsHashes);
      expect(host.current().cfd?.results['re20']).toMatchObject({ resultsHash: data.resultsHashes[0], verified: true });
    },
    900_000,
  );
});
