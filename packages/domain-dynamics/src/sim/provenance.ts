/**
 * Where the numbers of the drive physics come from (PHY-23 TR-DRV-23 (e)): every graded or unsourced input of the dynamics model with its grade,
 * the weakest first. A result is only as good as its weakest input: grade C or no source makes the verdict `plausible`, never `trusted`.
 */

import type { DynamicsModel } from '@core/model/dynamics';
import type { ParameterSource } from '@core/model/drives';
import type { Transmission } from '@core/model/transmissions';

type InputGrade = 'A' | 'B' | 'C' | 'unsourced';

export interface ProvenanceInput {
  /** `<element>.<quantity>`: `j_load.friction`, `tr_gear.efficiency`, `m_re40.datasheet`. */
  readonly id: string;
  readonly grade: InputGrade;
  readonly source: string;
}

const RANK: Readonly<Record<InputGrade, number>> = { A: 0, B: 1, C: 2, unsourced: 3 };

const graded = (id: string, source: ParameterSource | undefined, absent: string): ProvenanceInput => ({
  id,
  grade: source === undefined ? 'unsourced' : source.grade,
  source: source === undefined ? absent : source.name,
});

/** A transmission has an uncertain number to source only when it loses power, locks or has play (an ideal ratio is geometry). */
function transmissionInput(transmission: Transmission): ProvenanceInput | null {
  const lossy =
    transmission.kind === 'lead_screw' ||
    transmission.kind === 'ball_screw' ||
    ('efficiency' in transmission && transmission.efficiency !== undefined) ||
    ('backlashDeg' in transmission && transmission.backlashDeg !== undefined) ||
    ('backlashMm' in transmission && transmission.backlashMm !== undefined);
  return lossy ? graded(`${transmission.id}.losses`, transmission.source, 'no source for the efficiency / friction / play') : null;
}

/** Every sourced or unsourced drive-physics input of `dynamics`, weakest grade first (ties by id). */
export function provenanceOf(dynamics: DynamicsModel): ProvenanceInput[] {
  const inputs: ProvenanceInput[] = [];
  for (const motor of Object.values(dynamics.motors)) {
    if (motor.kind === 'dc') {
      const accepted = motor.acceptInconsistent !== undefined;
      inputs.push(
        accepted
          ? {
              id: `${motor.id}.datasheet`,
              grade: 'C',
              source: `${motor.source.name} (inconsistent sheet accepted: ${motor.acceptInconsistent})`,
            }
          : graded(`${motor.id}.datasheet`, motor.source, ''),
      );
    } else if (motor.kind === 'speed' || motor.kind === 'linear_speed')
      inputs.push(graded(`${motor.id}.effort`, motor.source, 'the torque / force bound has no source'));
    else inputs.push({ id: `${motor.id}.curve`, grade: 'unsourced', source: 'torque curve entered without a source' });
  }
  for (const transmission of Object.values(dynamics.transmissions ?? {})) {
    const input = transmissionInput(transmission);
    if (input !== null) inputs.push(input);
  }
  for (const joint of Object.values(dynamics.joints)) {
    const physics = dynamics.jointPhysics?.[joint.id]?.friction;
    if (physics !== undefined) inputs.push(graded(`${joint.id}.friction`, physics.source, ''));
    else if (joint.friction > 0 || joint.damping > 0)
      inputs.push({ id: `${joint.id}.friction`, grade: 'C', source: 'plain number of add_body_joint (no source)' });
  }
  return inputs.sort((a, b) => RANK[b.grade] - RANK[a.grade] || a.id.localeCompare(b.id));
}

/** The inputs that keep a verdict from `trusted`: grade C or no source. */
export const weakInputs = (inputs: readonly ProvenanceInput[]): ProvenanceInput[] =>
  inputs.filter((input) => input.grade === 'C' || input.grade === 'unsourced');
