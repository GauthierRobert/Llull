/** TR-FEA-32 TS side: kernel faces and face indices in the mesh request, the face map stored in the artifact and its summary; null-kernel fallback. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import { meshSummary } from '@cae/results/summary';
import { createFeArtifactStore } from '../../../server/src/fea/artifactStore';
import { caeHooks } from '../../../server/src/fea/caeHooks';
import { partFaces } from '../../../server/src/fea/faceRefs';
import { runFeaMesh, type MeshBridgeResponse } from '../../../server/src/fea/feaMesh';
import { X0_NODES, barDocument, barMesh } from './deckFixtures';

const directory = mkdtempSync(path.join(tmpdir(), 'llull-facemap-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const bar = barDocument();
const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, {
  [`C_${bar.constraints['x0']}`]: X0_NODES,
  [`C_${bar.constraints['nodeA']}`]: [1],
  [`C_${bar.constraints['nodeB']}`]: [3],
});

interface FakeOptions {
  readonly faceQuery?: boolean;
  readonly nearFace?: number | null;
  readonly details?: 'ok' | 'null' | 'empty';
  readonly shape?: boolean;
}

/** A kernel that evaluates every recipe to one shape, exports a STEP and answers the face query as a 2 x 1 x 1 box with faces 0 (x=0) and 1 (x=2). */
function fakeKernel(options: FakeOptions = {}): GeometryKernel {
  const { faceQuery = true, nearFace = 0, details = 'ok', shape = true } = options;
  const query = {
    faceDetails: () =>
      details === 'null'
        ? null
        : details === 'empty'
          ? []
          : [
              { index: 0, surface: 'plane', area: 1, centroid: [0, 0.5, 0.5], samples: [[0, 0.1, 0.1]] },
              { index: 1, surface: 'plane', area: 1, centroid: [2, 0.5, 0.5], samples: [[2, 0.9, 0.9]] },
            ],
    distance: (_shape: unknown, points: readonly unknown[]) =>
      points.map(() => (nearFace === null ? { distance: 5, signed: 5, face: 0 } : { distance: 0, signed: 0, face: nearFace })),
  };
  return {
    evaluate: () => (shape ? ({} as never) : null),
    exportStep: () => 'ISO-10303-21;',
    tessellate: () => null,
    ...(faceQuery ? { faceQuery: query } : {}),
  } as unknown as GeometryKernel;
}

describe('partFaces', () => {
  it('gives area / centroid per face and the nearest kernel face of points within tolerance', () => {
    const faces = partFaces(bar.doc, bar.boxId, fakeKernel({ nearFace: 1 }));
    expect(faces?.faces.map((face) => face.index)).toEqual([0, 1]);
    expect(faces?.nearest([[2, 0.5, 0.5]])).toEqual([1]);
    expect(faces?.nearest([])).toEqual([]);
  });

  it('is null without a kernel, a face query, a shape, details or a 3D entity; a far point has no face', () => {
    expect(partFaces(bar.doc, bar.boxId, null)).toBeNull();
    expect(partFaces(bar.doc, bar.boxId, fakeKernel({ faceQuery: false }))).toBeNull();
    expect(partFaces(bar.doc, bar.boxId, fakeKernel({ shape: false }))).toBeNull();
    expect(partFaces(bar.doc, bar.boxId, fakeKernel({ details: 'null' }))).toBeNull();
    expect(partFaces(bar.doc, bar.boxId, fakeKernel({ details: 'empty' }))).toBeNull();
    expect(partFaces(bar.doc, 'nope', fakeKernel())).toBeNull();
    expect(partFaces(bar.doc, bar.boxId, fakeKernel({ nearFace: null }))?.nearest([[9, 9, 9]])).toEqual([null]);
  });
});

describe('fea_mesh with the face map', () => {
  const run = async (
    kernel: GeometryKernel | null,
    extra: Record<string, unknown> = {},
  ): Promise<{ request: Record<string, unknown>; artifact: { faceMap?: unknown } }> => {
    let request: Record<string, unknown> = {};
    const store = createFeArtifactStore(mkdtempSync(path.join(directory, 's-')));
    const bridge = (sent: Record<string, unknown>): Promise<MeshBridgeResponse> => {
      request = sent;
      return Promise.resolve({
        ok: true,
        mesher: 'gmsh',
        mesherVersion: '4',
        nodes: mesh.nodes,
        blocks: mesh.blocks,
        nodeSets: mesh.nodeSets,
        faceSets: mesh.faceSets,
        targets: {},
        ...extra,
      });
    };
    let recorded: { faceMap?: unknown } = {};
    const host = {
      getDoc: () => bar.doc,
      applyCommand: (_name: string, params: unknown) => {
        recorded = (params as { summary: { faceMap?: unknown } }).summary;
        return { summary: 'recorded', affected: [], isError: false };
      },
    };
    await runFeaMesh(bar.analysisId, host, { bridge, store, hooks: caeHooks, kernel: () => kernel });
    return { request, artifact: recorded };
  };

  it('sends the kernel faces of STEP parts and the face indices of face targets; none without a face query', async () => {
    const withFaces = await run(fakeKernel());
    const part = (withFaces.request['parts'] as { faces?: unknown[] }[])[0];
    expect(part?.faces).toHaveLength(2);
    const targets = withFaces.request['targets'] as { key: string; faceIndices?: number[] }[];
    expect(targets.some((target) => target.faceIndices?.[0] === 0)).toBe(true);
    const without = await run(fakeKernel({ faceQuery: false }));
    expect((without.request['parts'] as { faces?: unknown[] }[])[0]?.faces).toBeUndefined();
    expect((without.request['targets'] as { faceIndices?: number[] }[]).every((target) => target.faceIndices === undefined)).toBe(true);
    const far = await run(fakeKernel({ nearFace: null }));
    expect((far.request['targets'] as { faceIndices?: number[] }[]).every((target) => target.faceIndices === undefined)).toBe(true);
  });

  it('keeps a well-formed faceMap of the response in the artifact and the mesh summary; malformed entries are dropped', async () => {
    const good = [{ entityId: bar.boxId, faceIndex: 0, tag: 3, residual: 1e-12 }];
    const withMap = await run(fakeKernel(), { faceMap: [...good, { entityId: 1 }, 'x'] });
    expect(withMap.artifact.faceMap).toEqual(good);
    expect(meshSummary({ ...mesh, faceMap: good }, 'h').faceMap).toEqual(good);
    expect(meshSummary(mesh, 'h').faceMap).toEqual([]);
    const none = await run(fakeKernel(), { faceMap: 'bad' });
    expect(none.artifact.faceMap).toEqual([]);
  });
});
