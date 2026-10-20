/** SC-F4: kinematic joint names on add_body_joint map to MuJoCo hinge / slide / ball, the rest are refused with the composition to use. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

function bodies(): CadDocument {
  let doc = createEmptyDocument();
  const base = execute(doc, 'add_box', { size: [10, 10, 10] });
  const link = execute(base.document, 'add_box', { size: [10, 10, 10], position: [20, 0, 0] });
  doc = execute(link.document, 'add_rigid_body', { id: 'frame', entityIds: [base.affected[0]], fixed: true }).document;
  return execute(doc, 'add_rigid_body', { id: 'arm', entityIds: [link.affected[0]] }).document;
}

describe('add_body_joint with kinematic kind names', () => {
  it('ball maps to the spherical (MuJoCo ball) joint; revolute and prismatic are unchanged', () => {
    const doc = bodies();
    const hinge = execute(doc, 'add_body_joint', {
      id: 'j1',
      kind: 'revolute',
      child: 'arm',
      parent: 'frame',
      anchor: [0, 0, 0],
      axis: [0, 1, 0],
    });
    const ball = execute(hinge.document, 'add_body_joint', { id: 'j2', kind: 'ball', child: 'arm', parent: 'frame', anchor: [0, 0, 0] });
    expect(ball.document.dynamics?.joints['j2']?.kind).toBe('spherical');
    expect(ball.summary).toContain('spherical');
    const slide = execute(doc, 'add_body_joint', {
      id: 'j3',
      kind: 'prismatic',
      child: 'arm',
      parent: 'frame',
      anchor: [0, 0, 0],
      axis: [1, 0, 0],
    });
    expect(slide.document.dynamics?.joints['j3']?.kind).toBe('prismatic');
  });

  it.each(['rigid', 'cylindrical', 'pin_slot', 'planar', 'cam'] as const)('%s is refused with a composition hint and no change', (kind) => {
    const doc = bodies();
    const refused = execute(doc, 'add_body_joint', { id: 'jx', kind, child: 'arm', parent: 'frame', anchor: [0, 0, 0], axis: [0, 0, 1] });
    expect(refused.affected).toEqual([]);
    expect(refused.document).toBe(doc);
    expect(refused.summary).toContain('no single MuJoCo joint');
    expect(refused.summary).toContain(kind);
  });
});
