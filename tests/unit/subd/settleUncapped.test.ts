import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { boxCage, subdivide, type Cage } from '@core/geometry/subdivision';
import { subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { cageVertexLimits, surfaceEvaluator } from '@core/geometry/subd/limit';
import { fullSettleLevels, settleBudgetProblem, settleLevels } from '@core/geometry/subd/settle';
import { sampleLevel } from '@core/geometry/subd/fitOperator';
import { cageToNurbs } from '@core/geometry/subd/toNurbs';
import { evaluateSurface } from '@lib/nurbs/surface';
import { len3, sub3 } from '@lib/vec3';

/** Cube of half-size 1 with every edge at integer sharpness `s`. */
const sharpCube = (s: number): Cage => {
  const cube = boxCage([2, 2, 2], [1, 1, 1]);
  const seen = new Map<string, { a: number; b: number; s: number }>();
  for (const face of cube.faces)
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      seen.set(a < b ? `${a}:${b}` : `${b}:${a}`, { a, b, s });
    });
  return { ...cube, edgeSharpness: [...seen.values()] };
};

/**
 * Closed form (independent of every path): all cube edges at integer sharpness s keep every corner fixed and the faces flat for s levels, so
 * level s is the cube grid with edge length h = 2 / 2^s and sharpness 0; the corner is then a valence-3 smooth vertex, whose limit is
 * (n^2 P + 4 sum e + sum d) / (n (n + 5)) = P - (h / 4) (1, 1, 1) (e = P - h axis, d = P - h (axis + axis)).
 */
const cornerLimit = (s: number): number => 1 - 2 ** -(s + 1);

/** |x| + |y| + |z|: largest at the cube corner (a flat face keeps its coordinate, so one coordinate alone does not single the corner out). */
const coordinateSum = (p: Vec3): number => Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]);

describe('semi-sharp creases above 3 levels: one surface for every path (SHP1)', () => {
  const s = 5;
  const cage = sharpCube(s);
  const corner = cornerLimit(s);

  it('settles uncapped (the sharpness left after 3 levels is not an infinite crease)', () => {
    expect(settleLevels(cage)).toBe(5);
    expect(fullSettleLevels(cage)).toBe(5);
    expect(settleLevels({ ...cage, edgeSharpness: [{ a: 0, b: 1, s: 7 }] })).toBe(7);
  });

  it('cageVertexLimits equals the closed form and the level mesh converges to it', () => {
    const limit = (cageVertexLimits(cage, [0])[0] as { point: Vec3 }).point;
    const [x, y, z] = cage.vertices[0] as Vec3;
    const expected: Vec3 = [Math.sign(x) * corner, Math.sign(y) * corner, Math.sign(z) * corner];
    expect(len3(sub3(limit, expected))).toBeLessThan(1e-12);
    // the level mesh converges to it as O(h^2) (measured 3.0e-3, 4.0e-4 at levels 6, 7); the infinite-crease reading (corner = 1) is 1/64 off
    const err = (level: number): number => len3(sub3(subdivide(cage, level).vertices[0] as Vec3, limit));
    const [err6, err7] = [err(6), err(7)];
    expect(err6).toBeLessThan(4e-3);
    expect(err7).toBeLessThan(1e-3);
    expect(err7).toBeLessThan(err6 / 4);
    expect(len3(sub3(cage.vertices[0] as Vec3, limit))).toBeGreaterThan(2e-2);
  });

  it('limit patches have the closed-form corner', () => {
    const patchCorners = subdivisionPatches(cage).flatMap((patch) => [0, 3, 12, 15].map((k) => patch[k] as Vec3));
    expect(Math.max(...patchCorners.map(coordinateSum))).toBeCloseTo(3 * corner, 12);
  });

  it('B-spline sheets reach the closed-form corner', () => {
    const { surfaces } = cageToNurbs(cage, { packed: false, samples: 2 });
    let tip = 0;
    for (const surface of surfaces) {
      const [u0, u1] = [surface.knotsU[0] as number, surface.knotsU[surface.knotsU.length - 1] as number];
      const [v0, v1] = [surface.knotsV[0] as number, surface.knotsV[surface.knotsV.length - 1] as number];
      for (const [u, v] of [
        [u0, v0],
        [u1, v0],
        [u0, v1],
        [u1, v1],
      ] as const)
        tip = Math.max(tip, coordinateSum(evaluateSurface(surface, u, v)));
    }
    expect(tip).toBeCloseTo(3 * corner, 9);
  });

  it.each([5, 7])('the evaluator reaches the closed-form edge midpoint at sharpness %d', (sharp) => {
    // regular vertex mid-edge at level s (sharpness 0 there, h = 2 / 2^s): (16 P + 4 sum e + sum d) / 36 = P + (h / 6) (1, 0, -1) for P = (-1, 0, 1)
    const sample = surfaceEvaluator(sharpCube(sharp))(0, 0, 0.5);
    const offset = 2 ** -sharp / 3;
    expect(sample?.approximate).toBe(false);
    expect(len3(sub3(sample?.point as Vec3, [-1 + offset, 0, 1 - offset]))).toBeLessThan(1e-12);
  });

  it('code export carries the same surface: the exported cage is the cage settled for 5 levels', () => {
    const added = execute(createEmptyDocument(), 'add_subdivision_solid', {
      box: { size: [2, 2, 2] },
      levels: 4,
      edgeSharpness: (cage.edgeSharpness ?? []).map(({ a, b }) => ({ a, b, s })),
    });
    const text = (execute(added.document, 'export_code', { language: 'cadquery' }).data as { text?: string }).text ?? '';
    // 6 * 32^2 + 2 vertices of the cube refined 5 times (a vertex is one "(x, y, z)," line)
    const vertexLine = /^\s+\(-?[\d.e-]+, -?[\d.e-]+, -?[\d.e-]+\),$/;
    expect(text.split('\n').filter((line) => vertexLine.test(line))).toHaveLength(6 * 32 * 32 + 2);
  });

  it('the cage fit samples at the same settling', () => {
    expect(sampleLevel(cage, 1)).toBe(settleLevels(cage));
  });

  it('refuses a cage whose settling is over budget, by name, and keeps the surface definition for the rest', () => {
    expect(settleBudgetProblem(sharpCube(7))).toBeNull();
    expect(settleBudgetProblem(sharpCube(8))).toContain('sharpness 8');
    const result = execute(createEmptyDocument(), 'add_subdivision_solid', {
      box: { size: [2, 2, 2] },
      edgeSharpness: [{ a: 0, b: 1, s: 9 }],
    });
    expect(result.error?.code).toBe('DIR_SHARPNESS_BUDGET');
    expect(result.affected).toEqual([]);
    const infinite = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2] }, creases: [[0, 1]] });
    expect(infinite.error).toBeUndefined();
  });
});

describe('sharpness budget at the commands (SHP1)', () => {
  const grid = (n: number): { doc: CadDocument; id: string } => {
    const added = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2], segments: [n, n, n] }, levels: 1 });
    return { doc: added.document, id: added.affected[0] as string };
  };
  const entityOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;

  it('set_cage_crease accepts a sharpness within the budget and refuses one over it by name, leaving the document unchanged', () => {
    const { doc, id } = grid(10);
    const ok = execute(doc, 'set_cage_crease', { id, edges: 'all', sharpness: 3 });
    expect(ok.error).toBeUndefined();
    const refused = execute(doc, 'set_cage_crease', { id, edges: 'all', sharpness: 4 });
    expect(refused.error?.code).toBe('DIR_SHARPNESS_BUDGET');
    expect(refused.affected).toEqual([]);
    expect(refused.document).toBe(doc);
    expect(refused.summary).toContain('sharpness 4 needs 4 settling levels');
    const infinite = execute(doc, 'set_cage_crease', { id, edges: 'all', sharpness: 10 });
    expect(infinite.error).toBeUndefined();
  });

  it('a topology edit that grows a semi-sharp cage over the budget is refused', () => {
    const { doc, id } = grid(8);
    const sharp = execute(doc, 'set_cage_crease', { id, edges: 'all', sharpness: 4 }).document;
    expect(settleBudgetProblem(entityOf(sharp, id))).toBeNull();
    const cut = execute(sharp, 'loop_cut_cage', { id, edge: [0, 1], cuts: 1 });
    expect(cut.error?.code).toBe('DIR_SHARPNESS_BUDGET');
    expect(cut.document).toBe(sharp);
  });

  it('check_subdivision warns about a loaded cage whose settling is over the budget, and the paths clamp instead of exploding', () => {
    const { doc, id } = grid(10);
    const loaded: CadDocument = {
      ...doc,
      entities: { ...doc.entities, [id]: { ...entityOf(doc, id), edgeSharpness: [{ a: 0, b: 1, s: 9 }] } },
    };
    const report = execute(loaded, 'check_subdivision', { id });
    const finding = (report.data as { findings: Array<{ code: string; value: number; limit: number }> }).findings.find(
      (f) => f.code === 'DIR_SHARPNESS_BUDGET',
    );
    expect(finding).toMatchObject({ value: 9, limit: 3 });
    expect(settleLevels(entityOf(loaded, id))).toBe(3);
  });
});
