/** SC-F4: contact sets stop driven motion at the first contact (bisection to tolerance). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';

function instanceAt(doc: CadDocument, position: Vec3): { doc: CadDocument; id: string } {
  const box = execute(doc, 'add_box', { size: [1, 1, 1] });
  const name = `part${Object.keys(box.document.components).length}`;
  const withComponent = execute(box.document, 'create_component', { name, entityIds: [box.affected[0]] }).document;
  const componentId = Object.keys(withComponent.components).at(-1);
  const instance = execute(withComponent, 'insert_instance', { componentId, position });
  return { doc: instance.document, id: instance.affected[0] ?? '' };
}

/** A unit slider on a rail along x and a unit block 10 units away: they touch after exactly 9 units of travel. */
function sliderAndBlock(blockAt = 10): { doc: CadDocument; slider: string; block: string; rail: string; set: string } {
  const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
  const slider = instanceAt(ground.doc, [0, 0, 0]);
  const block = instanceAt(slider.doc, [blockAt, 0, 0]);
  const rail = execute(block.doc, 'add_joint', {
    kind: 'prismatic',
    a: { instanceId: ground.id },
    b: { instanceId: slider.id },
    axis: 'x',
  });
  const set = execute(rail.document, 'create_contact_set', { pairs: [[slider.id, block.id]], name: 'stop' });
  return { doc: set.document, slider: slider.id, block: block.id, rail: rail.affected[0] ?? '', set: set.affected[0] ?? '' };
}

describe('contact sets', () => {
  it('create_contact_set stores the pairs; delete removes them; pure', () => {
    const scene = sliderAndBlock();
    expect(scene.doc.contactSets?.[scene.set]).toEqual({ id: scene.set, name: 'stop', pairs: [[scene.slider, scene.block]] });
    const removed = execute(scene.doc, 'delete_contact_set', { id: scene.set });
    expect(removed.document.contactSets).toEqual({});
    expect(scene.doc.contactSets?.[scene.set]).toBeDefined();
  });

  it('create_contact_set refuses empty, self, unknown, non-instance and duplicate input', () => {
    const scene = sliderAndBlock();
    const box = execute(scene.doc, 'add_box', { size: [1, 1, 1] });
    const boxId = box.affected[0] ?? '';
    for (const pairs of [[], [[scene.slider, scene.slider]], [[scene.slider, 'ghost']], [[scene.slider, boxId]]]) {
      const result = execute(box.document, 'create_contact_set', { pairs });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(box.document);
    }
    const duplicate = execute(scene.doc, 'create_contact_set', { pairs: [[scene.slider, scene.block]], id: scene.set });
    expect(duplicate.affected).toEqual([]);
    expect(execute(scene.doc, 'delete_contact_set', { id: 'ghost' }).affected).toEqual([]);
  });

  it('drive_joint_to stops at the analytic contact distance (block face at 9 units)', () => {
    const scene = sliderAndBlock();
    const driven = execute(scene.doc, 'drive_joint_to', { jointId: scene.rail, target: 20, contactSetId: scene.set, tolerance: 1e-7 });
    const data = driven.data as { reached: number; stopped: boolean; reason: string; pair: string[] };
    expect(data.stopped).toBe(true);
    expect(data.reason).toBe('contact');
    expect(data.pair).toEqual([scene.slider, scene.block]);
    expect(data.reached).toBeLessThanOrEqual(9 + 1e-6);
    expect(data.reached).toBeGreaterThan(9 - 1e-6);
    expect(driven.summary).toContain('contact');
    expect(driven.document.joints[scene.rail]).toMatchObject({ displacement: data.reached });
    expect(scene.doc.joints[scene.rail]).toMatchObject({ displacement: 0 });
  });

  it('motion_study with contactSetId ends the sweep at the contact value', () => {
    const scene = sliderAndBlock();
    const study = execute(scene.doc, 'motion_study', {
      mode: 'joint',
      target: scene.rail,
      start: 0,
      end: 20,
      steps: 5,
      contactSetId: scene.set,
    });
    const data = study.data as { steps: { sweepValue: number }[]; contact: { stopped: boolean; stopValue: number } };
    expect(data.contact.stopped).toBe(true);
    expect(data.contact.stopValue).toBeCloseTo(9, 6);
    expect(data.steps.at(-1)?.sweepValue).toBeCloseTo(9, 6);
    expect(study.summary).toContain('Motion stops at');
  });

  it('no contact in range: the joint reaches the target; limits clamp the target', () => {
    const scene = sliderAndBlock();
    const free = execute(scene.doc, 'drive_joint_to', { jointId: scene.rail, target: 5, contactSetId: scene.set });
    expect(free.data).toMatchObject({ reached: 5, stopped: false });
    const study = execute(scene.doc, 'motion_study', { mode: 'joint', target: scene.rail, start: 0, end: 5, contactSetId: scene.set });
    expect((study.data as { contact: { stopped: boolean } }).contact.stopped).toBe(false);
    expect(study.summary).toContain('No contact');
    const limited = { ...scene.doc, joints: { ...scene.doc.joints } };
    const joint = limited.joints[scene.rail];
    if (joint) limited.joints[scene.rail] = { ...joint, limits: [{ max: 3 }] };
    const clamped = execute(limited, 'drive_joint_to', { jointId: scene.rail, target: 8 });
    expect(clamped.data).toMatchObject({ reached: 3, stopped: false });
    expect(clamped.summary).toContain('clamped');
  });

  it('already touching at the start: the motion does not move; parameter mode also stops', () => {
    const scene = sliderAndBlock(0.5);
    const driven = execute(scene.doc, 'drive_joint_to', { jointId: scene.rail, target: 4, contactSetId: scene.set });
    expect(driven.data).toMatchObject({ reached: 0, stopped: true });
    const withParameter = execute(sliderAndBlock().doc, 'set_parameter', { name: 'travel', value: 0 });
    const study = execute(withParameter.document, 'motion_study', {
      mode: 'parameter',
      target: 'travel',
      start: 0,
      end: 20,
      contactSetId: 'ghost',
    });
    expect(study.affected).toEqual([]);
    expect(study.summary).toContain('does not exist');
  });

  it('refuses unknown joints, sets, bad dof, cam joints and bad targets', () => {
    const scene = sliderAndBlock();
    for (const params of [
      { jointId: 'ghost', target: 1 },
      { jointId: scene.rail, target: 1, contactSetId: 'ghost' },
      { jointId: scene.rail, target: 1, dof: 3 },
      { jointId: scene.rail, target: 'not an expression +' },
    ]) {
      const result = execute(scene.doc, 'drive_joint_to', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(scene.doc);
    }
  });
});
