/**
 * check_model on a blend_union step that no longer applies (DES-6c): the joint picks of the step are resolved again through the command's own
 * path, so a lost / split / moved joint is reported by index and name with the step id. Scripted kernel (native values: server/tests/nativeBlendJoints.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { CheckResult } from '@core/commands/inspect/checkModel';
import { scriptedKernel } from '../helpers/blendKernel';
import { expectNoOp } from '../helpers/expectNoOp';

const withMessage = (message: string | undefined): GeometryKernel => ({
  ...scriptedKernel(),
  blendReport: () => ({
    stage: 'blend',
    contours: [],
    vertices: [],
    partial: false,
    unsupportedVertices: [],
    done: true,
    valid: true,
    ...(message === undefined ? {} : { message }),
  }),
});

/** Two boxes plus a recorded blend_union step whose result `mesh-gone` is not in the document (the step did not regenerate). */
function failedUnion(joints: unknown[]): { doc: CadDocument; ids: string[] } {
  const built = execute(createEmptyDocument(), 'build_project', {
    actions: [
      { command: 'add_box', params: { size: [4, 4, 1], position: [0, 0, 0.5] } },
      { command: 'add_box', params: { size: [1, 1, 3], position: [0, 0, 2] } },
    ],
  });
  const ids = built.document.order;
  const step = { id: 'step-9', name: 'blend_union', params: { ids, radius: 0.1, joints }, affected: ['mesh-gone'] };
  return { doc: { ...built.document, featureHistory: [...built.document.featureHistory, step] }, ids };
}
const check = (doc: CadDocument): CheckResult['issues'] =>
  (execute(doc, 'check_model', {}).data as CheckResult).issues.filter((i) => i.code.startsWith('REF_'));
const JOINTS = [
  { name: 'e(a|b)', radius: 0.2 },
  { name: 'e(c|d)#2', nameMid: [0, 1, 2], radius: 0.2 },
];

describe('check_model: blend_union joint references', () => {
  afterEach(() => setGeometryKernel(null));

  it('reports a lost joint name by index and name with the step id', () => {
    setGeometryKernel(withMessage("[REF_LOST] joints[1].name: no joint of the union is named 'e(c|d)#2' now (joints: e(a|b))"));
    const { doc, ids } = failedUnion(JOINTS);
    const found = check(doc);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', code: 'REF_LOST', entityId: ids[0] });
    expect(found[0]?.message).toContain("Step 'step-9'");
    expect(found[0]?.message).toContain("joint 1 'e(c|d)#2' is lost");
    expect(found[0]?.message).toContain('edit_step_params');
  });

  it('reports a split joint name, and a #k joint that took another number as moved', () => {
    setGeometryKernel(withMessage("[REF_SPLIT] joints[0].name: 'e(a|b)' now names 2 joints (e(a|b)#1, e(a|b)#2)"));
    const { doc } = failedUnion(JOINTS);
    expect(check(doc)[0]).toMatchObject({ code: 'REF_SPLIT' });
    expect(check(doc)[0]?.message).toContain("joint 0 'e(a|b)' is split");
    setGeometryKernel(
      withMessage('[REF_LOST] joints[1].name: the numbering of the joints of those faces changed (moved 12 from its midpoint)'),
    );
    expect(check(doc)[0]?.message).toContain("joint 1 'e(c|d)#2' is lost (moved: the #k number now belongs to another joint)");
  });

  it('a healthy union, an applied step, a suppressed step, no kernel and other kernel refusals give no joint finding', () => {
    setGeometryKernel(withMessage(undefined));
    const { doc } = failedUnion(JOINTS);
    expect(check(doc)).toEqual([]);
    setGeometryKernel(withMessage('[BLD_JOINT_PARAMS] joints[0].radius: a radius that varies needs a joint alone'));
    expect(check(doc)).toEqual([]);
    setGeometryKernel(withMessage("[REF_LOST] joints[0].name: no joint of the union is named 'x' now"));
    const applied = { ...doc, entities: { ...doc.entities } };
    applied.featureHistory = doc.featureHistory.map((s) => (s.id === 'step-9' ? { ...s, affected: doc.order } : s));
    expect(check(applied)).toEqual([]);
    applied.featureHistory = doc.featureHistory.map((s) => (s.id === 'step-9' ? { ...s, suppressed: true } : s));
    expect(check(applied)).toEqual([]);
    setGeometryKernel(null);
    expect(check(doc)).toEqual([]);
  });

  it('ignores a step with unreadable params; the query stays pure', () => {
    setGeometryKernel(withMessage('[REF_LOST] joints[0].name: gone'));
    const { doc } = failedUnion([{ radius: 'wide' }]);
    expect(check(doc)).toEqual([]);
    const bad = {
      ...doc,
      featureHistory: doc.featureHistory.map((s) => (s.id === 'step-9' ? { ...s, params: { ids: ['nope'], radius: 1 } } : s)),
    };
    expect(check(bad)).toEqual([]);
    const ok = failedUnion(JOINTS).doc;
    expectNoOp(execute(ok, 'check_model', {}), ok);
  });
});

describe('blend_union: a base joint name with a single #k image', () => {
  afterEach(() => setGeometryKernel(null));
  it('the kernel REF_SPLIT for a base name is kept by the command as a refusal with the name path', () => {
    setGeometryKernel({
      ...withMessage("[REF_SPLIT] joints[0].name: 'e(a|b)' now names 1 joint (e(a|b)#1); name it in full"),
      evaluate: () => null,
    });
    const { doc, ids } = failedUnion([]);
    const refused = execute(doc, 'blend_union', { ids, radius: 0.1, joints: [{ name: 'e(a|b)', radius: 0.2 }] });
    expectNoOp(refused, doc, 'now names 1 joint');
    expect(refused.error).toMatchObject({ code: 'REF_SPLIT', paths: ['joints[0].name'] });
  });
});
