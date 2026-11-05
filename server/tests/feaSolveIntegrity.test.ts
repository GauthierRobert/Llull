/** fea_solve result integrity (FR-INT-06, FR-INT-13; VC-INT-24): the mesh-adequacy verdict is recorded and reported, a failed native step is named (fake ccx). */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaToolResult } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactStore } from '../src/fea/artifactStore';
import { caeHooks, type CaeHooks } from '../src/fea/caeHooks';
import type { CcxRunner } from '../src/fea/ccxProcess';
import { runFeaSolve, type FeaSolveDeps } from '../src/fea/feaSolve';

/** One thin tetrahedron: a single element through a 1 mm wall of a 100 mm part. */
const THIN: FeMeshArtifact = {
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '1',
  inputHash: 'h',
  nodes: [
    [1, 0, 0, 0],
    [2, 100, 0, 0],
    [3, 0, 100, 0],
    [4, 0, 0, 1],
  ],
  blocks: [{ type: 'C3D4', entityId: 'plate', elements: [[1, 1, 2, 3, 4]] }],
  nodeSets: {},
  faceSets: {},
  targets: {},
};

let directory = '';
let store: FeArtifactStore;
let doc: CadDocument;
const recorded: { name: string; params: unknown }[] = [];

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-solve-integrity-'));
  store = createFeArtifactStore(directory);
  const meshHash = store.put(THIN);
  doc = {
    ...createEmptyDocument(),
    analysis: { cases: { an: { id: 'an', meshSummary: { meshHash, inputHash: 'h' } } }, caseOrder: ['an'] },
  } as unknown as CadDocument;
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const summaryOf = (hash: string): ResultsSummary => ({
  resultsHash: hash,
  inputHash: 'h',
  solver: 'calculix',
  solverVersion: '2.21',
  loadCases: [],
  units: 'N-mm-t-s',
});

function solve(extra: Partial<FeaSolveDeps> = {}): Promise<FeaToolResult> {
  const ccx: CcxRunner = {
    run: async (jobDirectory, job) => {
      await writeFile(path.join(jobDirectory, `${job}.frd`), 'frd');
      return { exitCode: 0, log: '', timedOut: false };
    },
    version: () => Promise.resolve('2.21'),
  };
  const hooks: CaeHooks = {
    ...caeHooks,
    analysisInputHash: () => 'h',
    writeInp: () => ({ text: '*DECK\n' }),
    parseFrd: () => [{ step: 1, time: 1, fields: { DISP: { components: ['D1'], values: { '1': [0.5] } } } }],
    resultsSummary: (_doc, _id, _mesh, _results, hash) => summaryOf(hash),
  };
  const host = {
    getDoc: () => doc,
    applyCommand: (name: string, params: unknown): FeaToolResult => {
      recorded.push({ name, params });
      return { summary: 'recorded', affected: [], isError: false };
    },
  };
  return runFeaSolve('an', undefined, host, { store, hooks, ccx, ...extra });
}

describe('fea_solve records and reports the mesh adequacy (FR-INT-06)', () => {
  it('stores the verdict on the results artifact and names the inadequate part in the summary', async () => {
    const result = await solve();
    expect(result.isError).toBe(false);
    expect(result.summary).toContain("Mesh adequacy: INADEQUATE - part 'plate': 1 element layer(s) through the wall");
    expect(result.summary).toContain('compute_margins reports not_assessed rows until the mesh is refined');
    const results = store.get(String((result.data as { resultsHash: string }).resultsHash)) as FeResultsArtifact;
    expect(results.adequacy).toMatchObject({ verdict: 'inadequate', parts: [{ entityId: 'plate', order: 'linear', elementsThrough: 1 }] });
  });
});

describe('a failed native mapping step is reported (FR-INT-13, VC-INT-24)', () => {
  it('adds `native mapping failed (<message>); mapped in TypeScript` to the summary and still solves', async () => {
    const result = await solve({ beforeDeck: () => Promise.reject(new Error('llull-compute exited 3')) });
    expect(result.isError).toBe(false);
    expect(result.summary).toContain('native mapping failed (llull-compute exited 3); mapped in TypeScript.');
  });

  it('a non-Error rejection is named too, and a successful step note is kept verbatim', async () => {
    expect((await solve({ beforeDeck: () => Promise.reject('plain text') })).summary).toContain(
      'native mapping failed (plain text); mapped in TypeScript.',
    );
    expect((await solve({ beforeDeck: () => Promise.resolve('mapped natively in 3 ms') })).summary).toContain('mapped natively in 3 ms.');
  });
});
