/** intersectPlane targets are refused by every command that takes an FEA target until llull-mesh resolves them (FEA_TARGET_PLANE_UNSUPPORTED). */

import { describe, expect, it } from 'vitest';
import { expectNoOp } from '../../helpers/expectNoOp';
import { caseIn, modelWithAnalysis, run } from './helpers';

const plane = { point: [0, 0, 0], normal: [0, 0, 1] };

describe('intersectPlane targets', () => {
  it.each([
    ['add_fea_constraint', { name: 'pin', kind: 'fixed' }],
    ['add_fea_load', { name: 'f', kind: 'force', vector: [0, 0, -1] }],
  ])('%s refuses a target with intersectPlane and leaves the document unchanged', (command, params) => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const result = run(doc, command, { analysisId, ...params, target: { entityId: boxId, facesNear: [[5, 5, 0]], intersectPlane: plane } });
    expectNoOp(result, doc);
    expect(result.error?.code).toBe('FEA_TARGET_PLANE_UNSUPPORTED');
    expect(result.summary).toContain('mesher does not honour');
  });

  it('set_mesh_controls refuses a refinement target with intersectPlane', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const result = run(doc, 'set_mesh_controls', {
      analysisId,
      refinements: [{ target: { entityId: boxId, facesNear: [[5, 5, 0]], intersectPlane: plane }, size: 2 }],
    });
    expectNoOp(result, doc);
    expect(result.error?.code).toBe('FEA_TARGET_PLANE_UNSUPPORTED');
  });

  it('the same targets without intersectPlane are accepted', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const result = run(doc, 'add_fea_constraint', {
      analysisId,
      name: 'pin',
      kind: 'fixed',
      target: { entityId: boxId, facesNear: [[5, 5, 0]] },
    });
    expect(result.error).toBeUndefined();
    expect(caseIn(result.document, analysisId).constraintOrder).toHaveLength(1);
  });
});
