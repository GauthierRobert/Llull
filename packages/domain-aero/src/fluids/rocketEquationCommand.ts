/** rocket_delta_v: Tsiolkovsky rocket equation, with burn time from thrust and Isp. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { refuseFluid } from './codes';
import { STANDARD_GRAVITY } from './rocketNozzle';

/**
 * @affects none; data = { deltaVMS, massRatio, exhaustVelocityMS, propellantMassKg, finalMassKg, burnTimeS?, massFlowKgS?, provenance }
 * @invariant Δv = Isp g0 ln(m0 / mf) (gravity- and drag-free); burn time = m_p Isp g0 / F
 * @failure non-positive masses, propellant >= initial mass, missing Isp -> FLD_PARAM_INVALID
 */
export const rocketDeltaV = defineCommand({
  name: 'rocket_delta_v',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only ideal velocity change of a rocket stage by the Tsiolkovsky equation Δv = Isp·g0·ln(m0/mf) (no gravity or drag losses), ' +
    'from `ispS` (s, e.g. nozzle_performance vacuum Isp) and the masses: `initialMassKg` with `propellantMassKg` (or `finalMassKg`). ' +
    'Optional `thrustN` gives the mass flow and burn time. Or give `targetDeltaVMS` instead of the propellant / final mass to get the ' +
    'propellant needed.',
  params: z.object({
    ispS: z.number().describe('Specific impulse in s (> 0).'),
    initialMassKg: z.number().describe('Initial (wet) mass m0 in kg, > 0.'),
    propellantMassKg: z.number().optional().describe('Propellant burned in kg, 0 < m_p < m0.'),
    finalMassKg: z.number().optional().describe('Final (burn-out) mass in kg, 0 < mf < m0.'),
    targetDeltaVMS: z.number().optional().describe('Wanted Δv in m/s (> 0): returns the propellant mass needed.'),
    thrustN: z.number().optional().describe('Thrust in N (> 0) for mass flow and burn time.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (message: string, path: string): CommandResult =>
      refuseFluid(doc, 'rocket_delta_v', 'FLD_PARAM_INVALID', message, [], [path]);
    const { ispS, initialMassKg: m0 } = params;
    if (!(ispS > 0 && ispS < 1e5) || !(m0 > 0)) return fail('ispS must be within (0, 1e5) and initialMassKg > 0', 'ispS');
    const given = [params.propellantMassKg, params.finalMassKg, params.targetDeltaVMS].filter((value) => value !== undefined);
    if (given.length !== 1)
      return refuseFluid(
        doc,
        'rocket_delta_v',
        'FLD_INPUT_CONFLICT',
        'give exactly one of propellantMassKg, finalMassKg or targetDeltaVMS',
        [],
        ['propellantMassKg'],
      );
    const ve = ispS * STANDARD_GRAVITY;
    let mf: number;
    if (params.targetDeltaVMS !== undefined) {
      if (!(params.targetDeltaVMS > 0)) return fail('targetDeltaVMS must be > 0', 'targetDeltaVMS');
      mf = m0 / Math.exp(params.targetDeltaVMS / ve);
    } else mf = params.finalMassKg ?? m0 - (params.propellantMassKg as number);
    if (!(mf > 0 && mf < m0))
      return fail(
        'the final mass must be within (0, initialMassKg)',
        params.finalMassKg === undefined ? 'propellantMassKg' : 'finalMassKg',
      );
    if (params.thrustN !== undefined && !(params.thrustN > 0)) return fail('thrustN must be > 0', 'thrustN');
    const propellant = m0 - mf;
    const deltaV = ve * Math.log(m0 / mf);
    const massFlow = params.thrustN === undefined ? undefined : params.thrustN / ve;
    const data = {
      deltaVMS: sig(deltaV),
      massRatio: sig(m0 / mf),
      exhaustVelocityMS: sig(ve),
      initialMassKg: m0,
      propellantMassKg: sig(propellant),
      finalMassKg: sig(mf),
      propellantFraction: sig(propellant / m0),
      ...(massFlow === undefined
        ? {}
        : {
            massFlowKgS: sig(massFlow),
            burnTimeS: sig(propellant / massFlow),
            initialThrustToWeight: sig((params.thrustN as number) / (m0 * STANDARD_GRAVITY)),
          }),
      provenance: {
        formulas: { deltaV: 'Δv = Isp g0 ln(m0/mf), g0 = 9.80665 m/s² (Tsiolkovsky 1903)', burnTime: 't_b = m_p / ṁ, ṁ = F / (Isp g0)' },
      },
    };
    return briefReport(
      doc,
      `rocket_delta_v: Isp ${ispS} s, m0 ${m0} kg, mf ${data.finalMassKg} kg (propellant ${data.propellantMassKg} kg): Δv ${data.deltaVMS} m/s, mass ratio ${data.massRatio}` +
        (massFlow === undefined ? '.' : `; ṁ ${data.massFlowKgS} kg/s, burn ${data.burnTimeS} s.`),
      data,
    );
  },
});
