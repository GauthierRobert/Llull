/**
 * BLD M2: conic / curvature profiles and the second leg of fillet_edge, their coded refusals, the recipe fields, and what the exporters and
 * check_blends do with them, over a scripted kernel (native values: server/tests/nativeBlendProfiles.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { BlendReport } from '@core/geometry/kernelPorts';
import { diagnoseBlend, remediationOf } from '@core/geometry/blend/diagnose';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { isProfileRefusal, prepareProfile, profileText, resolveProfile } from '@core/commands/brep/filletProfile';
import { SOURCE, TOPOLOGY, scriptedKernel, type ScriptedKernel } from '../helpers/blendKernel';
import { TETRA } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const context = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
const box = (): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return { doc: made.document, id: made.affected[0] as string };
};
const brepOf = (doc: CadDocument, id: string): ShapeRecipe | undefined => (doc.entities[id] as MeshSolidEntity).brep;

describe('resolveProfile and prepareProfile', () => {
  it('keeps only the field a type reads and refuses rho / shape outside 0.05..0.95 or missing', () => {
    expect(resolveProfile(undefined)).toEqual({ profile: undefined });
    expect(resolveProfile({ type: 'circular', rho: 7 })).toEqual({ profile: undefined });
    expect(resolveProfile({ type: 'conic', rho: 0.25, shape: 0.9 })).toEqual({ profile: { type: 'conic', rho: 0.25 } });
    expect(resolveProfile({ type: 'curvature', shape: 0.5, rho: 0.9 })).toEqual({ profile: { type: 'curvature', shape: 0.5 } });
    expect(resolveProfile({ type: 'conic', rho: 0.05 })).toEqual({ profile: { type: 'conic', rho: 0.05 } });
    expect(resolveProfile({ type: 'conic', rho: 0.95 })).toEqual({ profile: { type: 'conic', rho: 0.95 } });
    expect(resolveProfile({ type: 'conic', rho: 0.96 })).toMatchObject({ code: 'BLD_RHO_RANGE', path: 'profile.rho' });
    expect(resolveProfile({ type: 'conic' })).toMatchObject({ code: 'BLD_RHO_RANGE' });
    expect(resolveProfile({ type: 'curvature', shape: 0.04 })).toMatchObject({ code: 'BLD_SHAPE_RANGE', path: 'profile.shape' });
    expect(resolveProfile({ type: 'curvature', shape: Number.NaN })).toMatchObject({ code: 'BLD_SHAPE_RANGE' });
    expect(isProfileRefusal(resolveProfile({ type: 'conic' }))).toBe(true);
    expect(isProfileRefusal({ profile: undefined })).toBe(false);
  });

  it('profileText: empty for a circular section, a phrase for the others', () => {
    expect(profileText(undefined)).toBe('');
    expect(profileText({ type: 'circular' })).toBe('');
    expect(profileText({ type: 'conic', rho: 0.25 })).toBe(', conic profile rho 0.25');
    expect(profileText({ type: 'curvature', shape: 0.5 })).toBe(', curvature profile shape 0.5');
  });

  it('prepareProfile: constant laws pass; a varying size, size2 without a usable side are refused with the entry path', () => {
    const kernel = scriptedKernel();
    const shape = kernel.evaluate({ op: 'solid', entity: { id: 'x', kind: 'box' } as never });
    const run = (planned: Parameters<typeof prepareProfile>[3], topology = TOPOLOGY): ReturnType<typeof prepareProfile> =>
      prepareProfile(kernel, shape as never, topology, planned);
    expect(run([{ edge: 0, law: { size: 1 } }])).toEqual({ planned: [{ edge: 0, law: { size: 1 } }] });
    expect(run([{ edge: 0, law: { size: 1, sizeEnd: 2 }, entry: 3 }])).toMatchObject({
      code: 'BLD_PROFILE_FAILED',
      path: 'edges[3].sizeEnd',
    });
    expect(run([{ edge: 0, law: { size: 1, sizes: [{ t: 0.5, size: 2 }] } }])).toMatchObject({ code: 'BLD_PROFILE_FAILED', path: 'sizes' });
    expect(run([{ edge: 0, law: { size: 1, size2: 2 }, entry: 0 }])).toMatchObject({
      code: 'BLD_ASYMMETRIC_SIDE_MISSING',
      path: 'edges[0].side1Near',
    });
    expect(run([{ edge: 0, law: { size: 1, size2: 2 }, side: {} }])).toMatchObject({ code: 'BLD_ASYMMETRIC_SIDE_MISSING' });
    const named = run([{ edge: 0, law: { size: 1, size2: 2 }, side: { name: `${SOURCE}:z+` } }]);
    expect(named).toEqual({ planned: [{ edge: 0, law: { size: 1, size2: 2, sideFace: 1 }, side: { name: `${SOURCE}:z+` } }] });
    const wrongName = run([{ edge: 0, law: { size: 1, size2: 2 }, side: { name: 'elsewhere' }, entry: 1 }]);
    expect(wrongName).toMatchObject({ code: 'BLD_ASYMMETRIC_SIDE_MISSING', path: 'edges[1].side1Name' });
    expect(prepareProfile(kernel, shape as never, null, [{ edge: 0, law: { size: 1, size2: 2 }, side: { name: 'x' } }])).toMatchObject({
      code: 'BLD_ASYMMETRIC_SIDE_MISSING',
    });
  });
});

describe('fillet_edge profile and size2', () => {
  it('a profile on the radius shorthand reaches the kernel in the recipe; a circular one leaves the recipe as before', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const conic = execute(doc, 'fillet_edge', { id, edgeIndices: [0], radius: 1, profile: { type: 'conic', rho: 0.25 } }, context(kernel));
    expect(conic.affected).toHaveLength(1);
    expect(brepOf(conic.document, conic.affected[0] as string)).toMatchObject({
      op: 'fillet',
      size: 1,
      profile: { type: 'conic', rho: 0.25 },
    });
    expect(conic.summary).toContain('conic profile rho 0.25');
    const curvature = execute(
      doc,
      'fillet_edge',
      { id, edgeIndices: [0], radius: 1, profile: { type: 'curvature', shape: 0.5 } },
      context(kernel),
    );
    expect(brepOf(curvature.document, curvature.affected[0] as string)).toMatchObject({ profile: { type: 'curvature', shape: 0.5 } });
    const circular = execute(doc, 'fillet_edge', { id, edgeIndices: [0], radius: 1, profile: { type: 'circular' } }, context(kernel));
    expect(brepOf(circular.document, circular.affected[0] as string)).not.toHaveProperty('profile');
    expectPure(doc, () =>
      execute(doc, 'fillet_edge', { id, edgeIndices: [0], radius: 1, profile: { type: 'conic', rho: 0.5 } }, context(kernel)),
    );
  });

  it('size2 with a side: the laws carry the second leg and the face index; swapping the side swaps the face', () => {
    const kernel = scriptedKernel({ distance: (face) => (face === 1 ? 0 : 5) });
    const { doc, id } = box();
    const result = execute(doc, 'fillet_edge', { id, edges: [{ index: 0, size: 1, size2: 2, side1Near: [0, 0, 2.5] }] }, context(kernel));
    expect(result.error).toBeUndefined();
    expect(brepOf(result.document, result.affected[0] as string)).toMatchObject({
      op: 'fillet',
      size: 0,
      radii: [{ size: 1, size2: 2, sideFace: 1 }],
    });
    expect(result.summary).toContain('1 x 2');
    const byName = execute(
      doc,
      'fillet_edge',
      { id, edges: [{ index: 0, size: 1, size2: 2, side1Name: `${SOURCE}:x+` }] },
      context(kernel),
    );
    expect(brepOf(byName.document, byName.affected[0] as string)).toMatchObject({ radii: [{ sideFace: 0 }] });
  });

  it('BLD_RHO_RANGE / BLD_SHAPE_RANGE before any kernel work; BLD_LAW_INVALID for a bad size2; BLD_ASYMMETRIC_SIDE_MISSING without a side', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const rho = execute(doc, 'fillet_edge', { id, edgeIndices: [0], radius: 1, profile: { type: 'conic', rho: 1.2 } }, context(kernel));
    expectNoOp(rho, doc, 'BLD_RHO_RANGE');
    expect(rho.error).toMatchObject({ code: 'BLD_RHO_RANGE', ids: [id], paths: ['profile.rho'] });
    expect(rho.error?.remediation).toBeDefined();
    expect(
      execute(doc, 'fillet_edge', { id, edgeIndices: [0], radius: 1, profile: { type: 'curvature' } }, context(kernel)).error?.code,
    ).toBe('BLD_SHAPE_RANGE');
    expect(kernel.recipes.some((recipe) => recipe.op === 'fillet')).toBe(false);
    const bad = execute(doc, 'fillet_edge', { id, edges: [{ index: 0, size: 1, size2: -1, side1Near: [0, 0, 0] }] }, context(kernel));
    expect(bad.error).toMatchObject({ code: 'BLD_LAW_INVALID', paths: ['edges[0].size2'] });
    const withLaw = execute(doc, 'fillet_edge', { id, edges: [{ index: 0, law: { expression: '1' }, size2: 1 }] }, context(kernel));
    expect(withLaw.error).toMatchObject({ code: 'BLD_LAW_INVALID', paths: ['edges[0].size2'] });
    const none = execute(doc, 'fillet_edge', { id, edges: [{ index: 0, size: 1, size2: 2 }] }, context(kernel));
    expect(none.error).toMatchObject({ code: 'BLD_ASYMMETRIC_SIDE_MISSING', paths: ['edges[0].side1Near'] });
  });

  it('a varying size with a profile is BLD_PROFILE_FAILED on the entry; the kernel is not asked', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const result = execute(
      doc,
      'fillet_edge',
      { id, edges: [{ index: 0, size: 1, sizeEnd: 2 }], profile: { type: 'conic', rho: 0.5 } },
      context(kernel),
    );
    expect(result.error).toMatchObject({ code: 'BLD_PROFILE_FAILED', paths: ['edges[0].sizeEnd'] });
    expect(result.document).toBe(doc);
    expect(kernel.recipes.some((recipe) => recipe.op === 'fillet')).toBe(false);
  });
});

describe('BLD_PROFILE_FAILED from the kernel report', () => {
  const profileReport = (message: string): BlendReport => ({
    stage: 'profile',
    contours: [],
    vertices: [],
    partial: false,
    unsupportedVertices: [],
    done: false,
    valid: false,
    message,
  });

  it('diagnoseBlend maps the profile stage and names the remediation', () => {
    expect(diagnoseBlend(profileReport('edge 2 is not a straight line'))).toMatchObject({
      code: 'BLD_PROFILE_FAILED',
      edges: [],
      message: expect.stringContaining('edge 2 is not a straight line'),
    });
    expect(diagnoseBlend({ ...profileReport(''), message: undefined as never })?.message).toContain('no reason');
    expect(remediationOf('BLD_PROFILE_FAILED')).toContain('circular profile');
  });

  it('a profile fillet the kernel cannot build is refused with the kernel reason and the radius path', () => {
    const base: ScriptedKernel = scriptedKernel();
    const refusing: GeometryKernel = {
      ...base,
      evaluate: (recipe) => (recipe.op === 'fillet' ? null : base.evaluate(recipe)),
      blendReport: () => profileReport('edge 0 meets a curved face (profile blends need two planar faces)'),
    };
    const { doc, id } = box();
    const result = execute(
      doc,
      'fillet_edge',
      { id, edgeIndices: [0], radius: 1, profile: { type: 'conic', rho: 0.5 } },
      context(refusing),
    );
    expectNoOp(result, doc, 'BLD_PROFILE_FAILED');
    expect(result.error).toMatchObject({ code: 'BLD_PROFILE_FAILED', ids: [id], paths: ['radius'] });
    expect(result.summary).toContain('planar faces');
  });
});

describe('recipe, kernel ops, check_blends and export of profile blends', () => {
  const source: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };
  const leaf = (): string | null => null;

  it('recipeKey separates profiles and legs; validateShapeRecipe checks them', () => {
    const base = { op: 'fillet', source, edges: [0], size: 1 } as const;
    const keys = [
      recipeKey(base),
      recipeKey({ ...base, profile: { type: 'conic', rho: 0.5 } }),
      recipeKey({ ...base, profile: { type: 'conic', rho: 0.25 } }),
      recipeKey({ ...base, profile: { type: 'curvature', shape: 0.5 } }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    const withProfile = (profile: unknown): unknown => ({ ...base, profile });
    expect(validateShapeRecipe(withProfile({ type: 'conic', rho: 0.5 }), leaf)).toBeNull();
    expect(validateShapeRecipe(withProfile({ type: 'curvature', shape: 0.5 }), leaf)).toBeNull();
    expect(validateShapeRecipe(withProfile({ type: 'circular' }), leaf)).toBeNull();
    expect(validateShapeRecipe(withProfile({ type: 'conic', rho: 2 }), leaf)).toContain('rho inside 0.05..0.95');
    expect(validateShapeRecipe(withProfile({ type: 'curvature' }), leaf)).toContain('shape inside 0.05..0.95');
    expect(validateShapeRecipe(withProfile({ type: 'wavy' }), leaf)).toContain('profile type');
    expect(validateShapeRecipe(withProfile('conic'), leaf)).toContain('profile must be an object');
    expect(validateShapeRecipe({ op: 'chamfer', source, edges: [0], size: 1, profile: { type: 'conic', rho: 0.5 } }, leaf)).toContain(
      'fillets only',
    );
    const legs = (extra: Record<string, unknown>): unknown => ({ ...base, size: 0, radii: [{ size: 1, ...extra }] });
    expect(validateShapeRecipe(legs({ size2: 2, sideFace: 1 }), leaf)).toBeNull();
    expect(validateShapeRecipe(legs({ size2: 2 }), leaf)).toContain('go together');
    expect(validateShapeRecipe(legs({ sideFace: 1 }), leaf)).toContain('go together');
    expect(validateShapeRecipe(legs({ size2: 0, sideFace: 1 }), leaf)).toContain('size2 must be > 0');
    expect(validateShapeRecipe(legs({ size2: 2, sideFace: -1 }), leaf)).toContain('go together');
  });

  it('an in-process kernel refuses a profile or two-leg fillet instead of rounding it circularly', () => {
    const shape = { mesh: TETRA };
    let built = 0;
    const kernel = kernelFromOps<typeof shape>({
      solid: () => shape,
      boolean: () => null,
      fillet: () => {
        built++;
        return shape;
      },
      filletEach: () => {
        built++;
        return shape;
      },
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
    const base = { op: 'fillet', source, edges: [0], size: 1 } as const;
    expect(kernel.evaluate(base)).not.toBeNull();
    expect(kernel.evaluate({ ...base, profile: { type: 'conic', rho: 0.5 } })).toBeNull();
    expect(kernel.evaluate({ ...base, size: 0, radii: [{ size: 1, size2: 2, sideFace: 0 }] })).toBeNull();
    expect(kernel.evaluate({ ...base, profile: { type: 'circular' } })).not.toBeNull();
    expect(built).toBe(2);
  });

  it('export_code carries BLD_CODEGEN_UNSUPPORTED for a profile fillet and for a two-leg fillet, never a circular one', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const done = execute(doc, 'fillet_edge', { id, edgeIndices: [0], radius: 1, profile: { type: 'conic', rho: 0.5 } }, context(kernel));
    setGeometryKernel(kernel);
    const exported = execute(done.document, 'export_code', { language: 'cadquery' });
    expect(exported.summary).toContain('BLD_CODEGEN_UNSUPPORTED');
    const legs = execute(doc, 'fillet_edge', { id, edges: [{ index: 0, size: 1, size2: 2, side1Near: [0, 0, 0] }] }, context(kernel));
    expect(execute(legs.document, 'export_code', { language: 'build123d' }).summary).toContain('BLD_CODEGEN_UNSUPPORTED');
  });
});

describe('is pure: new fillet_edge paths leave the input document untouched, accepted and refused', () => {
  const ok =
    (params: Record<string, unknown>): ((doc: CadDocument, id: string) => unknown) =>
    (doc, id) =>
      execute(doc, 'fillet_edge', { id, ...params }, context(scriptedKernel({ distance: (face) => (face === 1 ? 0 : 5) })));
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      'profile',
      { edgeIndices: [0], radius: 1, profile: { type: 'conic', rho: 0.5 } },
      { edgeIndices: [0], radius: 1, profile: { type: 'conic', rho: 3 } },
    ],
    ['size2', { edges: [{ index: 0, size: 1, size2: 2, side1Near: [0, 0, 0] }] }, { edges: [{ index: 0, size: 1, size2: 2 }] }],
    [
      'law',
      { edges: [{ index: 0, law: { expression: '1 + 0.5*t', samples: 5 } }] },
      { edges: [{ index: 0, law: { expression: '0 - t' } }] },
    ],
    ['chord on a curved pair', { edges: [{ index: 2, size: 1 }], mode: 'chord' }, { edges: [{ index: 3, size: 1 }], mode: 'chord' }],
  ];
  for (const [name, accepted, refused] of cases)
    it(name, () => {
      const { doc, id } = box();
      const snapshot = JSON.stringify(doc);
      const good = ok(accepted)(doc, id) as ReturnType<typeof execute>;
      expect(good.affected, good.summary).toHaveLength(1);
      expect(JSON.stringify(doc)).toBe(snapshot);
      const bad = ok(refused)(doc, id) as ReturnType<typeof execute>;
      expect(bad.affected).toHaveLength(0);
      expect(bad.document).toBe(doc);
      expect(JSON.stringify(doc)).toBe(snapshot);
    });
});
