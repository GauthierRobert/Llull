/**
 * BLD M1: chamfer_edge with two distances or a distance and an angle on a named side (FR-BLD-18), the side selection, and the recipe
 * fields it adds, over a scripted kernel (native values: server/tests/nativeBlendLaws.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { isSideProblem, sideFaces } from '@core/geometry/blend/sides';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { SOURCE, TOPOLOGY, scriptedKernel } from '../helpers/blendKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const context = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
const box = (): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return { doc: made.document, id: made.affected[0] as string };
};
const brepOf = (doc: CadDocument, id: string): ShapeRecipe | undefined => (doc.entities[id] as MeshSolidEntity).brep;

describe('chamfer_edge distance-distance and distance-angle', () => {
  it('distance2 on the side1 face: the recipe carries the face index of each edge and the second leg', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    // edge 0 joins faces 0 and 1, edge 2 faces 0 and 2: the point is nearest face 0 for both (distance = face index)
    const result = execute(
      doc,
      'chamfer_edge',
      { id, edgeIndices: [0, 2], distance: 1, distance2: 2, side1Near: [1, 2, 3] },
      context(kernel),
    );
    expect(result.affected).toHaveLength(1);
    expect(brepOf(result.document, result.affected[0] as string)).toMatchObject({
      op: 'chamfer',
      edges: [0, 2],
      size: 1,
      size2: 2,
      faces: [0, 0],
    });
    expect(result.summary).toContain('chamfered');
    expectPure(doc, () =>
      execute(doc, 'chamfer_edge', { id, edgeIndices: [0], distance: 1, distance2: 2, side1Near: [1, 2, 3] }, context(kernel)),
    );
  });

  it('angleDeg picks the other face when the point is nearer to it; side1Name wins by name', () => {
    const kernel = scriptedKernel({ distance: (face) => (face === 1 ? 0 : 5) });
    const { doc, id } = box();
    const angle = execute(doc, 'chamfer_edge', { id, edgeIndices: [0], distance: 1, angleDeg: 30, side1Near: [0, 0, 0] }, context(kernel));
    expect(brepOf(angle.document, angle.affected[0] as string)).toMatchObject({ op: 'chamfer', angleDeg: 30, faces: [1] });
    expect(brepOf(angle.document, angle.affected[0] as string)).not.toHaveProperty('size2');
    const named = execute(
      doc,
      'chamfer_edge',
      { id, edgeIndices: [0], distance: 1, distance2: 2, side1Name: `${SOURCE}:x+` },
      context(kernel),
    );
    expect(brepOf(named.document, named.affected[0] as string)).toMatchObject({ faces: [0], size2: 2 });
  });

  it('a symmetric chamfer keeps its old recipe (no faces, no second leg)', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const result = execute(doc, 'chamfer_edge', { id, edgeIndices: [0], distance: 1 }, context(kernel));
    const brep = brepOf(result.document, result.affected[0] as string);
    expect(brep).toMatchObject({ op: 'chamfer', size: 1 });
    expect(brep).not.toHaveProperty('faces');
  });

  it('BLD_CHAMFER_PARAMS: both distance2 and angleDeg, distance2 <= 0, side1 without a second leg', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const both = execute(doc, 'chamfer_edge', { id, distance: 1, distance2: 1, angleDeg: 30, side1Near: [0, 0, 0] }, context(kernel));
    expectNoOp(both, doc, 'BLD_CHAMFER_PARAMS');
    expect(both.error).toMatchObject({ code: 'BLD_CHAMFER_PARAMS', ids: [id], paths: ['angleDeg'] });
    const negative = execute(doc, 'chamfer_edge', { id, distance: 1, distance2: -1, side1Near: [0, 0, 0] }, context(kernel));
    expect(negative.error).toMatchObject({ code: 'BLD_CHAMFER_PARAMS', paths: ['distance2'] });
    const dangling = execute(doc, 'chamfer_edge', { id, distance: 1, side1Near: [0, 0, 0] }, context(kernel));
    expect(dangling.error).toMatchObject({ code: 'BLD_CHAMFER_PARAMS', paths: ['side1Near'] });
    expect(kernel.recipes.some((recipe) => recipe.op === 'chamfer')).toBe(false);
  });

  it('BLD_CHAMFER_ANGLE_RANGE: the angle is strictly between 0 and 90 degrees', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    for (const angleDeg of [0, 90, 120, -5]) {
      const result = execute(doc, 'chamfer_edge', { id, distance: 1, angleDeg, side1Near: [0, 0, 0] }, context(kernel));
      expect(result.error).toMatchObject({ code: 'BLD_CHAMFER_ANGLE_RANGE', paths: ['angleDeg'] });
      expect(result.document).toBe(doc);
    }
  });

  it('BLD_ASYMMETRIC_SIDE_MISSING: no side given, a tie, a name that is not a face of the edge, a kernel without topology or face queries', () => {
    const { doc, id } = box();
    const given = { id, edgeIndices: [0], distance: 1, distance2: 2 };
    const none = execute(doc, 'chamfer_edge', given, context(scriptedKernel()));
    expect(none.error).toMatchObject({ code: 'BLD_ASYMMETRIC_SIDE_MISSING', paths: ['side1Near'] });
    expect(none.error?.remediation).toContain('side1Near');
    const tie = execute(doc, 'chamfer_edge', { ...given, side1Near: [0, 0, 0] }, context(scriptedKernel({ distance: () => 1 })));
    expect(tie.error).toMatchObject({ code: 'BLD_ASYMMETRIC_SIDE_MISSING' });
    expect(tie.summary).toContain('equally near');
    const foreign = execute(doc, 'chamfer_edge', { ...given, side1Name: 'elsewhere' }, context(scriptedKernel()));
    expect(foreign.error).toMatchObject({ code: 'BLD_ASYMMETRIC_SIDE_MISSING', paths: ['side1Name'] });
    const noTopology = execute(doc, 'chamfer_edge', { ...given, side1Near: [0, 0, 0] }, context(scriptedKernel({ noTopology: true })));
    expect(noTopology.document).toBe(doc);
    const noQuery = execute(doc, 'chamfer_edge', { ...given, side1Near: [0, 0, 0] }, context(scriptedKernel({ noGraph: true })));
    expect(noQuery.error?.code).toBe('BLD_ASYMMETRIC_SIDE_MISSING');
    const noProject = execute(doc, 'chamfer_edge', { ...given, side1Near: [0, 0, 0] }, context(scriptedKernel({ noProject: true })));
    expect(noProject.summary).toContain('could not measure');
  });
});

describe('sideFaces', () => {
  const kernel = scriptedKernel();
  const shape = kernel.evaluate({ op: 'solid', entity: { id: 'x', kind: 'box' } as never });
  it('an edge of one face (a seam) has no two sides', () => {
    const found = sideFaces(kernel, shape as never, TOPOLOGY, [3], { name: 'x' });
    expect(isSideProblem(found)).toBe(true);
    expect(found).toMatchObject({ code: 'BLD_ASYMMETRIC_SIDE_MISSING', message: expect.stringContaining('exactly two faces') });
  });
  it('one face per edge in order, by point or by name', () => {
    expect(sideFaces(kernel, shape as never, TOPOLOGY, [0, 2], { near: [0, 0, 0] })).toEqual([0, 0]);
    expect(sideFaces(kernel, shape as never, TOPOLOGY, [1], { name: `${SOURCE}:side` })).toEqual([2]);
  });
});

describe('recipe fields of sided chamfers', () => {
  const source: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };
  const chamfer = (extra: Record<string, unknown>): unknown => ({ op: 'chamfer', source, edges: [0], size: 1, ...extra });
  const leaf = (): string | null => null;

  it('recipeKey separates the second leg, the angle and the side', () => {
    const base = { op: 'chamfer', source, edges: [0], size: 1 } as const;
    const keys = [
      recipeKey(base),
      recipeKey({ ...base, faces: [0], size2: 2 }),
      recipeKey({ ...base, faces: [1], size2: 2 }),
      recipeKey({ ...base, faces: [0], size2: 3 }),
      recipeKey({ ...base, faces: [0], angleDeg: 30 }),
      recipeKey({ op: 'fillet', source, edges: [0], size: 1, radii: [{ size: 1, interpolation: 'linear' }] }),
      recipeKey({ op: 'fillet', source, edges: [0], size: 1, radii: [{ size: 1 }] }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('validateShapeRecipe accepts sided chamfers and linear laws and names what is wrong otherwise', () => {
    expect(validateShapeRecipe(chamfer({ faces: [0], size2: 2 }), leaf)).toBeNull();
    expect(validateShapeRecipe(chamfer({ faces: [0], angleDeg: 30 }), leaf)).toBeNull();
    expect(validateShapeRecipe(chamfer({ size2: 2 }), leaf)).toContain('need faces');
    expect(validateShapeRecipe(chamfer({ faces: [0, 1], size2: 2 }), leaf)).toContain('one non-negative face index per listed edge');
    expect(validateShapeRecipe(chamfer({ faces: [-1], size2: 2 }), leaf)).toContain('face index');
    expect(validateShapeRecipe(chamfer({ faces: [0] }), leaf)).toContain('exactly one of size2 or angleDeg');
    expect(validateShapeRecipe(chamfer({ faces: [0], size2: 2, angleDeg: 30 }), leaf)).toContain('exactly one');
    expect(validateShapeRecipe(chamfer({ faces: [0], size2: 0 }), leaf)).toContain('size2 must be > 0');
    expect(validateShapeRecipe(chamfer({ faces: [0], angleDeg: 90 }), leaf)).toContain('angleDeg must be inside (0, 90)');
    expect(validateShapeRecipe({ op: 'fillet', source, edges: [0], size: 1, faces: [0], size2: 1 }, leaf)).toContain('chamfers only');
    expect(
      validateShapeRecipe({ op: 'fillet', source, edges: [0], size: 0, radii: [{ size: 1, interpolation: 'linear' }] }, leaf),
    ).toBeNull();
    expect(validateShapeRecipe({ op: 'fillet', source, edges: [0], size: 0, radii: [{ size: 1, interpolation: 'wavy' }] }, leaf)).toContain(
      'interpolation',
    );
  });
});

describe('is pure: sided chamfers', () => {
  it('leave the input document deep-equal after an accepted and after refused calls', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const snapshot = JSON.stringify(doc);
    const accepted = execute(
      doc,
      'chamfer_edge',
      { id, edgeIndices: [0], distance: 1, angleDeg: 30, side1Near: [0, 0, 0] },
      context(kernel),
    );
    expect(accepted.affected).toHaveLength(1);
    expect(JSON.stringify(doc)).toBe(snapshot);
    for (const params of [
      { id, edgeIndices: [0], distance: 1, distance2: 2, angleDeg: 30, side1Near: [0, 0, 0] },
      { id, edgeIndices: [0], distance: 1, angleDeg: 120, side1Near: [0, 0, 0] },
      { id, edgeIndices: [0], distance: 1, distance2: 2 },
    ]) {
      const refused = execute(doc, 'chamfer_edge', params, context(kernel));
      expect(refused.affected).toHaveLength(0);
      expect(refused.document).toBe(doc);
      expect(JSON.stringify(doc)).toBe(snapshot);
    }
  });
});

describe('chamfer_edge distanceEnd (variable chamfer, BLD M5)', () => {
  const source: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };

  it('records sizeEnd on the chamfer node, symmetric, with the listed edges', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const result = execute(doc, 'chamfer_edge', { id, edgeIndices: [0], distance: 1, distanceEnd: 2 }, context(kernel));
    expect(result.affected).toHaveLength(1);
    const brep = brepOf(result.document, result.affected[0] as string);
    expect(brep).toMatchObject({ op: 'chamfer', edges: [0], size: 1, sizeEnd: 2 });
    expect(brep).not.toHaveProperty('faces');
    expectPure(doc, () => execute(doc, 'chamfer_edge', { id, edgeIndices: [0], distance: 1, distanceEnd: 2 }, context(kernel)));
  });

  it('BLD_CHAMFER_VARIABLE_PARAMS: with distance2 / angleDeg, not positive, a second leg without its end or an end without its leg, or without listed edges (paths named); nothing reaches the kernel', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    for (const [path, params] of [
      ['distance2End', { distanceEnd: 2, distance2: 1, side1Near: [0, 0, 0] }],
      ['angleDeg', { distanceEnd: 2, angleDeg: 30, side1Near: [0, 0, 0] }],
      ['distance2End', { distance2End: 2, edgeIndices: [0] }],
      ['distance2End', { distanceEnd: 2, distance2End: 2, edgeIndices: [0] }],
      ['distance2End', { distanceEnd: 2, distance2: 1, distance2End: 0, side1Near: [0, 0, 0], edgeIndices: [0] }],
      ['distanceEnd', { distanceEnd: 0, edgeIndices: [0] }],
      ['distanceEnd', { distanceEnd: -1, edgeIndices: [0] }],
      ['edgeIndices', { distanceEnd: 2 }],
    ] as const) {
      const result = execute(doc, 'chamfer_edge', { id, distance: 1, ...params }, context(kernel));
      expect(result.error).toMatchObject({ code: 'BLD_CHAMFER_VARIABLE_PARAMS', ids: [id], paths: [path] });
      expect(result.error?.remediation).toContain('distanceEnd > 0 and the edges listed');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
    expect(kernel.recipes.some((recipe) => recipe.op === 'chamfer')).toBe(false);
  });

  it('a kernel that cannot build it answers with the reason it computed (BLD_CHAMFER_FAILED, path distanceEnd, chamfer advice); the document is unchanged', () => {
    const { doc, id } = box();
    const base = scriptedKernel();
    const refusing: GeometryKernel = {
      ...base,
      evaluate: (recipe) => (recipe.op === 'chamfer' ? null : base.evaluate(recipe)),
      blendReport: () => ({
        stage: 'chamfer',
        contours: [],
        vertices: [],
        partial: false,
        unsupportedVertices: [],
        done: false,
        valid: false,
        message: 'a distance of 6 reaches past the faces of edge 0; use a smaller distance',
      }),
    };
    const result = execute(doc, 'chamfer_edge', { id, edgeIndices: [0], distance: 1, distanceEnd: 6 }, context(refusing));
    expect(result.document).toBe(doc);
    expect(result.error).toMatchObject({ code: 'BLD_CHAMFER_FAILED', ids: [id], paths: ['distanceEnd'] });
    expect(result.error?.remediation).toContain('use smaller distances');
    expect(result.error?.remediation).toContain('unlist edges that share a vertex');
    expect(result.error?.remediation).not.toContain('circular profile');
    expect(result.summary).toContain('the variable chamfer cannot be built: a distance of 6 reaches past the faces');
  });

  it('records both legs of an asymmetric variable chamfer: faces, size2 and size2End', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const result = execute(
      doc,
      'chamfer_edge',
      { id, edgeIndices: [0], distance: 1, distanceEnd: 2, distance2: 2, distance2End: 4, side1Near: [0, 0, 0] },
      context(kernel),
    );
    expect(result.error).toBeUndefined();
    expect(brepOf(result.document, result.affected[0] as string)).toMatchObject({
      op: 'chamfer',
      edges: [0],
      size: 1,
      sizeEnd: 2,
      size2: 2,
      size2End: 4,
    });
  });

  it('the recipe key and validation separate a variable chamfer from a constant one and read the legs of an asymmetric one', () => {
    const base = { op: 'chamfer', source, edges: [0], size: 1 } as const;
    expect(recipeKey({ ...base, sizeEnd: 2 })).not.toBe(recipeKey(base));
    expect(validateShapeRecipe({ ...base, sizeEnd: 2 }, () => null)).toBeNull();
    expect(validateShapeRecipe({ ...base, sizeEnd: 0 }, () => null)).toContain('sizeEnd must be > 0');
    const sided = { ...base, sizeEnd: 2, faces: [0], size2: 1 } as const;
    expect(validateShapeRecipe(sided, () => null)).toContain('size2 and size2End');
    expect(validateShapeRecipe({ ...sided, size2End: 3 }, () => null)).toBeNull();
    expect(recipeKey({ ...sided, size2End: 3 })).not.toBe(recipeKey({ ...sided, size2End: 4 }));
    expect(validateShapeRecipe({ ...sided, size2End: 0 }, () => null)).toContain('size2End');
    expect(validateShapeRecipe({ ...sided, size2End: 3, angleDeg: 20 }, () => null)).toContain('no angleDeg');
    expect(validateShapeRecipe({ ...base, sizeEnd: 2, size2End: 3 }, () => null)).toContain('size2End needs');
    expect(validateShapeRecipe({ ...base, size2End: 3 }, () => null)).toContain('size2End needs');
    expect(validateShapeRecipe({ ...base, sizeEnd: 2, faces: [0], angleDeg: 20 }, () => null)).toContain('size2 and size2End');
  });
});
