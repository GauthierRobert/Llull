/**
 * BLD M5 (13.32): joints of blend_union picked by persistent name and given radius laws. Params, recipe, step recording and the refusals, over a scripted kernel
 * (native values and the closed-form volumes: server/tests/nativeBlendJoints.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, type MeshData, type MeshSolidEntity, type ShapeRecipe, createEmptyDocument } from '@core/model/types';
import type { JointRadius } from '@core/model/blendTypes';
import { execute, getCommand } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { fakeKernel } from '../helpers/fakeKernel';
import { scriptedKernel } from '../helpers/blendKernel';
import { expectNoOp } from '../helpers/expectNoOp';

const BLEND_MESH: MeshData = { positions: [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0], indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3] };

function pair(): { doc: CadDocument; ids: string[] } {
  const result = execute(createEmptyDocument(), 'build_project', {
    actions: [
      { command: 'add_box', params: { size: [4, 4, 1], position: [0, 0, 0.5] } },
      { command: 'add_box', params: { size: [1, 1, 3], position: [0, 0, 2] } },
    ],
  });
  return { doc: result.document, ids: result.document.order };
}

const report = (extra: Partial<ReturnType<NonNullable<GeometryKernel['blendReport']>>>): NonNullable<GeometryKernel['blendReport']> => {
  return () => ({ stage: 'blend', contours: [], vertices: [], partial: false, unsupportedVertices: [], done: true, valid: true, ...extra });
};
/** A kernel that builds every blend and reports `blendReport`; with `refuse` it builds nothing. */
const withReport = (blendReport: NonNullable<GeometryKernel['blendReport']>, refuse = false): GeometryKernel => ({
  ...scriptedKernel(),
  ...(refuse ? { evaluate: () => null } : {}),
  blendReport,
});
const blendOf = (doc: CadDocument, id: string): Extract<ShapeRecipe, { op: 'blend' }> =>
  (doc.entities[id] as MeshSolidEntity).brep as Extract<ShapeRecipe, { op: 'blend' }>;

describe('blend_union joints: radius laws', () => {
  afterEach(() => setGeometryKernel(null));

  it('records the law of a joint on the recipe: radius at the start, radiusEnd, control points, interpolation, and the key separates them', () => {
    setGeometryKernel(scriptedKernel());
    const { doc, ids } = pair();
    const joint: JointRadius = { near: [1, 1, 1], radius: 0.2, radiusEnd: 0.4, sizes: [{ t: 0.5, size: 0.3 }], interpolation: 'linear' };
    const result = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [joint] });
    expect(result.rejected).toBeUndefined();
    const recipe = blendOf(result.document, result.affected[0] as string);
    expect(recipe.joints).toEqual([joint]);
    expect(recipeKey(recipe)).not.toBe(recipeKey({ ...recipe, joints: [{ ...joint, radiusEnd: 0.5 }] }));
    expect(recipeKey(recipe)).not.toBe(recipeKey({ ...recipe, joints: [{ ...joint, name: 'e(a|b)' }] }));
  });

  it('an expression law is sampled into the recipe like a fillet_edge law', () => {
    setGeometryKernel(scriptedKernel());
    const { doc, ids } = pair();
    const result = execute(doc, 'blend_union', {
      ids,
      radius: 0.1,
      joints: [{ name: 'e(a|b)', law: { expression: '0.2 + 0.2*t', samples: 5 } }],
    });
    const joint = blendOf(result.document, result.affected[0] as string).joints?.[0];
    expect(joint).toMatchObject({ name: 'e(a|b)', radius: 0.2 });
    expect(joint?.radiusEnd).toBeCloseTo(0.4, 12);
    expect(joint?.sizes?.map((point) => point.t)).toEqual([0.25, 0.5, 0.75]);
    expect(joint?.sizes?.[1]?.size).toBeCloseTo(0.3, 12);
  });

  it.each([
    ['neither near nor name', { radius: 0.2 }, 'BLD_JOINT_PARAMS', 'joints[0].near', 'needs near'],
    ['neither radius nor law', { near: [0, 0, 0] }, 'BLD_JOINT_PARAMS', 'joints[0].radius', 'needs radius, or law'],
    ['a radius <= 0', { near: [0, 0, 0], radius: 0 }, 'BLD_JOINT_PARAMS', 'joints[0].radius', 'radius must be > 0'],
    ['a radiusEnd <= 0', { near: [0, 0, 0], radius: 1, radiusEnd: 0 }, 'BLD_LAW_INVALID', 'joints[0].radiusEnd', 'radiusEnd must be > 0'],
    [
      'control points out of order',
      { near: [0, 0, 0], radius: 1, sizes: [{ t: 1.5, size: 1 }] },
      'BLD_LAW_INVALID',
      'joints[0].sizes[0].t',
      'strictly increasing',
    ],
    [
      'a law that is not an expression of t',
      { near: [0, 0, 0], law: { expression: 'x + 1' } },
      'BLD_LAW_INVALID',
      'joints[0].law.expression',
      'law.expression',
    ],
    ['a law next to a radius', { near: [0, 0, 0], radius: 1, law: { expression: '1' } }, 'BLD_LAW_INVALID', 'joints[0].law', 'either law'],
  ])('%s -> %s at %s, before the kernel is asked', (_label, joint, code, path, text) => {
    const fake = fakeKernel({ blend: BLEND_MESH });
    setGeometryKernel(fake);
    const { doc, ids } = pair();
    const refused = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [joint] });
    expectNoOp(refused, doc, text);
    expect(refused.error).toMatchObject({ code, paths: [path] });
    expect(fake.calls.filter((call) => call.op === 'blend')).toHaveLength(0);
  });

  it('the tool schema offers name and the law fields on a joint, and the description says what a law needs', () => {
    const command = getCommand('blend_union');
    const joint = JSON.stringify(command?.paramsSchema);
    for (const field of ['name', 'radiusEnd', 'sizes', 'interpolation', 'law']) expect(joint).toContain(`"${field}"`);
    expect(command?.description).toContain('alone in its tangent chain');
    expect(command?.description).toContain('REF_LOST');
  });
});

describe('blend_union joints: persistent names', () => {
  afterEach(() => setGeometryKernel(null));
  const picked = (names: Array<string | undefined>): NonNullable<GeometryKernel['blendReport']> =>
    report({
      notes: {
        builder: 'union',
        picks: names.map((name, at) => ({
          distance: 0.5 * at,
          radius: 0.2,
          ...(name === undefined ? {} : { name }),
          start: [0, 0, 0],
          end: [1, 0, 0],
        })),
        contours: [],
      },
    });

  it('a pick by point records the name of the joint it found in the step, and data.joints lists it with the ends of the joint', () => {
    setGeometryKernel(withReport(picked(['e(box-1.1:z+|box-2.1:x-)'])));
    const { doc, ids } = pair();
    const result = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ near: [1, 1, 1], radius: 0.2 }] });
    expect(result.rejected).toBeUndefined();
    expect(result.data).toMatchObject({
      joints: [{ index: 0, radius: 0.2, name: 'e(box-1.1:z+|box-2.1:x-)', start: [0, 0, 0], end: [1, 0, 0] }],
    });
    const step = result.document.featureHistory.at(-1);
    expect(step?.params).toMatchObject({ joints: [{ near: [1, 1, 1], radius: 0.2, name: 'e(box-1.1:z+|box-2.1:x-)' }] });
  });

  it('a pick that already has a name records nothing (the step keeps the name it was given)', () => {
    setGeometryKernel(withReport(picked(['e(box-1.1:z+|box-2.1:x-)#1'])));
    const { doc, ids } = pair();
    const result = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ name: 'e(box-1.1:z+|box-2.1:x-)', radius: 0.2 }] });
    const step = result.document.featureHistory.at(-1);
    expect(step?.params).toMatchObject({ joints: [{ name: 'e(box-1.1:z+|box-2.1:x-)' }] });
  });

  it('a #k name records the midpoint of its joint with it (nameMid), a plain name does not', () => {
    const notes = (name: string): NonNullable<GeometryKernel['blendReport']> =>
      report({
        notes: {
          builder: 'union',
          picks: [{ distance: 0, radius: 0.2, name, start: [0, 0, 0], end: [1, 0, 0], mid: [0.5, 2, 0] }],
          contours: [],
        },
      });
    const { doc, ids } = pair();
    setGeometryKernel(withReport(notes('e(a|b)#2')));
    const numbered = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ near: [1, 1, 1], radius: 0.2 }] });
    expect(numbered.document.featureHistory.at(-1)?.params).toMatchObject({ joints: [{ name: 'e(a|b)#2', nameMid: [0.5, 2, 0] }] });
    setGeometryKernel(withReport(notes('e(a|b)')));
    const plain = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ near: [1, 1, 1], radius: 0.2 }] });
    expect(JSON.stringify(plain.document.featureHistory.at(-1)?.params)).not.toContain('nameMid');
    // replayed from the recorded step, the midpoint reaches the recipe with its name and is dropped without one
    const params = numbered.document.featureHistory.at(-1)?.params as Record<string, unknown>;
    const replayed = execute(doc, 'blend_union', params);
    expect(blendOf(replayed.document, replayed.affected[0] as string).joints?.[0]).toMatchObject({
      name: 'e(a|b)#2',
      nameMid: [0.5, 2, 0],
    });
    const nameless = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ near: [1, 1, 1], nameMid: [1, 2, 3], radius: 0.2 }] });
    expect(JSON.stringify(blendOf(nameless.document, nameless.affected[0] as string).joints)).not.toContain('nameMid');
  });

  it('a pick with both a name and near says near is ignored, in the summary and in data.joints', () => {
    setGeometryKernel(withReport(picked(['e(a|b)'])));
    const { doc, ids } = pair();
    const both = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ name: 'e(a|b)', near: [1, 1, 1], radius: 0.2 }] });
    expect(both.summary).toContain('joints[0] picked by name e(a|b); near ignored');
    expect(both.data).toMatchObject({ joints: [{ index: 0, nearIgnored: true }] });
    const byPoint = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ near: [1, 1, 1], radius: 0.2 }] });
    expect(byPoint.summary).not.toContain('near ignored');
  });

  it('a kernel that names no joint leaves the step as it was given', () => {
    setGeometryKernel(withReport(picked([undefined])));
    const { doc, ids } = pair();
    const result = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ near: [1, 1, 1], radius: 0.2 }] });
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ joints: [{ near: [1, 1, 1], radius: 0.2 }] });
    expect(result.data).toMatchObject({ joints: [{ index: 0, radius: 0.2 }] });
  });

  it.each([
    [
      'REF_LOST',
      "[REF_LOST] joints[1].name: no joint of the union is named 'e(a|b)' now (joints: e(c|d))",
      'joints[1].name',
      'no joint of the union',
    ],
    ['REF_SPLIT', "[REF_SPLIT] joints[0].name: 'e(a|b)' now names 2 joints (e(a|b)#1, e(a|b)#2)", 'joints[0].name', 'now names 2 joints'],
    [
      'BLD_LAW_NOT_PERIODIC',
      '[BLD_LAW_NOT_PERIODIC] joints[0].radiusEnd: the joint is a closed curve, so the radius must return to its start',
      'joints[0].radiusEnd',
      'closed curve',
    ],
    [
      'BLD_JOINT_PARAMS',
      '[BLD_JOINT_PARAMS] joints[0].radiusEnd: a radius that varies along a joint needs a joint alone in its tangent chain',
      'joints[0].radiusEnd',
      'alone in its tangent chain',
    ],
  ])('the kernel words a refusal about a pick: %s keeps its code, path and reason', (code, message, path, text) => {
    setGeometryKernel(withReport(report({ done: false, valid: false, message }), true));
    const { doc, ids } = pair();
    const refused = execute(doc, 'blend_union', {
      ids,
      radius: 0.1,
      joints: [
        { name: 'e(a|b)', radius: 0.2 },
        { near: [0, 0, 0], radius: 0.2 },
      ],
    });
    expectNoOp(refused, doc, text);
    expect(refused.error).toMatchObject({ code, paths: [path] });
    expect(refused.error?.remediation.length).toBeGreaterThan(20);
    if (code.startsWith('REF_')) expect(refused.error?.remediation).toContain('edit_step_params');
  });
});

describe('blend recipes with named joints', () => {
  const leaf = (id: string): ShapeRecipe => ({
    op: 'solid',
    entity: { id, kind: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'layer-default', color: '#888888' },
  });
  const blend = (joints: unknown): ShapeRecipe => ({ op: 'blend', sources: [leaf('a'), leaf('b')], radius: 1, joints: joints as never });
  it('accepts a name, a point, or both, with a law the fillet laws accept', () => {
    expect(validateShapeRecipe(blend([{ name: 'e(a|b)', radius: 0.5 }]))).toBeNull();
    expect(
      validateShapeRecipe(blend([{ near: [0, 0, 0], radius: 0.5, radiusEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'monotone' }])),
    ).toBeNull();
    expect(validateShapeRecipe(blend([{ name: 'e(a|b)', near: [0, 0, 0], radius: 0.5 }]))).toBeNull();
    expect(validateShapeRecipe(blend([{ name: 'e(a|b)#1', nameMid: [0, 1, 2], radius: 0.5 }]))).toBeNull();
    expect(validateShapeRecipe(blend([{ name: 'e(a|b)#1', nameMid: [0, 1], radius: 0.5 }]))).not.toBeNull();
  });
  it.each([
    ['neither near nor name', { radius: 0.5 }],
    ['an empty name', { name: '', radius: 0.5 }],
    ['a name with a newline', { name: 'a' + String.fromCharCode(10) + 'b', radius: 0.5 }],
    ['a malformed point next to a name', { name: 'e(a|b)', near: [0, 0], radius: 0.5 }],
    ['a radiusEnd <= 0', { name: 'e(a|b)', radius: 0.5, radiusEnd: 0 }],
    [
      'control points out of order',
      {
        name: 'e(a|b)',
        radius: 0.5,
        sizes: [
          { t: 0.6, size: 1 },
          { t: 0.4, size: 1 },
        ],
      },
    ],
    ['an unknown interpolation', { name: 'e(a|b)', radius: 0.5, interpolation: 'cubic' }],
  ])('refuses %s', (_label, joint) => {
    expect(validateShapeRecipe(blend([joint]))).toContain('joints must be');
  });
});
