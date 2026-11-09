/**
 * fea_mesh -> mesher request: every target selector of the analysis case reaches the mesher (intersectPlane was dropped, so a pinned end
 * could not be targeted by plane). A fake mesher records the request; no native binary needed.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { FeaHost } from '@protocol/index';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createFeArtifactStore } from '../src/fea/artifactStore';
import { caeHooks } from '../src/fea/caeHooks';
import { runFeaMesh } from '../src/fea/feaMesh';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
}, 60_000);

async function sentTargets(target: (partId: string) => Record<string, unknown>): Promise<Record<string, unknown>[]> {
  let doc = createEmptyDocument();
  const solid = execute(doc, 'add_box', { size: [10, 10, 100] });
  doc = solid.document;
  const partId = solid.affected[0] ?? '';
  doc = execute(doc, 'create_material', { name: 'st', density: 0.0078 }).document;
  doc = execute(doc, 'assign_material', { materialName: 'st', entityIds: [partId] }).document;
  const created = execute(doc, 'create_analysis', { name: 'a', analysisType: 'static' });
  const analysisId = created.affected[0] ?? '';
  doc = execute(created.document, 'set_part_idealization', { analysisId, entityId: partId }).document;
  const constrained = execute(doc, 'add_fea_constraint', { analysisId, name: 'pin', kind: 'fixed', target: target(partId) });
  expect(constrained.error).toBeUndefined();
  doc = constrained.document;
  const store = createFeArtifactStore(mkdtempSync(path.join(tmpdir(), 'llull-targets-')));
  const host: FeaHost = { getDoc: () => doc, applyCommand: () => ({ summary: 'recorded.', affected: [analysisId], isError: false }) };
  let sent: Record<string, unknown>[] = [];
  await runFeaMesh(analysisId, host, {
    mesher: (request) => {
      sent = request['targets'] as Record<string, unknown>[];
      return Promise.resolve({ ok: true, nodes: [[1, 0, 0, 0]], blocks: [], nodeSets: {}, faceSets: {}, targets: {} });
    },
    store,
    hooks: caeHooks,
    kernel: () => kernel,
  });
  return sent;
}

describe('runFeaMesh target forwarding', () => {
  it('sends intersectPlane to the mesher beside the other selectors', async () => {
    const plane = { point: [0, 0, 0], normal: [0, 0, 1] };
    const sent = await sentTargets((entityId) => ({ entityId, facesNear: [[0, 0, 0]], intersectPlane: plane }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ entityId: expect.any(String), intersectPlane: plane });
  });

  it('omits intersectPlane when the target has none', async () => {
    const sent = await sentTargets((entityId) => ({ entityId, facesNear: [[0, 0, 0]] }));
    expect(sent[0]).not.toHaveProperty('intersectPlane');
  });
});
