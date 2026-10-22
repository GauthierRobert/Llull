/**
 * llull-mesh (Gmsh) on boxes: STL geometry (Manifold kernel) and exact STEP (OCC kernel, when it loads). Skipped without llull-mesh and a
 * Gmsh library. Meshes are coarse to keep the suite fast.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { FeMeshArtifact } from '@core/model/analysis';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { callNativeMesher } from '../src/fea/nativeMesher';
import { partGeometry } from '../src/fea/feaGeometry';
import { HAS_GMSH, MESH_BIN } from './feaTestSupport';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';

interface MeshReply {
  ok: boolean;
  code?: string;
  error?: string;
  mesherVersion: string;
  nodes: FeMeshArtifact['nodes'];
  blocks: FeMeshArtifact['blocks'];
  nodeSets: FeMeshArtifact['nodeSets'];
  faceSets: FeMeshArtifact['faceSets'];
  targets: FeMeshArtifact['targets'];
}

// CalculiX tet face labels over the element's first four nodes.
const FACE_CORNERS: Readonly<Record<number, readonly number[]>> = { 1: [0, 1, 2], 2: [0, 3, 1], 3: [1, 3, 2], 4: [2, 3, 0] };

let doc: CadDocument;
const ids: string[] = [];
let manifold: GeometryKernel;
let occt: GeometryKernel | null = null;

beforeAll(async () => {
  let current = createEmptyDocument();
  for (const position of [
    [0, 0, 0],
    [30, 0, 0],
  ]) {
    const added = execute(current, 'add_box', { size: [10, 5, 5], position, anchor: 'min' });
    current = added.document;
    ids.push(added.affected[0] ?? '');
  }
  doc = current;
  manifold = await createManifoldKernel();
  occt = nativeKernelBinary === null ? null : createNativeTestKernel();
}, 120_000);

async function mesh(request: Record<string, unknown>): Promise<MeshReply> {
  return (await callNativeMesher(MESH_BIN ?? '', { op: 'mesh', lengthScale: 1, ...request }, 120_000, process.env)) as unknown as MeshReply;
}

function request(kernel: GeometryKernel, order: 1 | 2, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const id = ids[0] ?? '';
  const geometry = partGeometry(doc, id, kernel);
  return {
    parts: [{ entityId: id, geometry }],
    targets: [
      { key: 'C_fix', entityId: id, facesNear: [[0, 2.5, 2.5]] },
      { key: 'L_end', entityId: id, facesNear: [[10, 2.5, 2.5]] },
      { key: 'P_mid', entityId: null, pointsNear: [[5, 2.5, 2.5]] },
    ],
    controls: { order, globalSize: 3, refinements: [] },
    ...extra,
  };
}

function expectFacesOnSet(reply: MeshReply, key: string): void {
  const elements = new Map(reply.blocks.flatMap((block) => block.elements.map((row) => [row[0], row.slice(1)] as const)));
  const nodeSet = new Set(reply.nodeSets[key]);
  const faces = reply.faceSets[key] ?? [];
  expect(faces.length).toBeGreaterThan(0);
  for (const [elementId, label] of faces) {
    expect([1, 2, 3, 4]).toContain(label);
    const nodes = elements.get(elementId ?? -1) ?? [];
    for (const corner of FACE_CORNERS[label ?? 0] ?? []) expect(nodeSet.has(nodes[corner] ?? -1)).toBe(true);
  }
}

describe.skipIf(!HAS_GMSH)('llull-mesh — STL geometry (Manifold)', () => {
  it.each([1, 2] as const)('meshes a box with tet order %i and resolves faces and points', async (order) => {
    const reply = await mesh(request(manifold, order));
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.mesherVersion).toMatch(/^4\./);
    expect(reply.nodes.length).toBeGreaterThan(8);
    const block = reply.blocks[0];
    expect(block?.type).toBe(order === 1 ? 'C3D4' : 'C3D10');
    expect(block?.entityId).toBe(ids[0]);
    expect(block?.elements.length).toBeGreaterThan(0);
    expect(block?.elements[0]).toHaveLength(order === 1 ? 5 : 11);
    expect(reply.nodes.map((node) => node[0])).toEqual(reply.nodes.map((_, index) => index + 1));
    for (const key of ['C_fix', 'L_end', 'P_mid']) expect(reply.nodeSets[key]?.length, key).toBeGreaterThan(0);
    expectFacesOnSet(reply, 'C_fix');
    expectFacesOnSet(reply, 'L_end');
    expect(reply.faceSets['P_mid']).toBeUndefined();
    // the fixed face is the x = 0 plane: every node of its set lies on it
    const byId = new Map(reply.nodes.map((node) => [node[0], node] as const));
    for (const nodeId of reply.nodeSets['C_fix'] ?? []) expect(byId.get(nodeId)?.[1]).toBeCloseTo(0, 6);
    expect(reply.targets['C_fix']?.residual).toBeCloseTo(0, 6);
  });

  it('is deterministic', async () => {
    const [a, b] = [await mesh(request(manifold, 1)), await mesh(request(manifold, 1))];
    expect(a.nodes).toEqual(b.nodes);
    expect(a.blocks).toEqual(b.blocks);
  });

  it('refuses a point on the boundary of two faces and a point far from the part', async () => {
    const edge = await mesh(request(manifold, 1, { targets: [{ key: 'C_bad', entityId: ids[0], facesNear: [[5, 0, 0]] }] }));
    expect(edge).toMatchObject({ ok: false, code: 'FEA_TARGET_AMBIGUOUS' });
    const far = await mesh(request(manifold, 1, { targets: [{ key: 'C_far', entityId: ids[0], facesNear: [[0, 2.5, 200]] }] }));
    expect(far).toMatchObject({ ok: false, code: 'FEA_TARGET_UNRESOLVED' });
  });

  it('refines near a face', async () => {
    const plain = await mesh(request(manifold, 1));
    const refined = await mesh(
      request(manifold, 1, {
        targets: [{ key: 'R_0', entityId: ids[0], facesNear: [[10, 2.5, 2.5]] }],
        controls: { order: 1, globalSize: 3, refinements: [{ key: 'R_0', size: 1 }] },
      }),
    );
    expect(refined.ok, refined.error).toBe(true);
    expect(refined.blocks[0]?.elements.length).toBeGreaterThan(plain.blocks[0]?.elements.length ?? 0);
  });

  it('meshes several entities as separate blocks with global node and element ids', async () => {
    const parts = ids.map((id) => ({ entityId: id, geometry: partGeometry(doc, id, manifold) }));
    const reply = await mesh({
      parts,
      targets: [
        { key: 'C_b', entityId: ids[1], facesNear: [[30, 2.5, 2.5]] },
        { key: 'P_all', entityId: null, pointsNear: [[35, 2.5, 2.5]] },
      ],
      controls: { order: 1, globalSize: 3, refinements: [] },
    });
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.blocks.map((block) => block.entityId)).toEqual(ids);
    const elementIds = reply.blocks.flatMap((block) => block.elements.map((row) => row[0]));
    expect(new Set(elementIds).size).toBe(elementIds.length);
    const byId = new Map(reply.nodes.map((node) => [node[0], node] as const));
    for (const nodeId of reply.nodeSets['C_b'] ?? []) expect(byId.get(nodeId)?.[1]).toBeCloseTo(30, 6);
    expect(byId.get(reply.nodeSets['P_all']?.[0] ?? -1)?.[1]).toBeGreaterThan(29);
  });

  it('scales lengths by lengthScale (mm -> m)', async () => {
    const reply = await mesh(request(manifold, 1, { lengthScale: 0.001, controls: { order: 1, globalSize: 3, refinements: [] } }));
    expect(reply.ok, reply.error).toBe(true);
    const xs = reply.nodes.map((node) => node[1]);
    expect(Math.max(...xs)).toBeCloseTo(0.01, 6);
  });
});

describe.skipIf(!HAS_GMSH)('llull-mesh — exact STEP geometry (OCC)', () => {
  it('meshes the STEP of a box with the same target resolution', async (context) => {
    if (occt === null) context.skip();
    const reply = await mesh(request(occt as GeometryKernel, 2));
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.blocks[0]?.type).toBe('C3D10');
    for (const key of ['C_fix', 'L_end', 'P_mid']) expect(reply.nodeSets[key]?.length, key).toBeGreaterThan(0);
    expectFacesOnSet(reply, 'C_fix');
    const edge = await mesh(request(occt as GeometryKernel, 2, { targets: [{ key: 'C_bad', entityId: ids[0], facesNear: [[5, 0, 0]] }] }));
    expect(edge).toMatchObject({ ok: false, code: 'FEA_TARGET_AMBIGUOUS' });
  });
});

describe.skipIf(!HAS_GMSH)('llull-mesh — facesNear on trimmed faces (coplanar disjoint faces)', () => {
  it('resolves a point on each of two equal-height boss tops to that boss face only', async (context) => {
    if (occt === null) context.skip();
    const kernel = occt as GeometryKernel;
    const ctx = { ...defaultContext(), kernel };
    let current = createEmptyDocument();
    const added: string[] = [];
    for (const [size, position] of [
      [
        [100, 50, 10],
        [0, 0, 0],
      ],
      [
        [10, 10, 5],
        [10, 20, 10],
      ],
      [
        [10, 10, 5],
        [80, 20, 10],
      ],
    ] as const) {
      const step = execute(current, 'add_box', { size, position, anchor: 'min' }, ctx);
      current = step.document;
      added.push(step.affected[0] ?? '');
    }
    for (const boss of added.slice(1)) {
      const fused = execute(current, 'boolean', { op: 'union', a: added[0] ?? '', b: boss }, ctx);
      expect(fused.document).not.toBe(current);
      current = fused.document;
      added[0] = fused.affected[0] ?? added[0] ?? '';
    }
    const id = added[0] ?? '';
    const reply = await mesh({
      parts: [{ entityId: id, geometry: partGeometry(current, id, kernel) }],
      targets: [
        { key: 'C_left', entityId: id, facesNear: [[15, 25, 15]] },
        { key: 'C_right', entityId: id, facesNear: [[85, 25, 15]] },
      ],
      controls: { order: 1, globalSize: 6, refinements: [] },
    });
    expect(reply.ok, reply.error).toBe(true);
    const position = new Map(reply.nodes.map((node) => [node[0], node] as const));
    for (const [key, [x0, x1]] of [
      ['C_left', [10, 20]],
      ['C_right', [80, 90]],
    ] as const) {
      const set = reply.nodeSets[key] ?? [];
      expect(set.length, key).toBeGreaterThan(0);
      for (const node of set) {
        const [, x = NaN, , z = NaN] = position.get(node) ?? [];
        expect(z).toBeCloseTo(15, 6);
        expect(x).toBeGreaterThanOrEqual(x0 - 1e-6);
        expect(x).toBeLessThanOrEqual(x1 + 1e-6);
      }
    }
  });
});

describe.skipIf(!HAS_GMSH)('llull-mesh — conformal bonding of touching parts', () => {
  let touching: CadDocument;
  const pair: string[] = [];

  beforeAll(() => {
    let current = createEmptyDocument();
    // [0,10] x [0,5] x [0,5] and a neighbour sharing the face x = 10; the third box overlaps the first one
    for (const position of [
      [0, 0, 0],
      [10, 0, 0],
      [5, 0, 0],
    ]) {
      const added = execute(current, 'add_box', { size: [10, 5, 5], position, anchor: 'min' });
      current = added.document;
      pair.push(added.affected[0] ?? '');
    }
    touching = current;
  });

  const conformal = (kernel: GeometryKernel, entityIds: readonly string[], bonding?: 'conformal'): Promise<MeshReply> =>
    mesh({
      parts: entityIds.map((entityId) => ({ entityId, geometry: partGeometry(touching, entityId, kernel) })),
      targets: [{ key: 'C_if', entityId: entityIds[1], facesNear: [[10, 2.5, 2.5]] }],
      controls: { order: 2, globalSize: 3, refinements: [], ...(bonding === undefined ? {} : { bonding }) },
    });

  const nodesOf = (reply: MeshReply, entityId: string): Set<number> =>
    new Set(reply.blocks.filter((block) => block.entityId === entityId).flatMap((block) => block.elements.flatMap((row) => row.slice(1))));

  it('shares the interface nodes between the parts and keeps one element block per entity; separate meshes share none', async (context) => {
    if (occt === null) context.skip();
    const kernel = occt as GeometryKernel;
    const bonded = await conformal(kernel, [pair[0] ?? '', pair[1] ?? ''], 'conformal');
    expect(bonded.ok, bonded.error).toBe(true);
    expect(bonded.blocks.map((block) => block.entityId)).toEqual([pair[0], pair[1]]);
    const first = nodesOf(bonded, pair[0] ?? '');
    const second = nodesOf(bonded, pair[1] ?? '');
    const shared = [...first].filter((id) => second.has(id));
    expect(shared.length).toBeGreaterThan(8);
    const position = new Map(bonded.nodes.map((node) => [node[0], node[1]]));
    for (const id of shared) expect(position.get(id)).toBeCloseTo(10, 9); // lengthScale 1: STEP units
    // ids are contiguous and every node is used (no orphans)
    expect(bonded.nodes.map((node) => node[0])).toEqual(bonded.nodes.map((_, index) => index + 1));
    expect(first.size + second.size - shared.length).toBe(bonded.nodes.length);
    // the face target of the second part lies on the shared face: its face set holds elements of that part only
    const secondElements = new Set(bonded.blocks[1]?.elements.map((row) => row[0]));
    expect(bonded.faceSets['C_if']?.length).toBeGreaterThan(0);
    for (const [elementId] of bonded.faceSets['C_if'] ?? []) expect(secondElements.has(elementId ?? -1)).toBe(true);

    const separate = await conformal(kernel, [pair[0] ?? '', pair[1] ?? '']);
    expect(separate.ok, separate.error).toBe(true);
    expect([...nodesOf(separate, pair[0] ?? '')].filter((id) => nodesOf(separate, pair[1] ?? '').has(id))).toEqual([]);
  });

  it('refuses overlapping parts and STL geometry with a clear code', async (context) => {
    if (occt === null) context.skip();
    const overlap = await conformal(occt as GeometryKernel, [pair[0] ?? '', pair[2] ?? ''], 'conformal');
    expect(overlap).toMatchObject({ ok: false, code: 'FEA_BONDING_OVERLAP' });
    const stl = await conformal(manifold, [pair[0] ?? '', pair[1] ?? ''], 'conformal');
    expect(stl).toMatchObject({ ok: false, code: 'FEA_BONDING_UNSUPPORTED' });
    expect(stl.error).toContain('STEP');
  });
});
