/** fea_solve refuses a thermal set-up whose deck is ambiguous (THM_BC_CONFLICT) before any solver runs. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CadDocument } from '@core/model/types';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactStore } from '../src/fea/artifactStore';
import { caeHooks } from '../src/fea/caeHooks';
import type { CcxRunner } from '../src/fea/ccxProcess';
import { runFeaSolve } from '../src/fea/feaSolve';
import { addBc, resultsFor, recorded, thermalFixture, twoTetMesh } from '../../tests/unit/cae/thermal/fixtures';

const source = { citation: 'test input' };
const temperature = (value: number, face: number, boxId: string): Record<string, unknown> => ({
  name: `t${value}`,
  kind: 'temperature',
  value,
  unit: 'degC',
  source,
  target: { entityId: boxId, facesNear: [[face, 0.5, 0.025]] },
});

let directory = '';
let store: FeArtifactStore;
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-solve-gate-'));
  store = createFeArtifactStore(directory);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** A meshed heat_steady case with two temperature BCs on the same nodes. */
function conflicted(values: readonly [number, number]): { doc: CadDocument; analysisId: string; ids: string[] } {
  const base = thermalFixture();
  const first = addBc(base, temperature(values[0], 0, base.boxId));
  const second = addBc({ ...base, doc: first.doc }, temperature(values[1], 0, base.boxId));
  const fixture = { ...base, doc: second.doc };
  const mesh = twoTetMesh(fixture, { nodeSets: { [`B_${first.id}`]: [1, 3, 4], [`B_${second.id}`]: [1, 3, 4] } });
  store.put(mesh);
  const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: 50, 2: 60, 3: 50, 4: 50, 5: 40 } }]);
  return { doc: recorded(fixture, mesh, results), analysisId: base.analysisId, ids: [first.id, second.id] };
}

function run(doc: CadDocument, analysisId: string): { result: Promise<FeaToolResult>; ccx: ReturnType<typeof vi.fn> } {
  const ccx = vi.fn(() => Promise.resolve({ exitCode: 0, log: '', timedOut: false }));
  const runner: CcxRunner = { run: ccx, version: () => Promise.resolve('2.21') };
  const host: FeaHost = { getDoc: () => doc, applyCommand: () => ({ summary: '', affected: [], isError: false }) };
  return { result: runFeaSolve(analysisId, undefined, host, { store, hooks: caeHooks, ccx: runner }), ccx };
}

describe('fea_solve gating on THM_BC_CONFLICT', () => {
  it('refuses different temperatures on the same nodes with the code, the BC ids and the remediation; the solver never starts', async () => {
    const { doc, analysisId, ids } = conflicted([50, 80]);
    const { result, ccx } = run(doc, analysisId);
    const outcome = await result;
    expect(outcome.isError).toBe(true);
    expect(outcome.summary).toContain('THM_BC_CONFLICT');
    expect(outcome.summary).toContain('delete_thermal_bc');
    expect(outcome.affected).toEqual(expect.arrayContaining([analysisId]));
    for (const id of ids) expect(outcome.summary).toContain(id);
    expect(ccx).not.toHaveBeenCalled();
  });

  it('does not refuse equal temperatures on the same nodes', async () => {
    const { doc, analysisId } = conflicted([50, 50]);
    const { result, ccx } = run(doc, analysisId);
    const outcome = await result;
    expect(outcome.summary).not.toContain('THM_BC_CONFLICT');
    expect(ccx).toHaveBeenCalledTimes(1);
  });
});
