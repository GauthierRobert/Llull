/** explicit_quick_check: closed-form explicit-dynamics estimates (TR-EXP-30…32, TR-EXP-20/21), identical to generate_explicit_reference.py. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { refuseExplicit } from './codes';

const CHECKS = ['wave_speed', 'critical_time_step', 'mass_scaling', 'bar_impact', 'johnson_cook_flow', 'johnson_cook_failure'] as const;
type Check = (typeof CHECKS)[number];

/** Inputs each check needs (SI names of the validation pack). */
const NEEDS: Readonly<Record<Check, readonly string[]>> = {
  wave_speed: ['E_Pa', 'nu', 'rho_kg_m3'],
  critical_time_step: ['E_Pa', 'nu', 'rho_kg_m3', 'L_e_m'],
  mass_scaling: ['E_Pa', 'nu', 'rho_kg_m3', 'L_e_m', 'dt_target_s'],
  bar_impact: ['E_Pa', 'rho_kg_m3', 'v_m_s', 'L_m'],
  johnson_cook_flow: ['A_Pa', 'B_Pa', 'n', 'C', 'm', 'eps_p', 'rate_per_s', 'ref_rate_per_s'],
  johnson_cook_failure: ['D1', 'D2', 'D3', 'D4', 'D5', 'triaxiality', 'rate_per_s', 'ref_rate_per_s'],
};

type Values = Readonly<Record<string, number>>;
type Output = { readonly values: Readonly<Record<string, number>>; readonly formula: string };

/** Homologous temperature T* = (T - Tr)/(Tm - Tr), 0 when no temperatures are given (T = Tr). */
const homologous = (inputs: Values): number => {
  const { T_K: T, Tm_K: Tm, Tr_K: Tr } = inputs;
  return T === undefined || Tm === undefined || Tr === undefined ? 0 : (T - Tr) / (Tm - Tr);
};

const dilatational = (inputs: Values): number => {
  const E = inputs['E_Pa'] ?? 0;
  const nu = inputs['nu'] ?? 0;
  return Math.sqrt((E * (1 - nu)) / ((1 + nu) * (1 - 2 * nu) * (inputs['rho_kg_m3'] ?? 1)));
};

function evaluate(check: Check, inputs: Values): Output {
  const get = (key: string): number => inputs[key] ?? 0;
  switch (check) {
    case 'wave_speed':
      return {
        values: { c0_m_s: Math.sqrt(get('E_Pa') / get('rho_kg_m3')), cd_m_s: dilatational(inputs) },
        formula: 'c0 = sqrt(E / rho); cd = sqrt(E(1-nu)/((1+nu)(1-2nu)rho))',
      };
    case 'critical_time_step':
      return { values: { dt_s: get('L_e_m') / dilatational(inputs) }, formula: 'dt = L_e / cd' };
    case 'mass_scaling': {
      const nu = get('nu');
      const M = (get('E_Pa') * (1 - nu)) / ((1 + nu) * (1 - 2 * nu));
      const scaled = (M * get('dt_target_s') ** 2) / get('L_e_m') ** 2;
      return {
        values: { rho_scaled_kg_m3: scaled, added_mass_ratio: Math.max(scaled / get('rho_kg_m3') - 1, 0) },
        formula: "rho' = M dt^2 / L_e^2, M = E(1-nu)/((1+nu)(1-2nu)); ratio = max(rho'/rho - 1, 0)",
      };
    }
    case 'bar_impact': {
      const c0 = Math.sqrt(get('E_Pa') / get('rho_kg_m3'));
      const sigma = get('rho_kg_m3') * c0 * get('v_m_s');
      return {
        values: {
          sigma_wall_Pa: sigma,
          sigma_two_bars_Pa: sigma / 2,
          contact_duration_s: (2 * get('L_m')) / c0,
          ...(inputs['sigma_y_Pa'] !== undefined ? { v_yield_m_s: get('sigma_y_Pa') / (get('rho_kg_m3') * c0) } : {}),
        },
        formula: 'sigma = rho c0 v (rigid wall), rho c0 v / 2 (identical bars); t_c = 2 L / c0; v_y = sigma_y / (rho c0)',
      };
    }
    case 'johnson_cook_flow': {
      const rateTerm = 1 + get('C') * Math.log(Math.max(get('rate_per_s') / get('ref_rate_per_s'), 1));
      const Tstar = homologous(inputs);
      const thermal = 1 - (Tstar > 0 ? Tstar ** get('m') : 0);
      return {
        values: {
          sigma_y_Pa: (get('A_Pa') + get('B_Pa') * get('eps_p') ** get('n')) * rateTerm * thermal,
          rate_term: rateTerm,
          thermal_term: thermal,
        },
        formula: 'sigma_y = (A + B eps_p^n)(1 + C ln(max(rate/rate0, 1)))(1 - T*^m), T* = (T - Tr)/(Tm - Tr)',
      };
    }
    case 'johnson_cook_failure': {
      const rateTerm = 1 + get('D4') * Math.log(Math.max(get('rate_per_s') / get('ref_rate_per_s'), 1));
      const strain = (get('D1') + get('D2') * Math.exp(get('D3') * get('triaxiality'))) * rateTerm * (1 + get('D5') * homologous(inputs));
      return {
        values: { eps_f: strain },
        formula:
          'eps_f = (D1 + D2 exp(D3 sigma*))(1 + D4 ln(max(rate/rate0, 1)))(1 + D5 T*), sigma* = mean stress / von Mises; D = sum d eps_p / eps_f',
      };
    }
  }
}

/**
 * @invariant read-only; identical to generate_explicit_reference.py (VC-EXP-10, 11, 12, 20, 21); inputs and outputs in SI with unit-suffixed keys
 * @failure a missing or non-finite input -> EXP_INPUT_MISSING (rejected no-op)
 */
export const explicitQuickCheck = defineCommand({
  name: 'explicit_quick_check',
  annotations: { readOnly: true },
  description:
    'Closed-form explicit-dynamics estimates in SI: wave_speed (E_Pa, nu, rho_kg_m3 -> c0, cd), critical_time_step (+ L_e_m -> dt = L_e/cd), ' +
    'mass_scaling (+ dt_target_s -> scaled density and added-mass ratio), bar_impact (E_Pa, rho_kg_m3, v_m_s, L_m, optional sigma_y_Pa -> wall ' +
    'stress rho c0 v, two-bar stress, contact duration 2L/c0, yield velocity), johnson_cook_flow (A_Pa, B_Pa, n, C, m, eps_p, rate_per_s, ' +
    'ref_rate_per_s, optional T_K, Tm_K, Tr_K; the rate term is clamped at the reference rate), johnson_cook_failure (D1..D5, triaxiality = mean ' +
    'stress / von Mises, rate_per_s, ref_rate_per_s, optional temperatures). Returns the values, the formula and the inputs; screening only.',
  params: z.object({
    check: z.enum(CHECKS).describe('Which estimate.'),
    inputs: z.record(z.string(), z.number()).describe('Named SI inputs (keys listed in the description).'),
  }),
  run: (doc: CadDocument, { check, inputs }): CommandResult => {
    const missing = NEEDS[check].filter((key) => inputs[key] === undefined || !Number.isFinite(inputs[key]));
    if (missing.length > 0)
      return refuseExplicit(
        doc,
        'explicit_quick_check',
        'EXP_INPUT_MISSING',
        `${check} needs ${missing.join(', ')}`,
        [],
        missing.map((key) => `inputs.${key}`),
      );
    const { values, formula } = evaluate(check, inputs);
    const text = Object.entries(values)
      .map(([key, value]) => `${key} = ${value.toPrecision(12)}`)
      .join(', ');
    return report(doc, `explicit_quick_check ${check}: ${text}.`, {
      check,
      values,
      formula,
      inputs,
      provenance: 'closed form, PHY-19 TECHNICAL_SPEC TR-EXP-20/21/30-32',
      reviewRequired: true,
    });
  },
});
