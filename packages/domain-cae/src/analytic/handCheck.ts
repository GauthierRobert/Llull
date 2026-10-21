/** hand_check: closed-form (hand-calculation) reference values for structural and explicit-dynamics results; one command, `check` picks the formula. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { refuseCode } from '../shared/codes';
import { EXPLICIT_CHECKS, explicitHandCheck, type ExplicitCheck } from '../explicit/quickCheck';
import { STRUCTURAL_CHECK_CATALOG, STRUCTURAL_CHECK_NAMES, structuralHandCheck } from './analyticCheck';

const CHECK_NAMES = [...STRUCTURAL_CHECK_NAMES, ...EXPLICIT_CHECKS] as [string, ...string[]];
const isExplicit = (check: string): check is ExplicitCheck => (EXPLICIT_CHECKS as readonly string[]).includes(check);

/**
 * @invariant read-only and pure: no document, artifact or kernel is read; results carry unit and formula (structural) or values and formula (explicit);
 *   structural checks use N-mm-t-s unit-suffixed keys, explicit checks SI keys
 * @failure unknown / missing / out-of-range input, an input the check does not use, or an unknown `compare.quantity` -> FEA_ANALYTIC_INPUT_INVALID;
 *   missing explicit input -> EXP_INPUT_MISSING; `compare` with an explicit check -> FEA_PARAM_NOT_APPLICABLE (refusals, unchanged doc)
 */
export const handCheck = defineCommand({
  name: 'hand_check',
  description:
    'Closed-form (hand-calculation) reference values to sanity-check a finite-element or explicit-dynamics result; pure, reads no document. ' +
    'STRUCTURAL checks (N-mm-t-s units: mm, N, MPa, tonne/mm^3, Hz): cantilever_frequency | cantilever | ss_beam | euler_column | ss_plate_buckling | kirsch_kt. ' +
    `${STRUCTURAL_CHECK_CATALOG} ` +
    'Returns data { check, inputs, results [{ name, value, unit, formula }], assumptions, sources, comparison }. Pass compare { quantity, value } with ' +
    'the FE number (quantity = one result name) to get the relative difference; with toleranceRel it also says withinTolerance. Typical use: compare ' +
    'analysis_report probe / frequency / buckling values with the matching closed form (an FE result more than a few percent off a beam formula usually ' +
    'means a mesh, constraint or unit problem). The formulas are idealised (see assumptions): they bound, they do not substantiate. ' +
    'EXPLICIT-DYNAMICS checks (SI, unit-suffixed keys; compare does not apply): wave_speed (E_Pa, nu, rho_kg_m3 -> c0, cd), critical_time_step (+ L_e_m -> dt = L_e/cd), ' +
    'mass_scaling (+ dt_target_s -> scaled density and added-mass ratio), bar_impact (E_Pa, rho_kg_m3, v_m_s, L_m, optional sigma_y_Pa -> wall ' +
    'stress rho c0 v, two-bar stress, contact duration 2L/c0, yield velocity), johnson_cook_flow (A_Pa, B_Pa, n, C, m, eps_p, rate_per_s, ' +
    'ref_rate_per_s, optional T_K, Tm_K, Tr_K; the rate term is clamped at the reference rate), johnson_cook_failure (D1..D5, triaxiality = mean ' +
    'stress / von Mises, rate_per_s, ref_rate_per_s, optional temperatures); returns data { check, values, formula, inputs }, screening only. ' +
    'Thermal and engine hand checks are separate tools: thermal_analytic_check, thermal_stress_check, engine_quick_check.',
  annotations: { readOnly: true },
  params: z.object({
    check: z.enum(CHECK_NAMES).describe('Which closed-form case to evaluate (structural or explicit-dynamics; see the description).'),
    inputs: z
      .record(z.string(), z.number())
      .describe(
        'Named numeric inputs of the check; the unit is in the key suffix (structural e.g. { "P_N": 9, "L_mm": 8, "E_MPa": 210000, "b_mm": 1, "h_mm": 1 }; explicit e.g. { "E_Pa": 2.1e11, "nu": 0.3, "rho_kg_m3": 7800 }).',
      ),
    compare: z
      .object({
        quantity: z.string().describe('Name of one result of the check, e.g. "tip_deflection_mm".'),
        value: z.number().describe('The finite-element value, in the unit of that result.'),
        toleranceRel: z
          .number()
          .optional()
          .describe('Acceptable relative difference (e.g. 0.02 for 2 %); sets comparison.withinTolerance.'),
      })
      .optional()
      .describe('Structural checks only: compare one FE number with the closed-form result.'),
  }),
  run: (doc, { check, inputs, compare }): CommandResult => {
    if (!isExplicit(check)) return structuralHandCheck(doc, { check, inputs, compare });
    if (compare !== undefined)
      return refuseCode(
        doc,
        'hand_check',
        'FEA_PARAM_NOT_APPLICABLE',
        `compare applies to structural checks only; '${check}' is an explicit-dynamics check`,
        [],
        ['compare'],
      );
    return explicitHandCheck(doc, { check, inputs });
  },
});
