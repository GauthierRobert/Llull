/** 07 MSH M1 commands: repair_mesh, fill_mesh_holes, decimate_mesh, remesh_mesh, smooth_mesh, cut_mesh and the symmetric measure_deviation. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cuboid, docWithMeshes, gridMesh, icosphere, packJson, relativeError, type IndexedMesh } from '../../helpers/meshFixtures';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const meshOf = (doc: CadDocument, id: string): MeshSolidEntity => doc.entities[id] as MeshSolidEntity;
const analyze = (doc: CadDocument, id: string): Data => dataOf(execute(doc, 'analyze_mesh', { id, selfIntersections: false }));
const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;

function defect(): IndexedMesh {
  const data = packJson('defect_mesh.json') as { positions: number[][]; faces: number[][] };
  return { positions: data.positions.flat(), indices: data.faces.flat() };
}

function holedGrid(): IndexedMesh {
  const grid = gridMesh(10, 10);
  const kept: number[] = [];
  for (let j = 0; j < 10; j++)
    for (let i = 0; i < 10; i++) {
      if ((i === 4 || i === 5) && (j === 4 || j === 5)) continue;
      kept.push(...grid.indices.slice((j * 10 + i) * 6, (j * 10 + i) * 6 + 6));
    }
  return { positions: grid.positions, indices: kept };
}

describe('repair_mesh', () => {
  it('repairs the defect mesh with the plan steps: stitch + small shells, fill, orient (VC-MSH-04)', () => {
    const { doc, ids } = docWithMeshes(defect());
    const id = ids[0] as string;
    const before = analyze(doc, id);
    expect([
      before['faces'],
      before['duplicateFaces'],
      before['degenerateFaces'],
      before['boundaryLoopCount'],
      before['shellCount'],
    ]).toEqual([326, 2, 1, 1, 2]);
    const stitched = execute(doc, 'repair_mesh', { id, mode: 'stitch', removeSmallComponents: { maxFaces: 10 } });
    expect(stitched.error).toBeUndefined();
    expect(stitched.affected).toEqual([id]);
    expect(dataOf(stitched)['changes']).toMatchObject({ duplicatesRemoved: 2, degenerateRemoved: 1, componentsRemoved: 1 });
    expect(dataOf(stitched)['deviation']).toMatchObject({ unit: 'mm' });
    const filled = execute(stitched.document, 'fill_mesh_holes', { id, holes: 'all', fairing: 'none' });
    expect(filled.error).toBeUndefined();
    const oriented = execute(filled.document, 'repair_mesh', { id, mode: 'orient' });
    expect(dataOf(oriented)['changes']).toMatchObject({ flipped: 3 });
    const after = analyze(oriented.document, id);
    expect([after['faces'], after['closed'], after['orientationConsistent']]).toEqual([320, true, true]);
    expect(relativeError(after['volume'] as number, 4047.04467998)).toBeLessThan(1e-9);
    expect(relativeError(after['area'] as number, 1232.98485952)).toBeLessThan(1e-9);
    expect(oriented.document.order).toEqual([id]);
    expect(meshOf(oriented.document, id).meshSource).toMatchObject({ format: 'generated', verified: false });
  });

  it('close_holes does stitch + plain fill in one call; keepSource adds a new mesh and lists named defaults', () => {
    const { doc, ids } = docWithMeshes(defect());
    const result = execute(doc, 'repair_mesh', {
      id: ids[0] as string,
      mode: 'close_holes',
      keepSource: true,
      removeSmallComponents: { maxFaces: 10 },
    });
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).not.toBe(ids[0]);
    expect(result.document.order).toEqual([ids[0], result.affected[0]]);
    expect(dataOf(result)['changes']).toMatchObject({ holesFilled: 1 });
    expect(dataOf(result)['closed']).toBe(true);
    const names = (dataOf(result)['defaults'] as Array<{ name: string }>).map((d) => d.name);
    expect(names).toEqual(['weldTolerance', 'maxGap']);
    expect(result.summary).toContain('close_holes');
  });

  it('weld and clean report their counts, and a clean mesh reports nothing to change', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [1, 1, 1]));
    const same = execute(doc, 'repair_mesh', { id: ids[0] as string, mode: 'clean', weldTolerance: 1e-6 });
    expect(same.summary).toContain('nothing to change');
    expect(dataOf(same)['defaults']).toEqual([]);
    const welded = execute(doc, 'repair_mesh', { id: ids[0] as string, mode: 'weld' });
    expect(welded.error).toBeUndefined();
  });

  it('refuses unknown ids and 2D shapes without touching the document, and is pure', () => {
    const { doc, ids } = docWithMeshes(defect());
    const unknown = execute(doc, 'repair_mesh', { id: 'nope', mode: 'clean' });
    expectNoOp(unknown, doc);
    expect(codeOf(unknown)).toBe('MESH_ENTITY_NOT_FOUND');
    const circle = execute(createEmptyDocument(), 'draw_polyline', {
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      closed: true,
    });
    const flat = execute(circle.document, 'repair_mesh', { id: circle.affected[0] as string, mode: 'clean' });
    expect(codeOf(flat)).toBe('MESH_NOT_A_MESH');
    expectPure(doc, () => execute(doc, 'repair_mesh', { id: ids[0] as string, mode: 'stitch' }));
  });
});

describe('fill_mesh_holes', () => {
  it('fills the planar 8-edge loop with 6 triangles; the grid is area 100 again (VC-MSH-05)', () => {
    const { doc, ids } = docWithMeshes(holedGrid());
    const id = ids[0] as string;
    const result = execute(doc, 'fill_mesh_holes', { id, holes: [1], fairing: 'none' });
    expect(result.error).toBeUndefined();
    const filled = dataOf(result)['filled'] as Array<{ loop: number; edges: number; triangles: number; area: number }>;
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ loop: 1, edges: 8, triangles: 6 });
    expect(Math.abs((filled[0] as { area: number }).area - 4)).toBeLessThan(1e-9);
    expect(Math.abs((dataOf(result)['area'] as number) - 100)).toBeLessThan(1e-9);
    const after = analyze(result.document, id);
    expect(after['boundaryEdges']).toBe(40);
    expect(result.summary).toContain('1 loop(s) filled');
    expect(result.affected).toEqual([id]);
  });

  it('selects holes by point, fills all, skips loops over maxBoundaryEdges and reports them', () => {
    const { doc, ids } = docWithMeshes(holedGrid());
    const id = ids[0] as string;
    const byPoint = execute(doc, 'fill_mesh_holes', { id, holes: [{ near: [5, 5, 0] }], fairing: 'curvature' });
    expect((dataOf(byPoint)['filled'] as unknown[]).length).toBe(1);
    const all = execute(doc, 'fill_mesh_holes', { id });
    expect(analyze(all.document, id)['closed']).toBe(true);
    expect(dataOf(all)['fairing']).toBe('curvature');
    const limited = execute(doc, 'fill_mesh_holes', { id, maxBoundaryEdges: 10 });
    expect(dataOf(limited)['skipped']).toEqual([{ loop: 0, edges: 40, code: 'MESH_HOLE_TOO_LARGE' }]);
    expect(limited.summary).toContain('skipped');
    expect(analyze(limited.document, id)['closed']).toBe(false);
  });

  it('leaves a closed mesh unchanged, refuses unknown loops and explicitly chosen loops that are too large; is pure', () => {
    const closed = docWithMeshes(icosphere(10, 2));
    const nothing = execute(closed.doc, 'fill_mesh_holes', { id: closed.ids[0] as string });
    expect(nothing.error).toBeUndefined();
    expect(nothing.affected).toEqual([closed.ids[0]]);
    expect(dataOf(nothing)).toMatchObject({ totalLoops: 0, filled: [], closed: true });
    expect(nothing.summary).toContain('0 loop(s) filled');
    expect(codeOf(execute(closed.doc, 'fill_mesh_holes', { id: closed.ids[0] as string, holes: [0] }))).toBe('MESH_HOLE_NOT_FOUND');
    const { doc, ids } = docWithMeshes(holedGrid());
    const id = ids[0] as string;
    const missing = execute(doc, 'fill_mesh_holes', { id, holes: [9] });
    expectNoOp(missing, doc);
    expect(codeOf(missing)).toBe('MESH_HOLE_NOT_FOUND');
    expect(codeOf(execute(doc, 'fill_mesh_holes', { id, holes: [0], maxBoundaryEdges: 10 }))).toBe('MESH_HOLE_TOO_LARGE');
    expect(codeOf(execute(doc, 'fill_mesh_holes', { id: 'nope' }))).toBe('MESH_ENTITY_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'fill_mesh_holes', { id }));
  });
});

describe('decimate_mesh', () => {
  it('reduces a sphere to a triangle target, stays closed and reports the deviation both ways', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 3));
    const id = ids[0] as string;
    const result = execute(doc, 'decimate_mesh', { id, targetTriangles: 300 });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    expect(data).toMatchObject({ trianglesBefore: 1280, reachedTarget: true, stoppedBy: 'target', closed: true });
    expect(data['faces'] as number).toBeLessThanOrEqual(300);
    expect(data['deviation']).toMatchObject({ unit: 'mm' });
    expect((data['deviation'] as { hausdorff: number }).hausdorff).toBeGreaterThan(0);
    expect(data['warnings']).toEqual([]);
    expect(result.summary).toContain('1280 ->');
    const ratio = execute(doc, 'decimate_mesh', { id, ratio: 0.25 });
    expect(dataOf(ratio)['faces'] as number).toBeLessThanOrEqual(320);
  });

  it('keeps the bound: maxDeviation 0.05 on the l4 icosphere never exceeds it in either direction (VC-MSH-07)', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const result = execute(doc, 'decimate_mesh', { id: ids[0] as string, maxDeviation: 0.05 });
    const deviation = dataOf(result)['deviation'] as { forwardMax: number; backwardMax: number };
    expect(deviation.forwardMax).toBeLessThanOrEqual(0.05);
    expect(deviation.backwardMax).toBeLessThanOrEqual(0.05);
    expect(dataOf(result)['stoppedBy']).toBe('deviation_or_validity');
  });

  it('warns MESH_TARGET_UNREACHABLE when a locked boundary stops it first, and refuses with requireTarget', () => {
    const { doc, ids } = docWithMeshes(gridMesh(10, 12));
    const id = ids[0] as string;
    const warned = execute(doc, 'decimate_mesh', { id, targetTriangles: 40 });
    expect(dataOf(warned)['reachedTarget']).toBe(false);
    expect((dataOf(warned)['warnings'] as Array<{ code: string }>)[0]?.code).toBe('MESH_TARGET_UNREACHABLE');
    expect(Math.abs((dataOf(warned)['area'] as number) - 100)).toBeLessThan(1e-9);
    const strict = execute(doc, 'decimate_mesh', { id, targetTriangles: 40, requireTarget: true });
    expectNoOp(strict, doc);
    expect(codeOf(strict)).toBe('MESH_TARGET_UNREACHABLE');
  });

  it('refuses a missing or contradictory stop rule, a target at or above the current count, and meshes that are not editable', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 1));
    const id = ids[0] as string;
    expect(codeOf(execute(doc, 'decimate_mesh', { id }))).toBe('MESH_PARAM_INVALID');
    expect(codeOf(execute(doc, 'decimate_mesh', { id, targetTriangles: 10, ratio: 0.5 }))).toBe('MESH_PARAM_INVALID');
    expect(codeOf(execute(doc, 'decimate_mesh', { id, targetTriangles: 500 }))).toBe('MESH_PARAM_INVALID');
    expect(codeOf(execute(doc, 'decimate_mesh', { id: 'nope', targetTriangles: 5 }))).toBe('MESH_ENTITY_NOT_FOUND');
    const messy = docWithMeshes(defect());
    expect(codeOf(execute(messy.doc, 'decimate_mesh', { id: messy.ids[0] as string, targetTriangles: 100 }))).toMatch(
      /MESH_(NON_MANIFOLD|DEGENERATE|ORIENTATION_INCONSISTENT)/,
    );
    const box = cuboid([0, 0, 0], [1, 1, 1]);
    const flipped = { positions: box.positions, indices: [...box.indices] };
    [flipped.indices[1], flipped.indices[2]] = [flipped.indices[2] as number, flipped.indices[1] as number];
    const inconsistent = docWithMeshes(flipped);
    expect(codeOf(execute(inconsistent.doc, 'decimate_mesh', { id: inconsistent.ids[0] as string, targetTriangles: 6 }))).toBe(
      'MESH_ORIENTATION_INCONSISTENT',
    );
    expectPure(doc, () => execute(doc, 'decimate_mesh', { id, targetTriangles: 20 }));
  });

  it('accepts feature protection, a locked region and a free boundary', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 2));
    const id = ids[0] as string;
    const result = execute(doc, 'decimate_mesh', {
      id,
      targetTriangles: 100,
      preserveFeatureAngleDeg: 30,
      lockedRegion: { center: [0, 0, 10], radius: 4 },
      preserveBoundary: false,
      keepSource: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.document.order).toHaveLength(2);
  });
});

describe('remesh_mesh', () => {
  it('remeshes the l4 icosphere to L = 1 (VC-MSH-10): edges inside the band, deviation reported', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const id = ids[0] as string;
    const result = execute(doc, 'remesh_mesh', { id, targetEdgeLength: 1, iterations: 5, preserveFeatureAngleDeg: 40 });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    const edges = data['edgeLength'] as { min: number; max: number; mean: number };
    expect(edges.max).toBeLessThanOrEqual((4 / 3) * (1 + 1e-9));
    expect(edges.mean).toBeGreaterThan(0.85);
    expect(data['fractionInBand'] as number).toBeGreaterThan(0.5);
    expect(data['closed']).toBe(true);
    expect(data['edgeBand']).toEqual({ min: 0.8, max: (4 / 3) * 1 });
    expect(data['mode']).toBe('isotropic');
    expect((data['deviation'] as { hausdorff: number }).hausdorff).toBeLessThan(0.05);
    expect(result.summary).toContain('in band');
    // AC-08 as amended: radial deficit from the TRUE sphere of the vertices (<= input sag) and of the triangle centres (<= Jung bound + input sag)
    const input = icosphere(10, 4);
    let longest = 0;
    for (let f = 0; f < input.indices.length; f += 3)
      for (let k = 0; k < 3; k++) {
        const a = (input.indices[f + k] as number) * 3;
        const b = (input.indices[f + ((k + 1) % 3)] as number) * 3;
        longest = Math.max(
          longest,
          Math.hypot(...[0, 1, 2].map((i) => (input.positions[a + i] as number) - (input.positions[b + i] as number))),
        );
      }
    const sag = (edge: number): number => 10 - Math.sqrt(100 - edge ** 2 / 3);
    const mesh = (result.document.entities[id] as MeshSolidEntity).mesh;
    const at = (v: number): number[] => [0, 1, 2].map((i) => mesh.positions[v * 3 + i] as number);
    let vertexDeficit = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) vertexDeficit = Math.max(vertexDeficit, 10 - Math.hypot(...at(v)));
    let centreDeficit = 0;
    for (let f = 0; f < mesh.indices.length; f += 3) {
      const c = [0, 1, 2].map(
        (i) => ([0, 1, 2] as number[]).reduce((sum, k) => sum + (at(mesh.indices[f + k] as number)[i] as number), 0) / 3,
      );
      centreDeficit = Math.max(centreDeficit, 10 - Math.hypot(...c));
    }
    const jung = sag((4 / 3) * 1);
    expect(jung).toBeCloseTo(0.0296736559, 9);
    expect(vertexDeficit).toBeLessThanOrEqual(sag(longest) + 1e-9);
    expect(centreDeficit).toBeLessThanOrEqual(jung + sag(longest) + 1e-9);
  });

  it('remeshes adaptively and a region only', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 3));
    const id = ids[0] as string;
    const adaptive = execute(doc, 'remesh_mesh', { id, minEdge: 0.5, maxEdge: 3, approxError: 0.02, iterations: 3, project: false });
    expect(adaptive.error).toBeUndefined();
    expect(dataOf(adaptive)['mode']).toBe('adaptive');
    const local = execute(doc, 'remesh_mesh', {
      id,
      targetEdgeLength: 0.8,
      iterations: 2,
      region: { center: [0, 0, 10], radius: 3 },
      keepSource: true,
    });
    expect(local.document.order).toHaveLength(2);
  });

  it('refuses neither or both length modes, partial adaptive input, an oversized edge, and meshes that are not editable; is pure', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 2));
    const id = ids[0] as string;
    expect(codeOf(execute(doc, 'remesh_mesh', { id }))).toBe('MESH_PARAM_INVALID');
    expect(codeOf(execute(doc, 'remesh_mesh', { id, targetEdgeLength: 1, maxEdge: 2 }))).toBe('MESH_PARAM_INVALID');
    expect(codeOf(execute(doc, 'remesh_mesh', { id, minEdge: 0.5, maxEdge: 2 }))).toBe('MESH_PARAM_INVALID');
    expect(codeOf(execute(doc, 'remesh_mesh', { id, minEdge: 3, maxEdge: 2, approxError: 0.1 }))).toBe('MESH_PARAM_INVALID');
    const huge = execute(doc, 'remesh_mesh', { id, targetEdgeLength: 10 });
    expectNoOp(huge, doc);
    expect(codeOf(huge)).toBe('MESH_REMESH_EDGE_TOO_LARGE');
    const negative = execute(doc, 'remesh_mesh', { id, targetEdgeLength: -1 });
    expect(negative.rejected).toBe(true);
    const messy = docWithMeshes(defect());
    expect(codeOf(execute(messy.doc, 'remesh_mesh', { id: messy.ids[0] as string, targetEdgeLength: 2 }))).toMatch(
      /MESH_(NON_MANIFOLD|DEGENERATE|ORIENTATION_INCONSISTENT)/,
    );
    expectPure(doc, () => execute(doc, 'remesh_mesh', { id, targetEdgeLength: 2, iterations: 1 }));
  });
});

describe('smooth_mesh', () => {
  it('smooths with Taubin and volume correction: size kept, displacement reported (VC-MSH-08)', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const id = ids[0] as string;
    const plain = execute(doc, 'smooth_mesh', { id, method: 'taubin', iterations: 10, volumeCorrection: false });
    expect(plain.error).toBeUndefined();
    expect(relativeError(dataOf(plain)['volume'] as number, 4194.296062)).toBeLessThan(1e-9);
    expect(dataOf(plain)['mu'] as number).toBeCloseTo(-0.6731559455, 9);
    const corrected = execute(doc, 'smooth_mesh', { id, iterations: 50 });
    expect(relativeError(dataOf(corrected)['volume'] as number, 4179.738948)).toBeLessThan(1e-9);
    expect(dataOf(corrected)['volumeCorrected']).toBe(true);
    const lap = execute(doc, 'smooth_mesh', { id, method: 'laplacian', iterations: 10, volumeCorrection: false });
    expect(relativeError(dataOf(lap)['volume'] as number, 3959.755524)).toBeLessThan(1e-9);
    expect(dataOf(lap)['mu']).toBeNull();
    expect(plain.summary).toContain('taubin x10');
    const defaults = (dataOf(corrected)['defaults'] as Array<{ name: string }>).map((d) => d.name);
    expect(defaults).toEqual(['lambda', 'passBand']);
  });

  it('accepts cotangent weights, regions and free boundaries; refuses a pass band above 1/lambda; is pure', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 3));
    const id = ids[0] as string;
    const result = execute(doc, 'smooth_mesh', {
      id,
      weights: 'cotangent',
      region: { center: [0, 0, 10], radius: 4 },
      fixBoundary: false,
      iterations: 2,
      lambda: 0.5,
      passBand: 0.1,
      keepSource: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.document.order).toHaveLength(2);
    const bad = execute(doc, 'smooth_mesh', { id, lambda: 0.5, passBand: 3 });
    expectNoOp(bad, doc);
    expect(codeOf(bad)).toBe('MESH_PARAM_INVALID');
    expect(codeOf(execute(doc, 'smooth_mesh', { id: 'nope' }))).toBe('MESH_ENTITY_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'smooth_mesh', { id }));
  });
});

describe('cut_mesh', () => {
  const unit = (): { doc: CadDocument; id: string } => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [1, 1, 1]));
    return { doc, id: ids[0] as string };
  };

  it('keeps the negative side of x + y + z = 1.5 with a hexagonal cap (VC-MSH-17)', () => {
    const { doc, id } = unit();
    const result = execute(doc, 'cut_mesh', { id, plane: { origin: [0.5, 0.5, 0.5], normal: [1, 1, 1] }, keep: 'negative' });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    expect(result.affected).toEqual([id]);
    expect(relativeError((data['volumes'] as { negative: number }).negative, 0.5)).toBeLessThan(1e-12);
    expect(relativeError((data['capArea'] as { negative: number }).negative, (3 * Math.sqrt(3)) / 4)).toBeLessThan(1e-12);
    expect(data).toMatchObject({ cap: true, inputClosed: true, loops: 1, unit: 'mm' });
    expect(analyze(result.document, id)['closed']).toBe(true);
  });

  it('keep both rewrites the source as the positive half and adds the negative half (x = 0.25)', () => {
    const { doc, id } = unit();
    const result = execute(doc, 'cut_mesh', { id, plane: { origin: [0.25, 0, 0], normal: [1, 0, 0] }, keep: 'both' });
    expect(result.affected).toHaveLength(2);
    expect(result.affected[0]).toBe(id);
    expect(result.document.order).toEqual(result.affected);
    const volumes = dataOf(result)['volumes'] as { positive: number; negative: number };
    expect(relativeError(volumes.positive, 0.75)).toBeLessThan(1e-12);
    expect(relativeError(volumes.negative, 0.25)).toBeLessThan(1e-12);
    const kept = execute(doc, 'cut_mesh', { id, plane: { origin: [0.25, 0, 0], normal: [1, 0, 0] }, keep: 'both', keepSource: true });
    expect(kept.document.order).toHaveLength(3);
    expect(kept.document.order[0]).toBe(id);
  });

  it('leaves the section open with cap false, and refuses a plane that misses, a zero normal and unknown ids; is pure', () => {
    const { doc, id } = unit();
    const open = execute(doc, 'cut_mesh', { id, plane: { origin: [0.5, 0, 0], normal: [1, 0, 0] }, cap: false });
    expect(analyze(open.document, id)['closed']).toBe(false);
    expect(open.summary).toContain('uncapped');
    const misses = execute(doc, 'cut_mesh', { id, plane: { origin: [5, 0, 0], normal: [1, 0, 0] } });
    expectNoOp(misses, doc);
    expect(codeOf(misses)).toBe('MESH_CUT_MISSES');
    expect(codeOf(execute(doc, 'cut_mesh', { id, plane: { origin: [0.5, 0, 0], normal: [0, 0, 0] } }))).toBe('MESH_PARAM_INVALID');
    expect(codeOf(execute(doc, 'cut_mesh', { id: 'nope', plane: { origin: [0, 0, 0], normal: [1, 0, 0] } }))).toBe('MESH_ENTITY_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'cut_mesh', { id, plane: { origin: [0.5, 0, 0], normal: [1, 0, 0] }, keep: 'both' }));
  });
});

describe('measure_deviation symmetric (VC-MSH-25)', () => {
  it('two parallel grids 0.5 apart: Hausdorff = mean = rms = 0.5, with tolerance verdict', () => {
    const a = gridMesh(10, 10);
    const b = { positions: a.positions.map((v, i) => (i % 3 === 2 ? v + 0.5 : v)), indices: a.indices };
    const { doc, ids } = docWithMeshes(a, b);
    const result = execute(doc, 'measure_deviation', {
      id: ids[0] as string,
      referenceId: ids[1] as string,
      symmetric: true,
      tolerance: 0.6,
    });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    for (const key of ['hausdorff', 'forwardMax', 'backwardMax', 'mean', 'rms'])
      expect(Math.abs((data[key] as number) - 0.5)).toBeLessThan(1e-12);
    expect(data).toMatchObject({ symmetric: true, pass: true, unit: 'mm', unverified: true });
    expect((data['histogram'] as number[])[9]).toBe(data['samples']);
    const failing = execute(doc, 'measure_deviation', {
      id: ids[0] as string,
      referenceId: ids[1] as string,
      symmetric: true,
      tolerance: 0.4,
    });
    expect(dataOf(failing)['pass']).toBe(false);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('refuses points, a missing reference, unknown ids and 2D shapes', () => {
    const { doc, ids } = docWithMeshes(gridMesh(10, 4), gridMesh(10, 4));
    const id = ids[0] as string;
    expect(execute(doc, 'measure_deviation', { id, symmetric: true, points: [[0, 0, 0]] }).rejected).toBe(true);
    expect(execute(doc, 'measure_deviation', { id, symmetric: true }).rejected).toBe(true);
    expect(codeOf(execute(doc, 'measure_deviation', { id: 'nope', referenceId: id, symmetric: true }))).toBe('MESH_ENTITY_NOT_FOUND');
    expect(codeOf(execute(doc, 'measure_deviation', { id, referenceId: 'nope', symmetric: true }))).toBe('MESH_ENTITY_NOT_FOUND');
    expectPure(doc, () => execute(doc, 'measure_deviation', { id, referenceId: ids[1] as string, symmetric: true }));
  });
});
