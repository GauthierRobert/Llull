import { beforeEach, describe, expect, it } from 'vitest';
import { crankJointOf } from '@ui/panels/review/reviewTimelineModel';
import { useStore } from '@ui/store';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';

describe('reviewTimelineModel crank', () => {
  beforeEach(resetStore);

  it('takes the revolute joint of a datasheet dc motor as the crank', () => {
    const disc = localDispatch('add_cylinder', { radius: 20, height: 10, axis: [0, 1, 0] }).affected[0]!;
    const body = localDispatch('add_rigid_body', { entityIds: [disc] }).affected[0]!;
    const joint = localDispatch('add_body_joint', { kind: 'revolute', child: body, anchor: [0, 0, 0], axis: [0, 1, 0] }).affected[0]!;
    localDispatch('add_motor', {
      joint,
      kind: 'dc',
      datasheet: { nominalVoltageV: 48, terminalResistanceOhm: 1.13, torqueConstantNmPerA: 0.0603, rotorInertiaKgM2: 0.0000137 },
      source: { name: 'maxon', grade: 'A' },
    });
    expect(crankJointOf(useStore.getState().document.dynamics)).toBe(joint);
  });

  it('has no crank without dynamics', () => {
    expect(crankJointOf(undefined)).toBeNull();
  });
});
