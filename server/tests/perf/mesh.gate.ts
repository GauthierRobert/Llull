/** PERF1 gate, mesh import: `import_mesh_file` of a 1M-triangle file through the mesh asset store of the host (budgets.ts `mesh.*`). */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { createMeshAssetStore, type MeshAssetStore } from '../../src/meshAssets/store';
import { expectWithinBudget, medianMs, reportMeasurements } from './harness';
import { torusObj, torusStl } from './meshFixture';

/** 1000 x 500 quads = 1 000 000 triangles, 500 000 vertices. */
const AROUND = 1000;
const ALONG = 500;

let dir: string;
let store: MeshAssetStore;
let ctx: ExecutionContext;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'llull-perf-mesh-'));
  store = createMeshAssetStore(dir);
  ctx = { ...defaultContext(), meshAssets: store };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  console.warn(reportMeasurements());
});

async function importTime(bytes: Uint8Array, format: string): Promise<number> {
  const fileKey = store.putFile(bytes);
  let summary = '';
  const elapsed = await medianMs(() => {
    const result = execute(createEmptyDocument(), 'import_mesh_file', { fileKey, units: 'mm' }, ctx);
    summary = result.summary;
  });
  expect(summary).toContain(`${format} -> 1 mesh (mesh-1.1), ${AROUND * ALONG * 2} triangles`);
  return elapsed;
}

describe('mesh import performance budgets (PERF1)', () => {
  it('mesh.import.stl1m: import_mesh_file of a 1M-triangle binary STL', async () => {
    expectWithinBudget('mesh.import.stl1m', await importTime(torusStl(AROUND, ALONG), 'stl-binary'));
  });

  it('mesh.import.obj1m: import_mesh_file of a 1M-triangle OBJ', async () => {
    expectWithinBudget('mesh.import.obj1m', await importTime(torusObj(AROUND, ALONG), 'obj'));
  });
});
