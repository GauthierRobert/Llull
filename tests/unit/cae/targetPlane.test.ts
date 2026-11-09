/** intersectPlane targets (resolved by llull-mesh): accepted with facesNear by every command that takes an FEA target, refused without it. */

import { describe, expect, it } from 'vitest';
import { expectNoOp } from '../../helpers/expectNoOp';
import { caseIn, modelWithAnalysis, run } from './helpers';

const plane = { point: [5, 0, 0], normal: [1, 0, 0] };

describe('intersectPlane targets', () => {
  it.each([
    ['add_fea_constraint', { name: 'pin', kind: 'fixed' }],
    ['add_fea_load', { name: 'f', kind: 'force', vector: [0, 0, -1] }],
  ])('%s accepts a target with facesNear + intersectPlane and stores the plane', (command, params) => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const target = { entityId: boxId, facesNear: [[5, 5, 10]], intersectPlane: plane };
    const result = run(doc, command, { analysisId, ...params, target });
    expect(result.error).toBeUndefined();
    const stored = caseIn(result.document, analysisId);
    const item = Object.values(command === 'add_fea_load' ? stored.loads : stored.constraints)[0];
    expect(item?.target).toMatchObject({ entityId: boxId, intersectPlane: plane });
  });

  it('set_mesh_controls accepts a refinement target with intersectPlane', () => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const result = run(doc, 'set_mesh_controls', {
      analysisId,
      refinements: [{ target: { entityId: boxId, facesNear: [[5, 5, 10]], intersectPlane: plane }, size: 2 }],
    });
    expect(result.error).toBeUndefined();
    expect(caseIn(result.document, analysisId).mesh.refinements[0]?.target.intersectPlane).toEqual(plane);
  });

  it.each([
    ['add_fea_constraint', { name: 'pin', kind: 'fixed' }],
    ['add_fea_load', { name: 'f', kind: 'force', vector: [0, 0, -1] }],
  ])('%s refuses intersectPlane without facesNear (the plane cuts the selected faces)', (command, params) => {
    const { doc, boxId, analysisId } = modelWithAnalysis();
    const result = run(doc, command, { analysisId, ...params, target: { entityId: boxId, edgesNear: [[5, 0, 0]], intersectPlane: plane } });
    expectNoOp(result, doc);
    expect(result.error?.code).toBe('FEA_TARGET_UNRESOLVED');
    expect(result.summary).toContain('intersectPlane needs facesNear');
  });
});
