import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import { LINEAR_LAYERS_REQUIRED, adequacyOf, inadequacyReasons, meshAdequacy } from '@cae/results/adequacy';
import { blockMesh, singleLayerTubeMesh, tubeMesh } from './adequacyFixtures';

/** The bounding-box heuristic that FR-INT-06 replaces (thinnest AABB side over the mean tet edge), kept here to show what it read. */
function legacyElementsAcross(mesh: FeMeshArtifact): number {
  const position = new Map(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]] as const]));
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let total = 0;
  let edges = 0;
  for (const element of mesh.blocks.flatMap((block) => block.elements)) {
    const points = element.slice(1, 5).map((id) => position.get(id) ?? [0, 0, 0]);
    points.forEach((point, index) => {
      point.forEach((value, axis) => {
        lo[axis] = Math.min(lo[axis] ?? Infinity, value);
        hi[axis] = Math.max(hi[axis] ?? -Infinity, value);
      });
      for (const other of points.slice(index + 1)) {
        total += Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]);
        edges += 1;
      }
    });
  }
  return Math.min(...hi.map((high, axis) => high - (lo[axis] ?? 0))) / (total / edges);
}
/** Two meshes as one (the second's node ids shifted), both blocks of the same part. */
/**  and  as one mesh (b's node ids shifted), both blocks of the same part. */
function union(a: FeMeshArtifact, b: FeMeshArtifact): FeMeshArtifact {
  const shift = 100000;
  return {
    ...a,
    nodes: [...a.nodes, ...b.nodes.map((node) => [node[0] + shift, node[1], node[2], node[3]] as const)],
    blocks: [
      ...a.blocks,
      ...b.blocks.map((block) => ({
        ...block,
        elements: block.elements.map((element, index) => [index + 100001, ...element.slice(1).map((id) => id + shift)]),
      })),
    ],
  };
}

/** A block whose thickness is `layers` hex-equivalent cells of side 5 mm (6 Kuhn tets per cell); the in-plane cells have the same side. */
const layered = (layers: number, quadratic = false): FeMeshArtifact => blockMesh([8, 8, layers], [40, 40, 5 * layers], { quadratic });

describe('meshAdequacy: element layers = hit distance / local element size (FR-INT-06)', () => {
  it.each([
    [1, 'inadequate'],
    [2, 'inadequate'],
    [4, 'adequate'],
    [6, 'adequate'],
  ] as const)('C3D4 block of %i hex-equivalent layers reads about its layer count and is %s', (layers, verdict) => {
    const part = meshAdequacy(layered(layers)).parts[0];
    expect(part?.elementsThrough).toBeGreaterThan(layers * 0.85);
    expect(part?.elementsThrough).toBeLessThan(layers * 1.15);
    expect(part?.verdict).toBe(verdict);
    expect(part?.tetsCrossed).toBe(3 * layers);
  });

  it('the tets-crossed rule that this replaces passed the 2-layer C3D4 block (6 tets crossed >= 4); the layer measure refuses it', () => {
    const part = meshAdequacy(layered(2)).parts[0];
    expect(part?.tetsCrossed).toBeGreaterThanOrEqual(LINEAR_LAYERS_REQUIRED);
    expect(part?.verdict).toBe('inadequate');
  });

  it('C3D10 needs 2 layers: 2 hex-equivalent layers are adequate, 1 is inadequate', () => {
    expect(meshAdequacy(layered(2, true)).parts[0]).toMatchObject({ order: 'quadratic', required: 2, verdict: 'adequate' });
    expect(meshAdequacy(layered(1, true)).parts[0]).toMatchObject({ order: 'quadratic', verdict: 'inadequate' });
  });
});

describe('meshAdequacy: layers through the wall of the actual tet mesh (FR-INT-06, VC-INT-12/13)', () => {
  it('a block with 4 cell layers through its thickness is adequate for C3D4; one layer (3 tets crossed) is inadequate', () => {
    const fine = meshAdequacy(blockMesh([12, 12, 4], [60, 60, 20]));
    expect(fine.verdict).toBe('adequate');
    expect(fine.parts[0]).toMatchObject({ entityId: 'block', order: 'linear', required: LINEAR_LAYERS_REQUIRED, tetsCrossed: 12 });
    expect(fine.parts[0]?.elementsThrough).toBeCloseTo(4, 6);
    const coarse = meshAdequacy(blockMesh([12, 12, 1], [60, 60, 5]));
    expect(coarse.verdict).toBe('inadequate');
    expect(coarse.parts[0]).toMatchObject({ tetsCrossed: 3 });
    expect(coarse.parts[0]?.elementsThrough).toBeCloseTo(1, 6);
  });

  it('VC-INT-13: a tube OD 100, wall 2, L 500 with one element through the wall is inadequate where the bounding-box heuristic read adequate', () => {
    for (const tube of [tubeMesh(100, 2, 500, { wallLayers: 1, around: 24, along: 20 }), singleLayerTubeMesh(100, 2, 500, 24, 20)]) {
      expect(legacyElementsAcross(tube)).toBeGreaterThan(2);
      const result = meshAdequacy(tube);
      expect(result.verdict).toBe('inadequate');
      expect(result.parts[0]?.elementsThrough).toBeLessThan(LINEAR_LAYERS_REQUIRED);
      expect(inadequacyReasons(result)[0]).toContain("part 'tube'");
    }
    expect(meshAdequacy(tubeMesh(40, 8, 20, { wallLayers: 6, around: 48, along: 10 })).verdict).toBe('adequate');
  });

  it('a thin spot under 5 % of the surface leaves the 5th percentile adequate but the verdict marginal', () => {
    const sliver = blockMesh([1, 1, 1], [3, 3, 1]);
    const result = meshAdequacy(union(blockMesh([20, 20, 4], [100, 100, 20]), sliver));
    expect(result.parts[0]).toMatchObject({ verdict: 'marginal' });
    expect(result.parts[0]?.elementsThrough).toBeCloseTo(4, 6);
    expect(result.parts[0]?.minimumLayers).toBeLessThan(0.75 * LINEAR_LAYERS_REQUIRED);
    expect(result.verdict).toBe('marginal');
  });

  it('quadratic tetrahedra need 2 layers: a single thin C3D10 is inadequate, a grid of cells is adequate; orders are reported separately', () => {
    const single = blockMesh([1, 1, 1], [40, 40, 1], { quadratic: true });
    const thin: FeMeshArtifact = {
      ...single,
      blocks: [{ ...(single.blocks[0] as FeMeshArtifact['blocks'][number]), elements: (single.blocks[0]?.elements ?? []).slice(0, 1) }],
    };
    expect(meshAdequacy(thin)).toMatchObject({ verdict: 'inadequate', parts: [{ order: 'quadratic', required: 2 }] });
    expect(meshAdequacy(blockMesh([6, 6, 2], [30, 30, 10], { quadratic: true })).verdict).toBe('adequate');
    const both = union(blockMesh([6, 6, 4], [30, 30, 20]), thin);
    expect(meshAdequacy(both).parts.map((part) => [part.order, part.verdict])).toEqual([
      ['linear', 'adequate'],
      ['quadratic', 'inadequate'],
    ]);
    expect(meshAdequacy(both).verdict).toBe('inadequate');
  });

  it('is deterministic and samples at most 400 faces of a large mesh', () => {
    const mesh = blockMesh([20, 20, 6], [100, 100, 30]);
    const first = meshAdequacy(mesh);
    expect(meshAdequacy(mesh)).toEqual(first);
    expect(first.parts[0]?.samples).toBeLessThanOrEqual(400);
    expect(first.parts[0]?.samples).toBeGreaterThanOrEqual(200);
  });

  it('measures a 21,600-element mesh quickly (O(E) indexing + O(400 x layers) rays)', () => {
    const mesh = blockMesh([20, 20, 9], [100, 100, 45]);
    expect(mesh.blocks[0]?.elements.length).toBeGreaterThanOrEqual(20000);
    const start = performance.now();
    const result = meshAdequacy(mesh);
    const elapsedMs = performance.now() - start;
    process.stdout.write(`meshAdequacy ${mesh.blocks[0]?.elements.length} elements: ${elapsedMs.toFixed(0)} ms\n`);
    expect(result.verdict).toBe('adequate');
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('skips tetrahedra with a missing node, lists parts without solid tetrahedra, and ignores zero-area faces', () => {
    const base = blockMesh([4, 4, 4], [20, 20, 20]);
    const broken: FeMeshArtifact = {
      ...base,
      blocks: [
        {
          type: 'C3D4',
          entityId: 'ghost',
          elements: [
            [1, 1, 2, 3, 99999],
            [2, 1, 2],
          ],
        },
        { type: 'S3', entityId: 'shell', elements: [[2, 1, 2, 3]] },
        ...base.blocks,
      ],
    };
    expect(meshAdequacy(broken)).toMatchObject({ verdict: 'adequate', unmeasuredParts: ['ghost', 'shell'] });
    expect(meshAdequacy({ ...base, blocks: [] })).toEqual({ verdict: 'adequate', parts: [], unmeasuredParts: [] });
    const squashed: FeMeshArtifact = { ...base, nodes: base.nodes.map((node) => [node[0], 0, 0, 0] as const) };
    expect(meshAdequacy(squashed)).toMatchObject({ parts: [], unmeasuredParts: ['block'] });
  });

  /** A flat pyramid S (apex 5) on the base 1-2-3 of a degenerate tetrahedron D (node 4 coincides with node 3, so two faces have no area). */
  const pyramidOnFlat = (flat: readonly number[]): FeMeshArtifact => ({
    ...blockMesh([1, 1, 1], [1, 1, 1]),
    nodes: [
      [1, 0, 0, 0],
      [2, 1, 0, 0],
      [3, 0, 1, 0],
      [4, 0, 1, 0],
      [5, 0.3, 0.3, 0.1],
    ],
    blocks: [
      {
        type: 'C3D4',
        entityId: 'flat',
        elements: [
          [1, 1, 2, 3, 5],
          [2, ...flat],
        ],
      },
    ],
  });

  it('a ray stops at a degenerate tetrahedron: no exit face leaves in its direction, or the exit makes no progress', () => {
    for (const flat of [
      [1, 2, 3, 4],
      [1, 3, 2, 4],
    ]) {
      const result = meshAdequacy(pyramidOnFlat(flat));
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0]?.samples).toBe(3);
      expect(result.parts[0]?.tetsCrossed).toBe(1);
      expect(Number.isFinite(result.parts[0]?.elementsThrough)).toBe(true);
    }
  });

  it('quadratic reasons name C3D10 and its budget', () => {
    const thin = blockMesh([1, 1, 1], [40, 40, 1], { quadratic: true });
    const reasons = inadequacyReasons(meshAdequacy(thin));
    expect(reasons[0]).toContain('C3D10 needs 2');
  });

  it('adequacyOf prefers the verdict recorded on the results, else measures the mesh', () => {
    const mesh = blockMesh([12, 12, 1], [60, 60, 5]);
    const recorded = { verdict: 'adequate' as const, parts: [], unmeasuredParts: [] };
    const results = { kind: 'fe_results' as const, meshHash: '', inputHash: '', solver: 's', solverVersion: '1', steps: [] };
    expect(adequacyOf({ ...results, adequacy: recorded }, mesh)).toBe(recorded);
    expect(adequacyOf(results, mesh).verdict).toBe('inadequate');
  });
});
