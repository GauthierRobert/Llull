/**
 * BLD M4: fillet_faces (faces without a shared edge, hold lines) and fillet_full_round over a scripted kernel: face-set picking with
 * persistent names, the stable codes, the recipe nodes and what the validators, exporters and check_blends do with them (native values:
 * server/tests/nativeBlendFaces.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { BlendReport } from '@core/geometry/kernelPorts';
import { diagnoseBlend, remediationOf } from '@core/geometry/blend/diagnose';
import { holdLineLaw, type HoldStation } from '@core/geometry/blend/holdLine';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { scriptedKernel } from '../helpers/blendKernel';
import { TETRA } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const context = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
const box = (): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return { doc: made.document, id: made.affected[0] as string };
};
const brepOf = (doc: CadDocument, id: string): ShapeRecipe | undefined => (doc.entities[id] as MeshSolidEntity).brep;
const lastParams = (doc: CadDocument): Record<string, unknown> =>
  (doc.featureHistory[doc.featureHistory.length - 1]?.params ?? {}) as Record<string, unknown>;
/** Face sets of the scripted topology: the nearest-face stub maps x to the face index. */
const setOf = (face: number): { near: Array<[number, number, number]> } => ({ near: [[face, 0, 0]] });

describe('fillet_faces', () => {
  it('a radius between two faces is a faceBlend node over the picked faces; the picked names are recorded', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const result = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 2 }, context(kernel));
    expect(result.affected).toHaveLength(1);
    expect(brepOf(result.document, result.affected[0] as string)).toMatchObject({ op: 'faceBlend', facesA: [0], facesB: [1], radius: 2 });
    expect(result.summary).toContain('blended');
    const data = result.data as { id: string; blends: unknown[]; consumedFaces: string[]; unit: string };
    expect(data.id).toBe(result.affected[0]);
    expect(data.unit).toBe('mm');
    expect(data.consumedFaces).toEqual([]);
    expect(lastParams(result.document)).toMatchObject({ facesA: { names: ['box-1.1:x+'] }, facesB: { names: ['box-1.1:z+'] } });
    expectPure(doc, () => execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 2 }, context(kernel)));
  });

  it('a profile rides along in the node; names given are used as they are and are not recorded again', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const named = execute(
      doc,
      'fillet_faces',
      { id, facesA: { names: ['box-1.1:x+'] }, facesB: { names: ['box-1.1:z+'] }, radius: 1, profile: { type: 'curvature', shape: 0.5 } },
      context(kernel),
    );
    expect(brepOf(named.document, named.affected[0] as string)).toMatchObject({
      facesA: [0],
      facesB: [1],
      profile: { type: 'curvature', shape: 0.5 },
    });
    expect(lastParams(named.document)).toMatchObject({ facesA: { names: ['box-1.1:x+'] } });
    expect(lastParams(named.document)['facesA']).not.toHaveProperty('near');
    const lost = execute(doc, 'fillet_faces', { id, facesA: { names: ['gone'] }, facesB: setOf(1), radius: 1 }, context(kernel));
    expect(lost.error).toMatchObject({ code: 'REF_LOST', ids: [id], paths: ['facesA.names'] });
    expect(lost.document).toBe(doc);
  });

  it('BLD_FACESET_EMPTY / BLD_FACESETS_OVERLAP / BLD_BLEND_PARAMS / BLD_LAW_INVALID / ranges, with the unchanged document', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const base = { id, facesA: setOf(0), facesB: setOf(1) };
    const empty = execute(doc, 'fillet_faces', { ...base, facesA: {}, radius: 1 }, context(kernel));
    expectNoOp(empty, doc, 'BLD_FACESET_EMPTY');
    expect(empty.error).toMatchObject({ code: 'BLD_FACESET_EMPTY', ids: [id], paths: ['facesA'] });
    expect(empty.error?.remediation).toContain('inspect_faces');
    const overlap = execute(doc, 'fillet_faces', { ...base, facesB: setOf(0), radius: 1 }, context(kernel));
    expect(overlap.error).toMatchObject({ code: 'BLD_FACESETS_OVERLAP', paths: ['facesB'] });
    expect(execute(doc, 'fillet_faces', base, context(kernel)).error?.code).toBe('BLD_BLEND_PARAMS');
    expect(execute(doc, 'fillet_faces', { ...base, radius: 1, holdLine: { id: 'h', onFaces: 'A' } }, context(kernel)).error?.code).toBe(
      'BLD_BLEND_PARAMS',
    );
    expect(execute(doc, 'fillet_faces', { ...base, radius: 0 }, context(kernel)).error).toMatchObject({
      code: 'BLD_LAW_INVALID',
      paths: ['radius'],
    });
    expect(execute(doc, 'fillet_faces', { ...base, radius: 1, profile: { type: 'conic', rho: 2 } }, context(kernel)).error?.code).toBe(
      'BLD_RHO_RANGE',
    );
    const far = execute(
      doc,
      'fillet_faces',
      { ...base, facesB: setOf(1), radius: 1 },
      context(scriptedKernel({ faceAt: () => ({ face: 0, distance: 50 }) })),
    );
    expect(far.error?.code).toBe('BLD_FACESET_EMPTY');
    expect(far.summary).toContain('not on the solid');
    const noQuery = execute(doc, 'fillet_faces', { ...base, radius: 1 }, context(scriptedKernel({ faceAt: null })));
    expect(noQuery.error?.code).toBe('BLD_FACESET_EMPTY');
    expect(kernel.recipes.some((recipe) => recipe.op === 'faceBlend')).toBe(false);
  });

  it('a kernel report with a [BLD_*] reason is that code, with its remediation; without a prefix it is BLD_PROFILE_FAILED', () => {
    const { doc, id } = box();
    const report = (stage: BlendReport['stage'], message: string): BlendReport => ({
      stage,
      contours: [],
      vertices: [],
      partial: false,
      unsupportedVertices: [],
      done: false,
      valid: false,
      message,
    });
    const refusing = (blendReport: BlendReport): GeometryKernel => {
      const base = scriptedKernel();
      return { ...base, evaluate: (recipe) => (recipe.op === 'faceBlend' ? null : base.evaluate(recipe)), blendReport: () => blendReport };
    };
    const noSolution = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(0), facesB: setOf(1), radius: 1.5 },
      context(
        refusing(
          report(
            'faceBlend',
            '[BLD_FACE_FILLET_NO_SOLUTION] no ball of radius 1.5 touches both faces; the smallest radius that does is about 1.7071',
          ),
        ),
      ),
    );
    expect(noSolution.error).toMatchObject({ code: 'BLD_FACE_FILLET_NO_SOLUTION', ids: [id], paths: ['radius'] });
    expect(noSolution.summary).toContain('1.7071');
    expect(noSolution.error?.remediation).toContain('radius');
    const plain = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(0), facesB: setOf(1), radius: 1 },
      context(refusing(report('faceBlend', 'something else'))),
    );
    expect(plain.error?.code).toBe('BLD_PROFILE_FAILED');
    expect(diagnoseBlend(report('fullRound', '[BLD_FULL_ROUND_NOT_OPPOSED] the sides face each other'))).toMatchObject({
      code: 'BLD_FULL_ROUND_NOT_OPPOSED',
      message: 'the sides face each other',
    });
    expect(diagnoseBlend(report('faceBlend', '[BLD_UNKNOWN] x'))?.code).toBe('BLD_PROFILE_FAILED');
    for (const code of [
      'BLD_FACE_FILLET_NO_SOLUTION',
      'BLD_FACESETS_OVERLAP',
      'BLD_FACE_BLEND_UNSUPPORTED',
      'BLD_FULL_ROUND_NOT_OPPOSED',
      'BLD_FULL_ROUND_NO_SOLUTION',
    ] as const)
      expect(remediationOf(code).length).toBeGreaterThan(10);
  });

  it('data lists the blend faces and the faces the result no longer has (the consumed faces)', () => {
    const { doc, id } = box();
    const base = scriptedKernel();
    const reduced: GeometryKernel = {
      ...base,
      topology: (shape) => {
        const full = base.topology(shape);
        const isResult = brepOf !== undefined && JSON.stringify(shape).includes('faceBlend');
        return full === null || !isResult
          ? full
          : {
              ...full,
              faces: [
                ...full.faces.filter((face) => face.index !== 3),
                { index: 3, name: 'blend(e(box-1.1:x+|box-1.1:z+))', surface: 'bspline' as const, area: 1 },
              ],
            };
      },
    };
    const result = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 1 }, context(reduced));
    const data = result.data as { blends: Array<{ name: string }>; consumedFaces: string[] };
    expect(data.blends.map((blend) => blend.name)).toEqual(['blend(e(box-1.1:x+|box-1.1:z+))']);
    expect(data.consumedFaces).toEqual(['box-1.1:flat']);
  });
});

describe('fillet_faces with a hold line', () => {
  const line = (
    doc: CadDocument,
    points: Array<[number, number]>,
    position: [number, number, number],
  ): { doc: CadDocument; id: string } => {
    const made = execute(doc, 'draw_polyline', { points, position });
    return { doc: made.document, id: made.affected[0] as string };
  };
  /** Edge 0 joins faces 0 (x+) and 1 (z+); give the stub kernel the edge along x at y = 5, z = 2.5 and the face normals the law needs. */
  const holdKernel = (): GeometryKernel => {
    const base = scriptedKernel({ edgePoint: (_edge, t) => [-10 + 20 * t, 5, 2.5] });
    return {
      ...base,
      topology: () => ({
        ...(base.topology({} as never) as NonNullable<ReturnType<GeometryKernel['topology']>>),
        faces: [
          { index: 0, name: 'top', surface: 'plane', area: 1, normal: [0, 0, 1] },
          { index: 1, name: 'side', surface: 'plane', area: 1, normal: [0, 1, 0] },
          { index: 2, name: 'end', surface: 'plane', area: 1, normal: [1, 0, 0] },
        ],
        edges: [],
      }),
    };
  };

  it('holdLineLaw: 1 -> 2 off the edge on a 90 degree wedge is r 1 -> 2, straight; a kink keeps its sample; the other side works too', () => {
    const stations: HoldStation[] = Array.from({ length: 5 }, (_, k) => ({ t: k / 4, point: [-10 + 5 * k, 5, 2.5], tangent: [1, 0, 0] }));
    const straight = holdLineLaw(
      stations,
      [
        [-10, 4, 2.5],
        [10, 3, 2.5],
      ],
      [0, 0, 1],
      Math.PI / 2,
      20,
    );
    expect(straight).toMatchObject({ law: { size: 1, sizeEnd: 2, sizes: [], interpolation: 'linear' } });
    const kinked = holdLineLaw(
      stations,
      [
        [-10, 4, 2.5],
        [0, 3, 2.5],
        [10, 4, 2.5],
      ],
      [0, 0, 1],
      Math.PI / 2,
      20,
    );
    expect(kinked).toMatchObject({ law: { size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }] } });
    const wedge = holdLineLaw(
      stations,
      [
        [-10, 4, 2.5],
        [10, 4, 2.5],
      ],
      [0, 0, 1],
      Math.PI / 3,
      20,
    );
    expect((wedge as { law: { size: number } }).law.size).toBeCloseTo(1 / Math.tan(Math.PI / 6), 10);
    const otherSide = holdLineLaw(
      stations,
      [
        [-10, 6, 2.5],
        [10, 7, 2.5],
      ],
      [0, 0, 1],
      Math.PI / 2,
      20,
    );
    expect(otherSide).toMatchObject({ law: { size: 1, sizeEnd: 2 } });
  });

  it('holdLineLaw: off the face plane, not crossing the face at every station, or too few points are problems', () => {
    const stations: HoldStation[] = [
      { t: 0, point: [-10, 5, 2.5], tangent: [1, 0, 0] },
      { t: 1, point: [10, 5, 2.5], tangent: [1, 0, 0] },
    ];
    expect(
      holdLineLaw(
        stations,
        [
          [-10, 4, 3],
          [10, 3, 3],
        ],
        [0, 0, 1],
        Math.PI / 2,
        20,
      ),
    ).toMatchObject({ offFace: true, problem: expect.stringContaining('off the face plane') });
    expect(
      holdLineLaw(
        stations,
        [
          [-2, 4, 2.5],
          [2, 3, 2.5],
        ],
        [0, 0, 1],
        Math.PI / 2,
        20,
      ),
    ).toMatchObject({ offFace: true });
    expect(holdLineLaw(stations, [[0, 0, 2.5]], [0, 0, 1], Math.PI / 2, 20)).toMatchObject({ offFace: false });
    expect(
      holdLineLaw(
        [],
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        [0, 0, 1],
        Math.PI / 2,
        20,
      ),
    ).toMatchObject({ offFace: false });
    const parallel = holdLineLaw(
      stations,
      [
        [-10, 5, 2.5],
        [10, 5, 2.5],
      ],
      [0, 0, 1],
      Math.PI / 2,
      20,
    );
    expect(parallel).toMatchObject({ offFace: true });
  });

  it('the shared edge is rounded with the law (fillet_faces summary, straight pieces); entities that are not curves and faces without an edge are refused', () => {
    const { doc, id } = box();
    const drawn = line(
      doc,
      [
        [-10, 4],
        [10, 3],
      ],
      [0, 0, 2.5],
    );
    const kernel = holdKernel();
    const base = { id, facesA: setOf(0), facesB: setOf(1) };
    const refused = execute(drawn.doc, 'fillet_faces', { ...base, holdLine: { id: id, onFaces: 'A' } }, context(kernel));
    expect(refused.error?.code).toBe('BLD_HOLD_LINE_NOT_ON_FACE');
    expect(refused.error?.remediation).toContain('draw_polyline');
    const apart = {
      ...kernel,
      faceQuery: { ...kernel.faceQuery, faceGraph: () => ({ faces: [], edgeFaces: [[0], [1]], edgeConvexity: [] }) },
    } as unknown as GeometryKernel;
    const unsupported = execute(drawn.doc, 'fillet_faces', { ...base, holdLine: { id: drawn.id, onFaces: 'A' } }, context(apart));
    expect(unsupported.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(unsupported.summary).toContain('share none');
    const noSamples = { ...kernel, faceQuery: { ...kernel.faceQuery, edgeSamples: () => null } } as unknown as GeometryKernel;
    expect(execute(drawn.doc, 'fillet_faces', { ...base, holdLine: { id: drawn.id, onFaces: 'A' } }, context(noSamples)).error?.code).toBe(
      'BLD_FACE_BLEND_UNSUPPORTED',
    );
  });
});

describe('fillet_full_round', () => {
  it('three face sets are a fullRound node; the center is consumed', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const result = execute(doc, 'fillet_full_round', { id, side1: setOf(0), center: setOf(1), side2: setOf(2) }, context(kernel));
    expect(result.affected).toHaveLength(1);
    expect(brepOf(result.document, result.affected[0] as string)).toMatchObject({ op: 'fullRound', side1: [0], center: [1], side2: [2] });
    expect(result.summary).toContain('rounded the top');
    expect(lastParams(result.document)).toMatchObject({
      side1: { names: ['box-1.1:x+'] },
      center: { names: ['box-1.1:z+'] },
      side2: { names: ['box-1.1:side'] },
    });
    expectPure(doc, () => execute(doc, 'fillet_full_round', { id, side1: setOf(0), center: setOf(1), side2: setOf(2) }, context(kernel)));
  });

  it('refusals: an empty set, a face in two sets, a lost name, a missing target, no kernel', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const sets = { side1: setOf(0), center: setOf(1), side2: setOf(2) };
    expect(execute(doc, 'fillet_full_round', { id, ...sets, center: {} }, context(kernel)).error).toMatchObject({
      code: 'BLD_FACESET_EMPTY',
      paths: ['center'],
    });
    expect(execute(doc, 'fillet_full_round', { id, ...sets, side2: setOf(0) }, context(kernel)).error).toMatchObject({
      code: 'BLD_FACESETS_OVERLAP',
    });
    expect(execute(doc, 'fillet_full_round', { id, ...sets, side1: { names: ['gone'] } }, context(kernel)).error?.code).toBe('REF_LOST');
    expectNoOp(execute(doc, 'fillet_full_round', { id: 'ghost', ...sets }, context(kernel)), doc);
    const noKernel = execute(doc, 'fillet_full_round', { id, ...sets }, { ...defaultContext(), kernel: null });
    expectNoOp(noKernel, doc);
    const unbuildable = execute(doc, 'fillet_full_round', { id, ...sets }, context({ ...kernel, evaluate: () => null }));
    expectNoOp(unbuildable, doc, 'could not build');
  });
});

describe('face blend recipe nodes', () => {
  const source: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };
  const leaf = (): string | null => null;
  const node = (extra: Record<string, unknown>): unknown => ({ op: 'faceBlend', source, facesA: [0], facesB: [1], radius: 2, ...extra });
  const round = (extra: Record<string, unknown>): unknown => ({ op: 'fullRound', source, side1: [0], center: [1], side2: [2], ...extra });

  it('recipeKey separates every field; validateShapeRecipe names what is wrong', () => {
    const base = { op: 'faceBlend', source, facesA: [0], facesB: [1], radius: 2 } as const;
    const keys = [
      recipeKey(base),
      recipeKey({ ...base, facesB: [2] }),
      recipeKey({ ...base, radius: 3 }),
      recipeKey({ ...base, profile: { type: 'conic', rho: 0.5 } }),
      recipeKey({ op: 'fullRound', source, side1: [0], center: [1], side2: [2] }),
      recipeKey({ op: 'fullRound', source, side1: [2], center: [1], side2: [0] }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(validateShapeRecipe(node({}), leaf)).toBeNull();
    expect(validateShapeRecipe(node({ profile: { type: 'conic', rho: 0.5 } }), leaf)).toBeNull();
    expect(validateShapeRecipe(node({ facesA: [] }), leaf)).toContain('facesA must be a non-empty list');
    expect(validateShapeRecipe(node({ facesB: [-1] }), leaf)).toContain('facesB');
    expect(validateShapeRecipe(node({ radius: 0 }), leaf)).toContain('radius must be > 0');
    expect(validateShapeRecipe(node({ profile: { type: 'conic', rho: 2 } }), leaf)).toContain('rho');
    expect(validateShapeRecipe(round({}), leaf)).toBeNull();
    expect(validateShapeRecipe(round({ center: [] }), leaf)).toContain('center must be a non-empty list');
    expect(validateShapeRecipe(round({ side2: 'x' }), leaf)).toContain('side2');
  });

  it('an in-process kernel refuses both nodes; they count as blends for check_blends and the exporters', () => {
    const shape = { mesh: TETRA };
    const kernel = kernelFromOps<typeof shape>({
      solid: () => shape,
      boolean: () => null,
      fillet: () => shape,
      blend: () => null,
      chamfer: () => null,
      shell: () => null,
      place: (s) => s,
      scale: (s) => s,
      tessellate: (s) => s.mesh,
      topology: () => null,
      exportStep: () => null,
      release: () => undefined,
    });
    expect(kernel.evaluate({ op: 'faceBlend', source, facesA: [0], facesB: [1], radius: 1 })).toBeNull();
    expect(kernel.evaluate({ op: 'fullRound', source, side1: [0], center: [1], side2: [2] })).toBeNull();
    const { doc, id } = box();
    const scripted = scriptedKernel();
    const blended = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 1 }, context(scripted));
    setGeometryKernel(scripted);
    const exported = execute(blended.document, 'export_code', { language: 'cadquery' });
    expect(exported.summary).toContain('BLD_CODEGEN_UNSUPPORTED');
    const rounded = execute(doc, 'fillet_full_round', { id, side1: setOf(0), center: setOf(1), side2: setOf(2) }, context(scripted));
    expect(execute(rounded.document, 'export_code', { language: 'freecad' }).summary).toContain('BLD_CODEGEN_UNSUPPORTED');
    const check = execute(blended.document, 'check_blends', {}, context(scripted));
    expect((check.data as { status: string }).status).toBeDefined();
  });
});

describe('fillet_faces edge cases', () => {
  const drawn = (doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
    const made = execute(doc, command, params);
    return { doc: made.document, id: made.affected[0] as string };
  };
  const planar = (surface: 'plane' | 'cylinder'): GeometryKernel => {
    const base = scriptedKernel({ edgePoint: (_edge, t) => [-10 + 20 * t, 5, 2.5] });
    return {
      ...base,
      topology: () => ({
        solids: 1,
        faces: [
          { index: 0, name: 'top', surface, area: 1, ...(surface === 'plane' ? { normal: [0, 0, 1] as [number, number, number] } : {}) },
          { index: 1, name: 'side', surface: 'plane', area: 1, normal: [0, 1, 0] },
          { index: 2, name: 'end', surface: 'plane', area: 1, normal: [1, 0, 0] },
        ],
        edges: [],
        vertices: 0,
        volume: 1,
      }),
    };
  };
  const sets = { facesA: { near: [[0, 0, 2.5]] }, facesB: { near: [[1, 5, 0]] } };

  it('a hold line drawn as a single line works too, on either face; several faces or a curved face are BLD_FACE_BLEND_UNSUPPORTED', () => {
    const { doc, id } = box();
    const line = drawn(doc, 'draw_polyline', {
      points: [
        [-10, 4],
        [10, 3],
      ],
      position: [0, 0, 2.5],
    });
    expect(line.doc.entities[line.id]?.kind).toBe('line');
    const bent = drawn(doc, 'draw_polyline', {
      points: [
        [-10, 4],
        [0, 3],
        [10, 4],
      ],
      position: [0, 0, 2.5],
    });
    expect(bent.doc.entities[bent.id]?.kind).toBe('polyline');
    const kernel = planar('plane');
    const done = execute(line.doc, 'fillet_faces', { id, ...sets, holdLine: { id: line.id, onFaces: 'A' } }, context(kernel));
    expect(done.error).toBeUndefined();
    expect(done.summary).toContain('fillet_faces');
    expect(
      execute(bent.doc, 'fillet_faces', { id, ...sets, holdLine: { id: bent.id, onFaces: 'A' } }, context(kernel)).error,
    ).toBeUndefined();
    // measured against the side face (normal +y at y = 5) the same curve is off its plane
    const onB = execute(line.doc, 'fillet_faces', { id, ...sets, holdLine: { id: line.id, onFaces: 'B' } }, context(kernel));
    expect(onB.error?.code).toBe('BLD_HOLD_LINE_NOT_ON_FACE');
    const several = execute(
      line.doc,
      'fillet_faces',
      {
        id,
        facesA: {
          near: [
            [0, 0, 0],
            [2, 0, 0],
          ],
        },
        facesB: sets.facesB,
        holdLine: { id: line.id, onFaces: 'A' },
      },
      context(kernel),
    );
    expect(several.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(several.summary).toContain('one face against one face');
    const curved = execute(line.doc, 'fillet_faces', { id, ...sets, holdLine: { id: line.id, onFaces: 'A' } }, context(planar('cylinder')));
    expect(curved.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(curved.summary).toContain('two planar faces');
    const noGraph = { ...kernel, faceQuery: { ...kernel.faceQuery, faceGraph: () => null } } as unknown as GeometryKernel;
    expect(execute(line.doc, 'fillet_faces', { id, ...sets, holdLine: { id: line.id, onFaces: 'A' } }, context(noGraph)).error?.code).toBe(
      'BLD_FACE_BLEND_UNSUPPORTED',
    );
  });
});

describe('is pure: face blends', () => {
  it('fillet_faces and fillet_full_round leave the input document deep-equal after an accepted and a refused call', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const snapshot = JSON.stringify(doc);
    const calls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 2 }, { id, facesA: setOf(0), facesB: setOf(0), radius: 2 }],
      [
        'fillet_full_round',
        { id, side1: setOf(0), center: setOf(1), side2: setOf(2) },
        { id, side1: setOf(0), center: setOf(0), side2: setOf(2) },
      ],
    ];
    for (const [name, accepted, refused] of calls) {
      expect(execute(doc, name, accepted, context(kernel)).affected, name).toHaveLength(1);
      expect(JSON.stringify(doc)).toBe(snapshot);
      const bad = execute(doc, name, refused, context(kernel));
      expect(bad.affected).toHaveLength(0);
      expect(bad.document).toBe(doc);
      expect(JSON.stringify(doc)).toBe(snapshot);
    }
  });

  it('a kernel without exact face queries refuses with the native-kernel hint before any picking, document unchanged', () => {
    const { doc, id } = box();
    for (const script of [{ noTopology: true }, { noFaceQuery: true }] as const) {
      const result = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 1 }, context(scriptedKernel(script)));
      expectNoOp(result, doc, 'needs the exact native kernel');
    }
  });

  it('a hold line carries its profile: a constant line with a conic profile reaches the recipe, a sloped one is BLD_PROFILE_FAILED', () => {
    const { doc, id } = box();
    const kernel = scriptedKernel({ edgePoint: (_edge, t) => [-10 + 20 * t, 5, 2.5] });
    const holdKernel: GeometryKernel = {
      ...kernel,
      topology: () => ({
        solids: 1,
        faces: [
          { index: 0, name: 'top', surface: 'plane', area: 1, normal: [0, 0, 1] },
          { index: 1, name: 'side', surface: 'plane', area: 1, normal: [0, 1, 0] },
        ],
        edges: kernel.topology(undefined as never)?.edges.slice(0, 1) ?? [],
        vertices: 0,
        volume: 1,
      }),
    };
    const flat = execute(doc, 'draw_polyline', {
      points: [
        [-10, 4],
        [10, 4],
      ],
      position: [0, 0, 2.5],
    });
    const slope = execute(doc, 'draw_polyline', {
      points: [
        [-10, 4],
        [10, 3],
      ],
      position: [0, 0, 2.5],
    });
    const sets = { facesA: setOf(0), facesB: setOf(1) };
    const built = execute(
      flat.document,
      'fillet_faces',
      { id, ...sets, holdLine: { id: flat.affected[0], onFaces: 'A' }, profile: { type: 'conic', rho: 0.5 } },
      context(holdKernel),
    );
    expect(built.summary).not.toContain('rejected');
    expect(built.affected, built.summary).toHaveLength(1);
    expect(brepOf(built.document, built.affected[0] as string)).toMatchObject({
      op: 'fillet',
      size: 1,
      profile: { type: 'conic', rho: 0.5 },
    });
    const refused = execute(
      slope.document,
      'fillet_faces',
      { id, ...sets, holdLine: { id: slope.affected[0], onFaces: 'A' }, profile: { type: 'conic', rho: 0.5 } },
      context(holdKernel),
    );
    expect(refused.error?.code).toBe('BLD_PROFILE_FAILED');
    expect(refused.document).toBe(slope.document);
  });
});

describe('kernelFromOps: a chamfer node the plain op cannot express', () => {
  it('returns null for faces / size2 / angleDeg so the kernel refuses instead of building a symmetric chamfer', () => {
    const shape = { mesh: { positions: [], indices: [] } };
    const kernel = kernelFromOps<{ mesh: unknown }>({
      solid: () => shape,
      boolean: () => null,
      fillet: () => shape,
      blend: () => null,
      chamfer: () => shape,
      shell: () => null,
      place: (s: { mesh: unknown }) => s,
      scale: (s: { mesh: unknown }) => s,
      tessellate: (s: { mesh: unknown }) => s.mesh,
      topology: () => null,
      exportStep: () => null,
    } as never);
    const source = { op: 'solid', entity: { id: 'b', kind: 'box' } } as never;
    const sided = { op: 'chamfer', source, edges: [0], distance: 1 };
    expect(kernel.evaluate({ ...sided, faces: [1], size2: 2 } as never)).toBeNull();
    expect(kernel.evaluate({ ...sided, faces: [1], angleDeg: 30 } as never)).toBeNull();
  });
});
