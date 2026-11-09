/** nonlinear_analytic_check: closed-form hand checks next to a nonlinear FE run (PHY-05 FR-NLS-11). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { CHECKS, isCheckFailure, runCheck } from './analyticChecks';
import { refuseNls } from './codes';

const NAME = 'nonlinear_analytic_check';

const INPUT_GUIDE =
  'inputs (a number in the unit of the key suffix, or { value, unit } converted to it): ' +
  'plastic_hinge_beam { support: "cantilever" | "simply_supported" | "propped_cantilever" | "fixed_fixed", b_mm, h_mm (rectangle), sigmaY_MPa, L_mm } ' +
  '-> plasticMoment, yieldMoment, shapeFactor, collapseLoad (tip load of a cantilever, central load of the others, small deflection); ' +
  'moment_curvature_rectangle { kappaOverKappaY (> 0), optionally b_mm + h_mm + sigmaY_MPa (all three) and E_MPa } -> momentOverYieldMoment (and moment, yieldMoment, yieldCurvature); ' +
  'thick_cylinder_pressure { a_mm (bore), b_mm (outer), sigmaY_MPa, nu (plane-strain first yield), c_mm? (plastic radius) } -> Tresca and von Mises first-yield and collapse pressures (and the pressure at the plastic radius); ' +
  'elastica_cantilever { lambda = P L^2 / EI } -> deltaVOverL, deltaHOverL (tip deflection and shortening over L), tipSlope, linearDeltaVOverL; ' +
  'imperfect_column { E_MPa, L_mm, w0_mm (mid-span imperfection), I_mm4 or b_mm + h_mm (weak axis), and exactly one of P_N or PoverPcr (< 1) } -> eulerLoad, amplification, midSpanDeflection, additionalDeflection.';

/**
 * @affects nothing (read-only, reads no analysis)
 * @invariant pure; the values equal generate_nls_reference.py (docs/physics/05-nonlinear-structural/validation) to its tolerance; every value carries its unit
 * @failure input absent -> NLS_INPUT_MISSING (names the key and unit); non-finite, wrong unit dimension, out of domain (b <= a, P >= P_cr, ...) or
 *   unknown support -> NLS_INPUT_INVALID (refusals, unchanged doc)
 */
export const nonlinearAnalyticCheck = defineCommand({
  name: NAME,
  description:
    'Closed-form hand check of a nonlinear structural result (pure, reads no analysis): plastic hinge collapse load of a rectangular beam, ' +
    'elastic-plastic moment-curvature of a rectangle, thick cylinder first-yield and collapse pressure (Tresca and von Mises), the elastica ' +
    '(large-deflection cantilever) and the amplification of an imperfect pinned column. Compare with limit_load / nonlinear_report of the FE run. ' +
    INPUT_GUIDE +
    ' Returns data { check, values { name: { value, unit } }, formula, inputs, source, warnings }. It is a hand check, not a certification.',
  annotations: { readOnly: true },
  params: z.object({
    check: z.enum(CHECKS).describe('Which closed form to evaluate.'),
    inputs: z
      .record(
        z.string(),
        z.union([
          z.number(),
          z.string(),
          z.object({
            value: z.number().describe('The number, in the unit named by unit.'),
            unit: z.string().describe('Unit symbol converted to the unit of the key suffix, e.g. "m" for a_mm.'),
          }),
        ]),
      )
      .describe('Inputs of the check, keyed with the unit suffix (see the command description).'),
  }),
  run: (doc, { check, inputs }): CommandResult => {
    const output = runCheck(check, inputs);
    if (isCheckFailure(output)) return refuseNls(doc, NAME, output.code, output.message, [], [`inputs.${output.key}`]);
    const values = Object.entries(output.values)
      .map(([key, entry]) => `${key} ${significantNumber(entry.value, 6)} ${entry.unit}`)
      .join(', ');
    return report(doc, `${NAME}: ${check}: ${values}${output.warnings.length > 0 ? ` (${output.warnings.length} warning(s))` : ''}.`, {
      check,
      values: output.values,
      formula: output.formula,
      inputs,
      source: output.source,
      warnings: output.warnings,
    });
  },
});
