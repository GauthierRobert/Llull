import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** A 2x2x2 component box instanced at x=100 (world bounds x 99..101) plus a 2x2x2 box at the origin. */
function scene(): { doc: CadDocument; instanceId: string; boxId: string } {
  const part = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const component = execute(part.document, 'create_component', {
    name: 'Part',
    entityIds: [part.affected[0]!],
    componentId: 'comp-part',
  });
  const inserted = execute(component.document, 'insert_instance', {
    componentId: 'comp-part',
    position: [100, 0, 0],
  });
  const box = execute(inserted.document, 'add_box', { size: [2, 2, 2] });
  return { doc: box.document, instanceId: inserted.affected[0]!, boxId: box.affected[0]! };
}

const matchIds = (result: { data?: unknown }): string[] =>
  (result.data as { matches: Array<{ id: string }> }).matches.map((match) => match.id);

describe('bounds-based commands see an instance at its real extent', () => {
  const { doc, instanceId, boxId } = scene();

  it('align moves a box onto the instance max-x edge', () => {
    const result = execute(doc, 'align', {
      targetIds: [boxId],
      edge: 'max-x',
      referenceId: instanceId,
    });
    expect(result.affected).toEqual([boxId]);
    expect(result.document.entities[boxId]!.position[0]).toBeCloseTo(100);
  });

  it('stack_on rests a box against the instance max-x face', () => {
    const result = execute(doc, 'stack_on', { movingId: boxId, baseId: instanceId, axis: 'x' });
    expect(result.document.entities[boxId]!.position[0]).toBeCloseTo(102);
  });

  it('distribute treats the instance as the far anchor', () => {
    const middle = execute(doc, 'add_box', { size: [2, 2, 2], position: [10, 0, 0] });
    const result = execute(middle.document, 'distribute', {
      targetIds: [boxId, middle.affected[0]!, instanceId],
      axis: 'x',
    });
    expect(result.document.entities[middle.affected[0]!]!.position[0]).toBeCloseTo(50);
  });

  it('find_entities locates the instance by bounding box and by proximity', () => {
    const inBox = execute(doc, 'find_entities', {
      kind: 'instance',
      overlapsBBox: [
        [98, -5, -5],
        [102, 5, 5],
      ],
    });
    expect(matchIds(inBox)).toEqual([instanceId]);
    const near = execute(doc, 'find_entities', {
      nearPoint: { point: [100, 0, 0], radius: 3 },
    });
    expect(matchIds(near)).toEqual([instanceId]);
  });

  it('measure_distance between box and instance uses the instance center', () => {
    const result = execute(doc, 'measure_distance', { entityId1: boxId, entityId2: instanceId });
    expect((result.data as { distance: number }).distance).toBeCloseTo(100);
  });

  it('check_model flags an instance far from the origin', () => {
    const result = execute(doc, 'check_model', { farThreshold: 50 });
    const issues = (result.data as { issues: Array<{ entityId?: string; code: string }> }).issues;
    expect(issues.map((issue) => issue.entityId)).toEqual([instanceId]);
  });
});
