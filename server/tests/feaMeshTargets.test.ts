/**
 * fea_mesh with intersectPlane targets: the field reaches llull-mesh (a recording fake mesher; no native binary needed), and end to end through the
 * real mesher + OCC kernel (skipped without them) a fixed support on the curve cut by a plane is the nodes on that curve, in the mesh artifact and in
 * the CalculiX deck written from it.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { FeaHost } from '@protocol/index';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { writeInp } from '@cae/decks/inpWriter';
import { createFeArtifactStore } from '../src/fea/artifactStore';
import { caeHooks } from '../src/fea/caeHooks';
import { runFeaMesh, type MesherResponse } from '../src/fea/feaMesh';
import { callNativeMesher } from '../src/fea/nativeMesher';
import { MESH_BIN, HAS_MESHER } from './feaTestSupport';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { requireTools } from '../../tests/requireTool';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
}, 60_000);

/** The plane x = 5 through the middle of the 10 x 10 x 100 box [0, 10] x [0, 10] x [0, 100]. */
const PLANE = { point: [5, 0, 0], normal: [1, 0, 0] };
const FOOT = [5, 5, 0];

function analysisWithConstraint(withPlane: boolean): { doc: CadDocument; analysisId: string } {
  let doc = createEmptyDocument();
  const solid = execute(doc, 'add_box', { size: [10, 10, 100], position: [0, 0, 0], anchor: 'min' });
  doc = solid.document;
  const partId = solid.affected[0] ?? '';
  doc = execute(doc, 'create_material', { name: 'st', density: 0.0078 }).document;
  doc = execute(doc, 'add_material_model', {
    material: 'st',
    id: 'elastic',
    model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
    basis: 'unspecified',
    source: { citation: 'synthetic test fixture', locator: 'server/tests' },
  }).document;
  doc = execute(doc, 'define_constitutive_set', { material: 'st', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true }).document;
  doc = execute(doc, 'assign_material', { materialName: 'st', entityIds: [partId] }).document;
  const created = execute(doc, 'create_analysis', { name: 'a', analysisType: 'static' });
  const analysisId = created.affected[0] ?? '';
  doc = execute(created.document, 'set_part_idealization', { analysisId, entityId: partId }).document;
  const target = { entityId: partId, facesNear: [FOOT], ...(withPlane ? { intersectPlane: PLANE } : {}) };
  const added = execute(doc, 'add_fea_constraint', { analysisId, name: 'pin', kind: 'fixed', target });
  expect(added.error).toBeUndefined();
  return { doc: added.document, analysisId };
}

interface MeshRun {
  readonly result: Awaited<ReturnType<typeof runFeaMesh>>;
  readonly requests: Record<string, unknown>[];
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly mesh: () => FeMeshArtifact;
}

const CANNED = (): Promise<MesherResponse> =>
  Promise.resolve({ ok: true, nodes: [[1, 0, 0, 0]], blocks: [], nodeSets: {}, faceSets: {}, targets: {} });

/** `fea_mesh` over the box; `mesher` answers (default: a canned reply), `geometryKernel` builds the part. */
async function mesh(
  withPlane: boolean,
  mesher: (request: Record<string, unknown>) => Promise<MesherResponse> = CANNED,
  geometryKernel: GeometryKernel = kernel,
): Promise<MeshRun> {
  const { doc, analysisId } = analysisWithConstraint(withPlane);
  const store = createFeArtifactStore(mkdtempSync(path.join(tmpdir(), 'llull-targets-')));
  const requests: Record<string, unknown>[] = [];
  let recorded = '';
  const host: FeaHost = {
    getDoc: () => doc,
    applyCommand: (name, params) => {
      const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
      if (name === 'record_fe_mesh' && isRecord(params) && isRecord(params['summary'])) recorded = String(params['summary']['meshHash']);
      return { summary: result.summary, affected: result.affected, isError: result.rejected === true };
    },
  };
  const result = await runFeaMesh(analysisId, host, {
    mesher: (request) => {
      requests.push(request);
      return mesher(request);
    },
    store,
    hooks: caeHooks,
    kernel: () => geometryKernel,
  });
  const artifact = (): FeMeshArtifact => {
    const found = store.get(recorded);
    if (found === null || found.kind !== 'fe_mesh') throw new Error('no mesh artifact was recorded');
    return found;
  };
  return { result, requests, doc, analysisId, mesh: artifact };
}

describe('runFeaMesh intersectPlane targets', () => {
  it('forwards intersectPlane to the mesher on the target that carries it', async () => {
    const { result, requests } = await mesh(true);
    expect(result.isError).toBe(false);
    const targets = requests[0]?.['targets'] as { key: string; intersectPlane?: unknown }[];
    expect(targets).toHaveLength(1);
    expect(targets[0]?.intersectPlane).toEqual(PLANE);
  });

  it('forwards no plane for a target without one', async () => {
    const { result, requests } = await mesh(false);
    expect(result.isError).toBe(false);
    const targets = requests[0]?.['targets'] as Record<string, unknown>[];
    expect(targets[0]).not.toHaveProperty('intersectPlane');
  });

  it("answers the mesher's named refusal of a plane target on faceted geometry", async () => {
    const refuse = (): Promise<MesherResponse> =>
      Promise.resolve({ ok: false, code: 'FEA_TARGET_PLANE_UNSUPPORTED', error: 'target C_x: intersectPlane needs an exact STEP part' });
    const { result } = await mesh(true, refuse);
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('FEA_TARGET_PLANE_UNSUPPORTED');
  });
});

const nativeMissing = requireTools([
  ['native:llull-mesh', HAS_MESHER],
  ['native:llull-kernel', nativeKernelBinary !== null],
]);

describe.skipIf(nativeMissing)('fea_mesh + llull-mesh + OCC kernel: a support on a plane-cut edge', () => {
  it('the fixed support is the line of nodes where the plane meets the base face, in the artifact and in the deck', async () => {
    const real = (request: Record<string, unknown>): Promise<MesherResponse> => callNativeMesher(MESH_BIN ?? '', request, 120_000, process.env);
    const occt = createNativeTestKernel();
    try {
      const run = await mesh(true, real, occt);
      expect(run.result.isError, run.result.summary).toBe(false);
      const artifact = run.mesh();
      const [key, nodeIds] = Object.entries(artifact.nodeSets).find(([name]) => name.startsWith('C_')) ?? ['', []];
      const position = new Map(artifact.nodes.map(([id, x, y, z]) => [id, [x, y, z] as const]));
      expect(nodeIds.length).toBeGreaterThanOrEqual(3);
      const line = nodeIds.map((id) => position.get(id) ?? [NaN, NaN, NaN]);
      for (const [x, , z] of line) {
        expect(x).toBeCloseTo(5, 9);
        expect(z).toBeCloseTo(0, 9);
      }
      const ys = line.map((p) => p[1] ?? NaN);
      expect(Math.min(...ys)).toBeCloseTo(0, 9);
      expect(Math.max(...ys)).toBeCloseTo(10, 9);
      // the support is the section, not the whole base face
      expect(artifact.nodes.filter(([, , , z]) => Math.abs(z) < 1e-9).length).toBeGreaterThan(2 * nodeIds.length);
      const deck = writeInp(run.doc, run.analysisId, artifact);
      if (!('text' in deck)) throw new Error(`deck refused: ${deck.code} ${deck.message}`);
      const name = key.replace(/[^A-Za-z0-9_]/g, '_');
      const block = deck.text.split('\n*').find((section) => section.startsWith(`NSET, NSET=${name}`)) ?? '';
      const inDeck = block
        .split('\n')
        .slice(1)
        .flatMap((row) => row.split(',').map((item) => Number(item.trim())))
        .filter((id) => Number.isFinite(id) && id > 0);
      expect(inDeck.sort((a, b) => a - b)).toEqual([...nodeIds].sort((a, b) => a - b));
    } finally {
      occt.dispose();
    }
  }, 180_000);
});
