import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { GeometryKernel } from '@core/geometry/kernel';
import { boxCage, cageProblem, subdivide, type Cage } from '@core/geometry/subdivision';
import { patchPoint, subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { cageVertexLimits, surfaceEvaluator } from '@core/geometry/subd/limit';
import { settleLevels, settledCage } from '@core/geometry/subd/settle';
import { pairVertices } from '@core/geometry/subd/symmetry';
import { levelMeshVolume } from '@core/geometry/subd/volume';
import { len3, sub3 } from '@lib/vec3';

const empty = createEmptyDocument();
const run = (doc: CadDocument, name: string, params: object, ctx?: Parameters<typeof execute>[3]): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>, ctx);
const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
const entityOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
function add(params: object): { doc: CadDocument; id: string; e: SubdivisionEntity } {
  const result = run(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 2, ...params });
  const id = result.affected[0] as string;
  return { doc: result.document, id, e: entityOf(result.document, id) };
}
const edgesOf = (cage: Cage): Array<[number, number]> => {
  const seen = new Map<string, [number, number]>();
  for (const face of cage.faces)
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      seen.set(a < b ? `${a}:${b}` : `${b}:${a}`, [a, b]);
    });
  return [...seen.values()];
};
const semiSharp = (s: number): Cage => {
  const cube = boxCage([2, 2, 2], [1, 1, 1]);
  return { ...cube, edgeSharpness: edgesOf(cube).map(([a, b]) => ({ a, b, s })) };
};

describe('replay of an index-pair loop cut (review 1)', () => {
  it('records the edge in the order the caller gave, so a factor replays the same cut', () => {
    const { doc, id, e } = add({});
    const [a, b] = [4, 0];
    const first = run(doc, 'loop_cut_cage', { id, edge: [a, b], factor: 0.25 });
    const recorded = first.document.featureHistory.at(-1)?.params as { edge: string };
    expect(recorded.edge).toBe(`e:${e.elementIds.vertices[a]}|${e.elementIds.vertices[b]}`);
    const replay = run(doc, 'loop_cut_cage', { ...(first.document.featureHistory.at(-1)?.params as object) });
    expect(entityOf(replay.document, id).vertices).toEqual(entityOf(first.document, id).vertices);
    const flipped = run(doc, 'loop_cut_cage', { id, edge: [b, a], factor: 0.25 });
    expect(entityOf(flipped.document, id).vertices).not.toEqual(entityOf(first.document, id).vertices);
  });
});

describe('semi-sharp creases on the exact paths (review 2, 3, 4)', () => {
  it('settles after ceil(max finite sharpness) steps, capped', () => {
    expect(settleLevels(semiSharp(1.5))).toBe(2);
    expect(settleLevels(boxCage([2, 2, 2], [1, 1, 1]))).toBe(0);
    expect(settleLevels({ vertexSharpness: [{ v: 0, s: 9 }] })).toBe(3);
    expect(settledCage(boxCage([2, 2, 2], [1, 1, 1])).levels).toBe(0);
    expect(settledCage(semiSharp(1)).cage.faces).toHaveLength(24);
  });
  it('patches describe the same surface as the level mesh on a semi-sharp cage (pure geometry, no kernel)', () => {
    const cage = semiSharp(2);
    const patches = subdivisionPatches(cage);
    const n = 6;
    const sheet = patches.flatMap((patch) =>
      Array.from({ length: n * n }, (_, k): [Vec3, Vec3, Vec3, Vec3] => {
        const [i, j] = [Math.floor(k / n), k % n];
        const at = (u: number, v: number): Vec3 => patchPoint(patch, u / n, v / n);
        return [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      }),
    );
    let volume = 0;
    for (const [a, b, c, d] of sheet)
      for (const [p, q, r] of [
        [a, b, c],
        [a, c, d],
      ] as const)
        volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    expect(volume / levelMeshVolume(cage, 5)).toBeCloseTo(1, 2);
    const unsettled = subdivisionPatches({ ...cage, edgeSharpness: undefined });
    expect(patches.length).toBeGreaterThan(unsettled.length);
  });
  it('treats an infinite corner as a corner in the patches', () => {
    const cube = boxCage([2, 2, 2], [1, 1, 1]);
    const corner = subdivisionPatches({ ...cube, vertexSharpness: [{ v: 0, s: 10 }] });
    const smooth = subdivisionPatches(cube);
    const tip = (patches: ReturnType<typeof subdivisionPatches>): number =>
      Math.max(...patches.flatMap((p) => p.map((q) => Math.abs(q[0]))));
    expect(tip(corner)).toBeCloseTo(1, 12);
    expect(tip(smooth)).toBeLessThan(1);
  });
  it('limit points of a semi-sharp cage match a level-6 mesh', () => {
    const cage = semiSharp(1.5);
    const limits = cageVertexLimits(cage, [0, 2]);
    const deep = subdivide(cage, 6);
    for (const [k, v] of [0, 2].entries()) {
      expect(len3(sub3(deep.vertices[v] as Vec3, (limits[k] as { point: Vec3 }).point))).toBeLessThan(3e-3);
    }
    const sample = surfaceEvaluator(cage)(0, 0.3, 0.3);
    expect(sample?.approximate).toBe(false);
    expect(sample?.depth).toBeGreaterThanOrEqual(2);
  });
  it('code export carries semi-sharp creases by exporting the settled cage', () => {
    const { doc } = add({ box: { size: [2, 2, 2] }, edgeSharpness: [{ a: 0, b: 1, s: 1 }], levels: 2 });
    const text = (run(doc, 'export_code', { language: 'cadquery' }).data as { text?: string }).text ?? '';
    expect(text).toContain('subdivision');
    expect(text).not.toContain('edgeSharpness');
    const plain = add({ box: { size: [2, 2, 2] }, levels: 2 });
    const plainText = (run(plain.doc, 'export_code', { language: 'cadquery' }).data as { text?: string }).text ?? '';
    expect(text.length).toBeGreaterThan(plainText.length);
  });
});

describe('symmetry (review 5, 6, 8)', () => {
  it('follows the most strongly driven vertex when falloff reaches the mirror image', () => {
    const slab = add({ box: { size: [4, 2, 2], segments: [2, 1, 1] } });
    const sym = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    const left = slab.e.vertices.findIndex((p) => p[0] === -2 && p[1] === -1 && p[2] === 1);
    const right = slab.e.vertices.findIndex((p) => p[0] === 2 && p[1] === -1 && p[2] === 1);
    const [high, low] = left > right ? [left, right] : [right, left];
    const edit = run(sym.document, 'edit_subdivision_cage', { id: slab.id, vertexIndices: [high], falloff: 5, translate: [0, 0, 1] });
    const after = entityOf(edit.document, slab.id).vertices;
    expect((after[high] as Vec3)[2]).toBeCloseTo(2, 12);
    expect((after[low] as Vec3)[2]).toBeCloseTo(2, 12);
    for (const [v, p] of slab.e.vertices.entries()) {
      const twin = slab.e.vertices.findIndex((q) => q[0] === -p[0] && q[1] === p[1] && q[2] === p[2]);
      expect((after[v] as Vec3)[2]).toBeCloseTo((after[twin] as Vec3)[2], 12);
    }
  });
  it('clears the symmetry when an ignored-symmetry edit breaks it, keeps it otherwise, and later topology edits work', () => {
    const slab = add({ box: { size: [2, 2, 2], segments: [2, 1, 1] } });
    const sym = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    const cleared = run(sym.document, 'edit_subdivision_cage', {
      id: slab.id,
      vertexIndices: [0],
      translate: [0.2, 0, 0],
      symmetry: 'ignore',
    });
    expect(entityOf(cleared.document, slab.id).symmetry).toBeUndefined();
    expect(cleared.summary).toContain('symmetry was cleared');
    expect(run(cleared.document, 'extrude_cage_faces', { id: slab.id, faces: [0], distance: 1 }).affected).toEqual([slab.id]);
    const kept = run(sym.document, 'edit_subdivision_cage', {
      id: slab.id,
      region: { min: [-9, -9, -9], max: [9, 9, 9] },
      translate: [0, 0, 1],
      symmetry: 'ignore',
    });
    expect(entityOf(kept.document, slab.id).symmetry).toBeDefined();
  });
  it('pairs a large cage through the spatial hash', () => {
    const big = boxCage([2, 2, 2], [18, 18, 18]);
    const started = performance.now();
    const pairing = pairVertices(big.vertices, ['x', 'y', 'z'], 1e-9);
    expect(pairing.unpaired).toHaveLength(0);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(
      pairVertices(big.vertices, ['x'], 1e-9).partners[0]?.every(
        (w, v) => Math.abs((big.vertices[w] as Vec3)[0] + (big.vertices[v] as Vec3)[0]) < 1e-9,
      ),
    ).toBe(true);
  });
});

describe('check_subdivision honesty (review 7)', () => {
  const kernelWith = (gap: number, angle: number): GeometryKernel =>
    ({
      name: 'scripted',
      supports: () => true,
      evaluate: () => ({}) as never,
      tessellate: () => null,
      topology: () => null,
      exportStep: () => null,
      massProperties: () => ({ volume: 2.6, area: 1 }) as never,
      faceQuery: {
        faceGraph: () => ({ faces: [], edgeFaces: [[0, 1]], edgeConvexity: [] }),
        edgeContinuity: () => [{ t: 0, point: [0, 0, 0], g0: gap, g1: angle, normalCurvature: [0, 0] }],
      } as never,
    }) as GeometryKernel;
  const codes = (result: ReturnType<typeof execute>): string[] =>
    (result.data as { findings: Array<{ code: string }> }).findings.map((f) => f.code);
  it('says so when the self-intersection test ran on a coarser level than the cage', () => {
    const { doc, id } = add({ box: { size: [4, 4, 4], segments: [4, 4, 4] }, levels: 4 });
    const result = run(doc, 'check_subdivision', { id });
    expect(codes(result)).toContain('DIR_CHECK_SELF_INTERSECTION_PARTIAL');
    expect((result.data as { status: string }).status).toBe('warn');
  });
  it('warns when the volumes cannot be compared', () => {
    const { doc, id, e } = add({});
    const collapsed = { ...doc, entities: { [id]: { ...e, vertices: e.vertices.map((): Vec3 => [0, 0, 0]) } } } as CadDocument;
    expect(codes(run(collapsed, 'check_subdivision', { id }))).toContain('DIR_CHECK_VOLUME_NON_FINITE');
  });
  it('compares the exact seam gap and angle with named tolerances', () => {
    const { doc, id } = add({ levels: 3 });
    const ctx = (gap: number, angle: number): Parameters<typeof execute>[3] => ({ ...defaultContext(), kernel: kernelWith(gap, angle) });
    expect(codes(run(doc, 'check_subdivision', { id }, ctx(1e-7, 0.02)))).not.toContain('DIR_CHECK_PATCH_SEAM_GAP');
    expect(codes(run(doc, 'check_subdivision', { id }, ctx(1e-2, 0.02)))).toContain('DIR_CHECK_PATCH_SEAM_GAP');
    expect(codes(run(doc, 'check_subdivision', { id }, ctx(1e-7, 0.2)))).toContain('DIR_CHECK_PATCH_SEAM_ANGLE');
    expect(
      codes(run(doc, 'check_subdivision', { id, tolerances: { patchSeamAngleRad: 0.5, patchSeamGap: 1 } }, ctx(1e-2, 0.2))),
    ).not.toContain('DIR_CHECK_PATCH_SEAM_ANGLE');
  });
});

describe('cage validation and small refusals (review 9, 10)', () => {
  const cube = boxCage([2, 2, 2], [1, 1, 1]);
  it('rejects duplicate and conflicting sharpness entries', () => {
    expect(
      cageProblem({
        ...cube,
        creases: [
          [0, 1],
          [1, 0],
        ],
      }),
    ).toContain('listed twice');
    expect(cageProblem({ ...cube, creases: [[0, 1]], edgeSharpness: [{ a: 0, b: 1, s: 2 }] })).toContain('both');
    expect(cageProblem({ ...cube, edgeSharpness: [{ a: 0, b: 1, s: 10 }] })).toContain('belongs in creases');
    expect(
      cageProblem({
        ...cube,
        edgeSharpness: [
          { a: 0, b: 1, s: 1 },
          { a: 1, b: 0, s: 2 },
        ],
      }),
    ).toContain('twice');
    expect(
      cageProblem({
        ...cube,
        vertexSharpness: [
          { v: 0, s: 1 },
          { v: 0, s: 2 },
        ],
      }),
    ).toContain('twice');
  });
  it('set_cage_crease with nothing resolved is a no-op, not a recorded step', () => {
    const { doc, id } = add({});
    const result = run(doc, 'set_cage_crease', { id, edges: [], sharpness: 1 });
    expect(code(result)).toBe('DIR_NOTHING_TO_DO');
    expect(result.document).toBe(doc);
  });
  it('names a region whose boundary passes through one vertex twice', () => {
    const { doc, id } = add({ box: { size: [4, 4, 1], segments: [4, 4, 1] } });
    const result = run(doc, 'extrude_cage_faces', { id, faces: [5, 4, 8, 12, 13, 14, 10], distance: 1 });
    expect(code(result)).toBe('DIR_REGION_PINCH');
  });
  it('stops refining a sample at the face budget instead of refining the whole cage', () => {
    const big = boxCage([2, 2, 2], [12, 12, 12]);
    const sample = surfaceEvaluator(big)(0, 0, 0);
    expect(sample?.approximate).toBe(true);
    expect(sample?.depth).toBe(3);
  });
});
