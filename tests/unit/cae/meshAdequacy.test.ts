import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import { LINEAR_LAYERS_REQUIRED, adequacyOf, blocksAssessment, inadequacyReasons, meshAdequacy } from '@cae/results/adequacy';
import { blockMesh, jitteredBlockMesh, singleLayerTubeMesh, tetVolumes, tubeMesh, unionMesh as union } from './adequacyFixtures';

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

  it('a thin spot of 2 layers on under 5 % of the surface leaves the 5th percentile adequate but the verdict marginal (a warning, not a gate)', () => {
    const sliver = blockMesh([2, 2, 2], [5, 5, 5]);
    const result = meshAdequacy(union(blockMesh([20, 20, 4], [100, 100, 20]), sliver));
    expect(result.parts[0]).toMatchObject({ verdict: 'marginal' });
    expect(result.parts[0]?.elementsThrough).toBeCloseTo(4, 6);
    expect(result.parts[0]?.minimumLayers).toBeLessThan(0.75 * LINEAR_LAYERS_REQUIRED);
    expect(result.parts[0]?.minimumLayers).toBeGreaterThanOrEqual(0.5 * LINEAR_LAYERS_REQUIRED);
    expect(result.verdict).toBe('marginal');
  });

  it('hard floor: a 1-layer rib on under 5 % of the faces of a fine block is inadequate although the 5th percentile reads 4 layers', () => {
    const block = blockMesh([20, 20, 4], [100, 100, 20]);
    const mesh = union(block, blockMesh([1, 1, 1], [3, 3, 1]));
    const ribFaces = 12;
    expect(ribFaces / (meshAdequacy(block).parts[0]?.samples ?? 1)).toBeLessThan(0.05);
    const result = meshAdequacy(mesh);
    expect(result.parts[0]?.minimumLayers).toBeLessThan(0.5 * LINEAR_LAYERS_REQUIRED);
    expect(result.parts[0]?.elementsThrough).toBeCloseTo(4, 6);
    expect(result.parts[0]?.verdict).toBe('inadequate');
    expect(result.verdict).toBe('inadequate');
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

  it('is deterministic; a boundary of up to 2,000 faces is measured on every face, a larger one on 3 faces per position x area bucket', () => {
    const small = blockMesh([10, 10, 6], [50, 50, 30]);
    expect(meshAdequacy(small).parts[0]?.samples).toBe(2 * (10 * 10 + 10 * 6 + 10 * 6) * 2);
    const mesh = blockMesh([20, 20, 6], [100, 100, 30]);
    const first = meshAdequacy(mesh);
    expect(meshAdequacy({ ...mesh })).toEqual(first);
    expect(first.parts[0]?.samples).toBeLessThan(2 * (20 * 20 + 20 * 6 + 20 * 6) * 2);
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

  it('the recorded verdict is display only: adequacyOf always measures the mesh (a forged adequate, an empty {} or no mesh gate as not adequate)', () => {
    const mesh = blockMesh([12, 12, 2], [60, 60, 10]);
    const results = { kind: 'fe_results' as const, meshHash: '', inputHash: '', solver: 's', solverVersion: '1', steps: [] };
    const forged = { verdict: 'adequate' as const, parts: [], unmeasuredParts: [] };
    expect(adequacyOf({ ...results, adequacy: forged }, mesh).verdict).toBe('inadequate');
    expect(adequacyOf({ ...results, adequacy: {} as unknown as typeof forged }, mesh).verdict).toBe('inadequate');
    expect(adequacyOf(results, mesh).verdict).toBe('inadequate');
    const none = adequacyOf({ ...results, adequacy: forged }, null);
    expect(none.verdict).toBe('unmeasured');
    expect(blocksAssessment(none)).toBe(true);
    expect(blocksAssessment(adequacyOf(results, mesh))).toBe(true);
    expect(blocksAssessment(adequacyOf(results, blockMesh([12, 12, 5], [60, 60, 25])))).toBe(false);
    expect(inadequacyReasons(none)[0]).toContain('not available');
  });

  it('memoizes the measure by the mesh object and by the verified mesh hash: a second call does not measure again', () => {
    const results = { kind: 'fe_results' as const, meshHash: 'abc123', inputHash: '', solver: 's', solverVersion: '1', steps: [] };
    const mesh = blockMesh([12, 12, 3], [60, 60, 15]);
    const first = adequacyOf(results, mesh);
    expect(adequacyOf(results, mesh)).toBe(first);
    expect(meshAdequacy(mesh)).toBe(first);
    expect(adequacyOf(results, { ...mesh })).toBe(first);
    expect(adequacyOf({ ...results, meshHash: 'other' }, { ...mesh })).not.toBe(first);
    const again: FeMeshAdequacy = meshAdequacy({ ...mesh });
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });
});

describe('meshAdequacy: calibration on unstructured meshes and documented conservatism', () => {
  it('jittered lattices (interior nodes displaced by up to 0.25 cell sides, no inverted tet) read within 15 % of the structured value and never cross the budget', () => {
    for (const layers of [2, 3, 4, 5]) {
      const jittered = jitteredBlockMesh([8, 8, layers], [40, 40, 5 * layers], 0.25);
      const structured = blockMesh([8, 8, layers], [40, 40, 5 * layers]);
      const reference = tetVolumes(structured);
      expect(tetVolumes(jittered).every((volume, index) => volume * (reference[index] as number) > 0)).toBe(true);
      expect(jittered.nodes).not.toEqual(structured.nodes);
      const read = meshAdequacy(jittered).parts[0];
      const base = meshAdequacy(structured).parts[0];
      process.stdout.write(
        `jittered ${layers} layers: p5 ${read?.elementsThrough.toFixed(3)} thinnest ${read?.minimumLayers.toFixed(3)} (structured ${base?.elementsThrough.toFixed(3)}, bias ${(((read?.elementsThrough ?? 0) / (base?.elementsThrough ?? 1) - 1) * 100).toFixed(1)} %)\n`,
      );
      expect(read?.elementsThrough).toBeGreaterThan((base?.elementsThrough ?? 0) * 0.85);
      expect(read?.elementsThrough).toBeLessThan((base?.elementsThrough ?? 0) * 1.15);
      if (layers === 2) expect(read?.elementsThrough).toBeLessThan(LINEAR_LAYERS_REQUIRED);
      if (layers === 5) expect(read?.elementsThrough).toBeGreaterThanOrEqual(LINEAR_LAYERS_REQUIRED);
    }
  });

  it('a slender section is governed by its thinnest dimension (conservative by design): a 10 x 40 beam with 3 layers through the 10 reads 3 although 40 mm carries 12', () => {
    const coarse = meshAdequacy(blockMesh([60, 12, 3], [200, 40, 10])).parts[0];
    expect(coarse?.elementsThrough).toBeGreaterThan(3 * 0.85);
    expect(coarse?.elementsThrough).toBeLessThan(3 * 1.15);
    expect(coarse?.verdict).toBe('inadequate');
    const fine = meshAdequacy(blockMesh([80, 16, 4], [200, 40, 10])).parts[0];
    expect(fine?.elementsThrough).toBeGreaterThan(4 * 0.85);
    expect(fine?.verdict).toBe('adequate');
  });

  it('rays lying in the Kuhn plane y = z cross the cell diagonal at a node / edge: they read the wall, never more and never zero (conservative early stop pinned)', () => {
    const cell = meshAdequacy(blockMesh([1, 1, 1], [1, 1, 1])).parts[0];
    expect(cell).toMatchObject({ samples: 12, tetsCrossed: 3 });
    expect(cell?.minimumLayers).toBeGreaterThan(0);
    expect(cell?.minimumLayers).toBeCloseTo(1, 9);
    expect(cell?.elementsThrough).toBeLessThanOrEqual(1 + 1e-9);
    const row = meshAdequacy(blockMesh([6, 1, 1], [6, 1, 1])).parts[0];
    expect(row?.minimumLayers).toBeCloseTo(1, 9);
    expect(row?.elementsThrough).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('measures a 200,000-element mesh in seconds with typed arrays (single run, generous bound; reports time and heap)', () => {
    const mesh = blockMesh([60, 60, 9], [60, 60, 9]);
    const elements = mesh.blocks[0]?.elements.length ?? 0;
    expect(elements).toBeGreaterThanOrEqual(190000);
    const before = process.memoryUsage().heapUsed;
    const start = performance.now();
    const result = meshAdequacy(mesh);
    const elapsedMs = performance.now() - start;
    const heapMb = (process.memoryUsage().heapUsed - before) / 2 ** 20;
    process.stdout.write(
      `meshAdequacy ${elements} elements: ${elapsedMs.toFixed(0)} ms, heap +${heapMb.toFixed(0)} MB, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB\n`,
    );
    expect(result.verdict).toBe('adequate');
    expect(result.parts[0]?.elementsThrough).toBeCloseTo(9, 1);
    expect(elapsedMs).toBeLessThan(10000);
  });
});
