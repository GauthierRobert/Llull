/** The outputs of a run the timestep study compares across step sizes (PHY-23 TR-DRV-23 (b)): what each is, its unit and how to read it from a run. */

import { peakAbs, rmsOver } from '../sizing';
import type { RunData } from '../runData';

export interface OutputDef {
  /** `<joint>.finalVelocity`, `<motor>.rmsJointTorque`, `energy.balanceErrorJ`, ... */
  readonly key: string;
  /** 'value': a quantity whose GCI is relative to itself; 'error': a numerical error that is itself expected to shrink with the step. */
  readonly kind: 'value' | 'error';
  readonly unit: string;
  /** The value in a run of the same model, or null when that run does not report it. */
  readonly read: (run: RunData) => number | null;
}

/** Largest kinetic or |potential| energy of a run, J: the scale a numerical energy error is measured against (0 when nothing moves or no series). */
export function energyScale(run: RunData): number {
  const energy = run.series?.energy;
  return energy === undefined ? 0 : Math.max(peakAbs(energy.kinetic), peakAbs(energy.potential));
}

const present = (value: number | undefined): number | null => (value === undefined || !Number.isFinite(value) ? null : value);

/**
 * The catalogue of a run: every joint's final position / speed (and period when periodic), every driven motor's RMS joint torque and RMS / peak current, and
 * the numerical errors of the energy balance and the ledger. Keys are stable across step sizes of the same model.
 */
export function outputCatalogue(run: RunData): OutputDef[] {
  const defs: OutputDef[] = [];
  for (const [id, joint] of Object.entries(run.joints)) {
    const [positionUnit, speedUnit] = joint.kind === 'revolute' ? ['rad', 'rad/s'] : ['m', 'm/s'];
    defs.push(
      { key: `${id}.finalPosition`, kind: 'value', unit: positionUnit, read: (r) => present(r.joints[id]?.finalPosition) },
      { key: `${id}.finalVelocity`, kind: 'value', unit: speedUnit, read: (r) => present(r.joints[id]?.finalVelocity) },
    );
    if (joint.periodic === true) defs.push({ key: `${id}.periodS`, kind: 'value', unit: 's', read: (r) => present(r.joints[id]?.periodS) });
  }
  for (const [id, drive] of Object.entries(run.drives ?? {})) {
    if (drive.series === undefined) continue;
    defs.push(
      {
        key: `${id}.rmsJointTorque`,
        kind: 'value',
        unit: 'N*m',
        read: (r) => {
          const series = r.drives?.[id]?.series;
          return series === undefined ? null : present(rmsOver(series.times, series.jointTorqueNm));
        },
      },
      {
        key: `${id}.rmsCurrent`,
        kind: 'value',
        unit: 'A',
        read: (r) => {
          const series = r.drives?.[id]?.series;
          return series === undefined ? null : present(rmsOver(series.times, series.currentA));
        },
      },
      { key: `${id}.peakCurrent`, kind: 'value', unit: 'A', read: (r) => present(r.drives?.[id]?.peak.currentA) },
    );
  }
  if (run.energy?.balanceErrorJ !== undefined)
    defs.push({
      key: 'energy.balanceErrorJ',
      kind: 'error',
      unit: 'J',
      read: (r) => present(Math.abs(r.energy?.balanceErrorJ ?? Number.NaN)),
    });
  if (run.ledger !== undefined)
    defs.push({
      key: 'ledger.closureErrorJ',
      kind: 'error',
      unit: 'J',
      read: (r) => present(Math.abs(r.ledger?.closureErrorJ ?? Number.NaN)),
    });
  return defs;
}
