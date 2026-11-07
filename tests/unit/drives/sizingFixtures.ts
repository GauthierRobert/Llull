/** The drv_servo_sizing plan as a document builder (its analysis steps removed), with the knobs the sizing and truth tests turn. */
import type { CadDocument } from '@core/model/types';
import { loadPlan, runSteps } from './fixtures';

const ANALYSIS = ['simulate_motion', 'size_drive', 'check_motion_truth', 'evaluate_motion_profile'];

interface Knobs {
  /** Multiplier of the load body mass (so of the load inertia). */
  readonly loadScale?: number;
  /** Grade of the load friction source and of the gear source. */
  readonly grade?: 'A' | 'B' | 'C';
}

/** The servo-sizing mechanism: a RE 40 motor through a 10:1 gear on a 1.37e-3 kg*m^2 disc with friction, position drive on the S-curve index profile. */
export function servoSizingDoc(knobs: Knobs = {}): CadDocument {
  const plan = loadPlan('drv_servo_sizing').filter((step) => !ANALYSIS.includes(step.command));
  for (const step of plan) {
    if (step.command === 'add_rigid_body' && step.params['id'] === 'load' && knobs.loadScale !== undefined)
      step.params['massKg'] = Number(step.params['massKg']) * knobs.loadScale;
    if (knobs.grade !== undefined && step.command === 'set_joint_physics')
      step.params['friction'] = { ...(step.params['friction'] as object), source: { name: 'regraded by the test', grade: knobs.grade } };
    if (knobs.grade !== undefined && step.command === 'add_transmission')
      step.params['source'] = { name: 'regraded by the test', grade: knobs.grade };
  }
  return runSteps(plan).doc;
}
