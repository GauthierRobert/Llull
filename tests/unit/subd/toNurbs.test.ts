import { describe, expect, it } from 'vitest';
import { type CadDocument, type NurbsSurfaceEntity, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { defaultContext } from '@core/commands/context';
import type { GeometryKernel } from '@core/geometry/kernel';
import { evaluateSurface } from '@lib/nurbs/surface';
import { boxCage, subdivide } from '@core/geometry/subdivision';
import { cageVertexLimits, prepare } from '@core/geometry/subd/limit';
import { blockSurface, packedBlocks } from '@core/geometry/subd/packedGrids';
import { cageToNurbs, patchSurface } from '@core/geometry/subd/toNurbs';
import { subdivisionPatches, patchPoint } from '@core/geometry/subdivisionPatches';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();
const run = (doc: CadDocument, name: string, params: object, ctx?: Parameters<typeof execute>[3]): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>, ctx);
const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
const dataOf = <T>(result: ReturnType<typeof execute>): T => result.data as T;
const cube = run(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 3, id: 'c' });

/** Torus cage with `major` x `minor` quads wound outward. */
function torusCage(major: number, minor: number): { vertices: Vec3[]; faces: number[][] } {
  const vertices: Vec3[] = [];
  for (let i = 0; i < major; i++)
    for (let j = 0; j < minor; j++) {
      const [a, b] = [(2 * Math.PI * i) / major, (2 * Math.PI * j) / minor];
      const radius = 3 + Math.cos(b);
      vertices.push([radius * Math.cos(a), radius * Math.sin(a), Math.sin(b)]);
    }
  const at = (i: number, j: number): number => (i % major) * minor + (j % minor);
  const faces: number[][] = [];
  for (let i = 0; i < major; i++) for (let j = 0; j < minor; j++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  return { vertices, faces };
}

describe('subdivision_to_nurbs sheets (VC-DIR-08, 09)', () => {
  it('turns the cube into 24 unpacked bicubic sheets with gap-free seams and a measured tangent break', () => {
    const result = run(cube.document, 'subdivision_to_nurbs', { id: 'c' });
    expect(result.affected).toHaveLength(24);
    expect(result.document.entities['c']).toBeUndefined();
    expect(result.document.order).toEqual(result.affected);
    const sheet = result.document.entities[result.affected[0] as string] as NurbsSurfaceEntity;
    expect(sheet.kind).toBe('nurbs_surface');
    expect([sheet.surface.degreeU, sheet.surface.degreeV, sheet.surface.poles.length]).toEqual([3, 3, 4]);
    const data = dataOf<{
      patchCount: number;
      maxDeviation: number;
      maxEvG0: number;
      maxEvG1Deg: number;
      evEdges: unknown[];
      starPoints: Array<{ id: string; valence: number }>;
      sheets: string[];
    }>(result);
    expect(data.patchCount).toBe(24);
    expect(data.sheets).toEqual(result.affected);
    expect(data.maxEvG0).toBeLessThan(1e-12);
    expect(data.maxEvG1Deg).toBeGreaterThan(0.5);
    expect(data.maxEvG1Deg).toBeLessThan(5);
    expect(data.maxDeviation).toBeLessThan(0.01);
    expect(data.evEdges.length).toBeGreaterThan(0);
    expect(data.starPoints).toHaveLength(8);
    expect(data.starPoints.every((p) => p.valence === 3)).toBe(true);
    expect(result.summary).toContain('24 nurbs_surface');
  });

  it('skips samples the limit evaluator can only approximate (creased cage)', () => {
    const creased = run(cube.document, 'edit_subdivision_cage', { id: 'c', crease: true });
    const result = run(creased.document, 'subdivision_to_nurbs', { id: 'c', samples: 16 });
    expect(dataOf<{ skippedSamples: number }>(result).skippedSamples).toBeGreaterThan(0);
  });

  it('G1 fits the interior poles first (24 patches, break 2.6 -> 0.05 degrees), then refines only when the tolerance is still not met', () => {
    const fitted = dataOf<{ maxEvG1Deg: number; maxEvG0: number; patchCount: number; extraordinary: string }>(
      run(cube.document, 'subdivision_to_nurbs', { id: 'c', extraordinary: 'G1', tangentToleranceDeg: 1.5 }),
    );
    expect(fitted.extraordinary).toBe('G1');
    expect(fitted.patchCount).toBe(24);
    expect(fitted.maxEvG1Deg).toBeLessThan(0.06);
    expect(fitted.maxEvG0).toBe(0);
    const tighter = dataOf<{ maxEvG1Deg: number; patchCount: number }>(
      run(cube.document, 'subdivision_to_nurbs', { id: 'c', extraordinary: 'G1', tangentToleranceDeg: 0.01 }),
    );
    expect(tighter.patchCount).toBeGreaterThan(24);
    expect(tighter.maxEvG1Deg).toBeLessThanOrEqual(0.01);
  });

  it('keeps the SubD with keep and inherits placement', () => {
    const placed = run(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2] }, id: 'p', position: [5, 0, 0], rotation: [0, 0, 0.5] });
    const result = run(placed.document, 'subdivision_to_nurbs', { id: 'p', keep: true });
    expect(result.document.entities['p']).toBeDefined();
    const sheet = result.document.entities[result.affected[0] as string] as NurbsSurfaceEntity;
    expect(sheet.position).toEqual([5, 0, 0]);
    expect(sheet.rotation).toEqual([0, 0, 0.5]);
    expect(result.document.order).toHaveLength(25);
  });

  it('every patch of an extraordinary star shares the limit tangent plane at the vertex, and G1 refines the edge break below the tolerance', () => {
    const base = boxCage([2, 2, 2], [1, 1, 1]);
    const skewed = { ...base, vertices: base.vertices.map((p, v): Vec3 => (v === 0 ? [p[0] - 0.5, p[1] - 0.2, p[2] - 0.3] : p)) };
    const refined = subdivide(skewed, 1);
    const result = cageToNurbs(skewed, { packed: false, samples: 3 });
    const limit = cageVertexLimits(refined, [0])[0]!;
    const normals = result.surfaces.flatMap((surface, f) => {
      const k = (refined.faces[f] as number[]).indexOf(0);
      if (k < 0) return [];
      const [u, v] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ][k] as [number, number];
      const h = 1e-5;
      const [su, sv] = [u === 0 ? h : -h, v === 0 ? h : -h];
      const at = evaluateSurface(surface, u, v);
      const du = evaluateSurface(surface, u + su, v).map((x, i) => (x - at[i]!) / su) as unknown as Vec3;
      const dv = evaluateSurface(surface, u, v + sv).map((x, i) => (x - at[i]!) / sv) as unknown as Vec3;
      const n: Vec3 = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
      return [n.map((x) => x / Math.hypot(...n)) as unknown as Vec3];
    });
    expect(normals).toHaveLength(3);
    for (const n of normals)
      expect(Math.abs(n[0] * limit.normal[0] + n[1] * limit.normal[1] + n[2] * limit.normal[2])).toBeGreaterThan(1 - 1e-8);
    const coarse = cageToNurbs(skewed, { packed: false, samples: 2 });
    const fine = cageToNurbs(skewed, { packed: false, samples: 2, tangentToleranceDeg: 0.5 });
    expect(coarse.maxEvG1Deg).toBeGreaterThan(0.5);
    expect(fine.maxEvG1Deg).toBeLessThanOrEqual(0.5);
    expect(fine.refineLevels).toBeGreaterThan(coarse.refineLevels);
    expect(fine.maxEvG0).toBeLessThan(1e-12);
    expect(fine.maxDeviation).toBeLessThan(coarse.maxDeviation);
  });

  it('packs the regular region of a segmented box into B-spline blocks that equal the limit surface', () => {
    const doc = run(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2], segments: [3, 3, 3] }, levels: 2, id: 's' });
    const unpacked = run(doc.document, 'subdivision_to_nurbs', { id: 's' });
    const packed = run(doc.document, 'subdivision_to_nurbs', { id: 's', faces: 'packed' });
    const counts = [unpacked.affected.length, packed.affected.length];
    expect(counts[1]).toBeLessThan(counts[0] as number);
    const info = dataOf<{ packedBlocks: number; packedQuads: number; maxDeviation: number }>(packed);
    expect(info.packedBlocks).toBeGreaterThan(0);
    expect(info.packedQuads).toBeGreaterThan(info.packedBlocks);
    expect(info.maxDeviation).toBeLessThan(0.01);
  });

  it('a block surface equals the limit points of its lattice (uniform cubic at integer knots)', () => {
    const { vertices, faces } = torusCage(8, 6);
    const cage = { vertices, faces, creases: [] };
    const refined = subdivide(cage, 1);
    const blocks = packedBlocks(prepare(refined));
    const biggest = blocks.reduce((a, b) => (b.quads.length > a.quads.length ? b : a));
    expect(biggest.quads.length).toBeGreaterThan(8);
    const surface = blockSurface(biggest, refined.vertices);
    expect(surface.poles).toHaveLength(biggest.rows + 3);
    for (let p = 0; p <= biggest.rows; p++)
      for (let q = 0; q <= biggest.columns; q++) {
        const id = biggest.lattice[p + 1]![q + 1] as number;
        const limit = cageVertexLimits(refined, [id])[0]!.point;
        const point = evaluateSurface(surface, p, q);
        expect(Math.hypot(point[0] - limit[0], point[1] - limit[1], point[2] - limit[2])).toBeLessThan(1e-12);
      }
  });

  it('a fully regular torus converts with zero deviation (VC-DIR-08)', () => {
    const { vertices, faces } = torusCage(8, 6);
    const result = cageToNurbs({ vertices, faces, creases: [] }, { packed: false, samples: 4 });
    expect(result.patchCount).toBe(8 * 6 * 4);
    expect(result.maxDeviation).toBeLessThan(1e-9);
    expect(result.maxEvG1Deg).toBeLessThan(1e-9);
    expect(result.evEdges).toHaveLength(0);
    const patches = subdivisionPatches({ vertices, faces, creases: [] });
    expect(patchPoint(patches[0] as Vec3[], 0.5, 0.5)).toEqual(evaluateSurface(patchSurface(patches[0] as Vec3[]), 0.5, 0.5));
  });
});

describe('subdivision_to_nurbs solid and failures', () => {
  const fakeKernel = (overrides: Partial<GeometryKernel> = {}): GeometryKernel => {
    const handle = {} as never;
    return {
      name: 'scripted',
      supports: () => true,
      evaluate: () => handle,
      tessellate: () => ({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }),
      topology: () => null,
      exportStep: () => null,
      faceQuery: {} as never,
      ...overrides,
    } as GeometryKernel;
  };
  const withKernel = (kernel: GeometryKernel | null): Parameters<typeof execute>[3] => ({ ...defaultContext(), kernel });

  it('builds one mesh entity with the exact recipe on an exact kernel and keeps the SubD on request', () => {
    const result = run(cube.document, 'subdivision_to_nurbs', { id: 'c', output: 'solid', keep: true }, withKernel(fakeKernel()));
    expect(result.affected).toHaveLength(1);
    const solid = result.document.entities[result.affected[0] as string];
    expect(solid?.kind).toBe('mesh');
    expect(result.document.entities['c']).toBeDefined();
    expect(dataOf<{ solid: string; extraordinary: string }>(result)).toMatchObject({ solid: result.affected[0], extraordinary: 'G0' });
    const replaced = run(
      cube.document,
      'subdivision_to_nurbs',
      { id: 'c', output: 'solid', extraordinary: 'G1' },
      withKernel(fakeKernel()),
    );
    expect(replaced.document.entities['c']).toBeUndefined();
  });

  it.each([
    ['no kernel', null, 'DIR_CONVERT_KERNEL'],
    ['a mesh-only kernel', { ...fakeKernel(), faceQuery: undefined } as unknown as GeometryKernel, 'DIR_CONVERT_KERNEL'],
    ['a kernel that refuses', fakeKernel({ evaluate: () => null }), 'DIR_CONVERT_FAILED'],
    ['a kernel without triangles', fakeKernel({ tessellate: () => null }), 'DIR_CONVERT_FAILED'],
  ])('refuses the solid output with %s', (_name, kernel, expected) => {
    const result = run(cube.document, 'subdivision_to_nurbs', { id: 'c', output: 'solid' }, withKernel(kernel));
    expect(code(result)).toBe(expected);
    expectNoOp(result, cube.document);
  });

  it('reads the kernel from the execution context, not the installed one', () => {
    setGeometryKernel(fakeKernel());
    const refused = run(cube.document, 'subdivision_to_nurbs', { id: 'c', output: 'solid' }, withKernel(null));
    expect(code(refused)).toBe('DIR_CONVERT_KERNEL');
    setGeometryKernel(null);
    expect(run(cube.document, 'subdivision_to_nurbs', { id: 'c', output: 'solid' }, withKernel(fakeKernel())).affected).toHaveLength(1);
  });

  it('refuses a solid of an open cage with DIR_CAGE_OPEN, but converts it to sheets', () => {
    const sheetCage = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      faces: [[0, 1, 2, 3]],
      boundary: 'edge_and_corner',
      id: 'o',
    };
    const open = run(empty, 'add_subdivision_solid', sheetCage);
    const refused = run(open.document, 'subdivision_to_nurbs', { id: 'o', output: 'solid' }, withKernel(fakeKernel()));
    expect(code(refused)).toBe('DIR_CAGE_OPEN');
    expectNoOp(refused, open.document);
    expect(run(open.document, 'subdivision_to_nurbs', { id: 'o' }).affected).toHaveLength(4);
  });

  it('reports whether the G1 tolerance was met before the patch budget ran out', () => {
    const met = dataOf<{ g1ToleranceMet: boolean; warnings: string[] }>(
      run(cube.document, 'subdivision_to_nurbs', { id: 'c', extraordinary: 'G1', tangentToleranceDeg: 1.5 }),
    );
    expect(met).toMatchObject({ g1ToleranceMet: true, warnings: [] });
    // a tolerance below the schema minimum (0.01) that no refinement within 4096 patches reaches: the geometry says so
    const missed = cageToNurbs(boxCage([2, 2, 2], [1, 1, 1]), { packed: false, samples: 2, tangentToleranceDeg: 1e-9, fitTangents: true });
    expect(missed.g1ToleranceMet).toBe(false);
    expect(missed.patchCount).toBeLessThanOrEqual(4096);
    expect(missed.maxEvG1Deg).toBeLessThan(0.01);
    expect(dataOf<{ g1ToleranceMet: unknown }>(run(cube.document, 'subdivision_to_nurbs', { id: 'c' })).g1ToleranceMet).toBeNull();
  });

  it('refuses a missing id and a cage with a zero-area face', () => {
    expect(code(run(cube.document, 'subdivision_to_nurbs', { id: 'nope' }))).toBe('DIR_ENTITY_NOT_FOUND');
    const base = cube.document.entities['c'] as SubdivisionEntity;
    const flat: CadDocument = {
      ...cube.document,
      entities: { c: { ...base, vertices: base.vertices.map((p, v): Vec3 => ((base.faces[0] as number[]).includes(v) ? [v, 0, 1] : p)) } },
    };
    const result = run(flat, 'subdivision_to_nurbs', { id: 'c' });
    expect(code(result)).toBe('DIR_CONVERT_DEGENERATE');
    expectNoOp(result, flat);
  });

  it('is pure', () => {
    expectPure(cube.document, () => run(cube.document, 'subdivision_to_nurbs', { id: 'c', faces: 'packed', extraordinary: 'G1' }));
  });
});
