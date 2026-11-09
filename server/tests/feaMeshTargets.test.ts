/**
 * fea_mesh refuses a target with intersectPlane (FEA_TARGET_PLANE_UNSUPPORTED): llull-mesh does not resolve it, so it would silently
 * target the whole face. Commands already refuse it; this covers documents that carry it anyway (older files, hand-written). A fake mesher
 * records whether it was called; no native binary needed.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
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

const PLANE = { point: [0, 0, 0], normal: [0, 0, 1] };

function analysisWithConstraint(withPlane: boolean): { doc: CadDocument; analysisId: string } {
  let doc = createEmptyDocument();
  const solid = execute(doc, 'add_box', { size: [10, 10, 100] });
  doc = solid.document;
  const partId = solid.affected[0] ?? '';
  doc = execute(doc, 'create_material', { name: 'st', density: 0.0078 }).document;
  doc = execute(doc, 'assign_material', { materialName: 'st', entityIds: [partId] }).document;
  const created = execute(doc, 'create_analysis', { name: 'a', analysisType: 'static' });
  const analysisId = created.affected[0] ?? '';
  doc = execute(created.document, 'set_part_idealization', { analysisId, entityId: partId }).document;
  const target = { entityId: partId, facesNear: [[0, 0, 0]] };
  const added = execute(doc, 'add_fea_constraint', { analysisId, name: 'pin', kind: 'fixed', target });
  expect(added.error).toBeUndefined();
  doc = added.document;
  if (!withPlane) return { doc, analysisId };
  // the command refuses intersectPlane, so the document is built by hand (what an older file would hold)
  const analysisCase = doc.analysis?.cases[analysisId];
  const constraintId = analysisCase?.constraintOrder[0] ?? '';
  const constraint = analysisCase?.constraints[constraintId];
  if (doc.analysis === undefined || analysisCase === undefined || constraint === undefined) throw new Error('setup');
  const patched = {
    ...analysisCase,
    constraints: { ...analysisCase.constraints, [constraintId]: { ...constraint, target: { ...target, intersectPlane: PLANE } } },
  };
  return {
    doc: { ...doc, analysis: { ...doc.analysis, cases: { ...doc.analysis.cases, [analysisId]: patched } } } as unknown as CadDocument,
    analysisId,
  };
}

async function mesh(withPlane: boolean): Promise<{ result: Awaited<ReturnType<typeof runFeaMesh>>; mesherCalls: number }> {
  const { doc, analysisId } = analysisWithConstraint(withPlane);
  const store = createFeArtifactStore(mkdtempSync(path.join(tmpdir(), 'llull-targets-')));
  const host: FeaHost = { getDoc: () => doc, applyCommand: () => ({ summary: 'recorded.', affected: [analysisId], isError: false }) };
  let mesherCalls = 0;
  const result = await runFeaMesh(analysisId, host, {
    mesher: () => {
      mesherCalls += 1;
      return Promise.resolve({ ok: true, nodes: [[1, 0, 0, 0]], blocks: [], nodeSets: {}, faceSets: {}, targets: {} });
    },
    store,
    hooks: caeHooks,
    kernel: () => kernel,
  });
  return { result, mesherCalls };
}

describe('runFeaMesh intersectPlane targets', () => {
  it('refuses with FEA_TARGET_PLANE_UNSUPPORTED naming the target, without calling the mesher', async () => {
    const { result, mesherCalls } = await mesh(true);
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('FEA_TARGET_PLANE_UNSUPPORTED');
    expect(result.summary).toContain('C_');
    expect(result.summary).toContain('does not honour');
    expect(mesherCalls).toBe(0);
  });

  it('meshes the same case without intersectPlane', async () => {
    const { result, mesherCalls } = await mesh(false);
    expect(result.isError).toBe(false);
    expect(mesherCalls).toBe(1);
  });
});
