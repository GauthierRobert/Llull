/** creep_closed_form: pure closed-form checks of creep, relaxation and viscoelastic time response (PHY-11 M1, FR-CRP-02..06, 10, 11, 23). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { significantNumber } from '@lib/compactNumber';
import { CHECKS, isCheckFailure, runCheck, type CheckFailure, type CreepCheck } from './closedFormChecks';
import { refuseCrp } from './codes';
import { creepLawOf, isLawProblem, type CreepLaw } from './law';
import { inputValue, isInputProblem } from './inputs';

const NAME = 'creep_closed_form';

/** Checks that take the creep law of a material (A, n, m) instead of explicit inputs. */
const NORTON_CHECKS: ReadonlySet<CreepCheck> = new Set(['norton_constant_stress', 'norton_relaxation', 'bolt_relaxation']);

const INPUT_GUIDE =
  'inputs (a number in the unit of the key suffix, or { value, unit } converted to it; A is a plain number in MPa^-n s^-(m+1), see convert_norton_a): ' +
  'norton_constant_stress { A, n, m (> -1), sigma_MPa, t_s } -> equivalentCreepStrain; ' +
  'norton_relaxation { E_MPa, A, n, sigma0_MPa, t_s and / or fraction (0..1) } (m = 0) -> stressMPa, timeToFractionS; ' +
  'bolt_relaxation { E_MPa, A, n, sigma0_MPa, kb_over_km (0 = rigid members), t_s } -> preloadRatio, boltStressMPa; ' +
  'thick_cylinder_stationary { p_MPa, a_m, b_m, n, r_m? } (plane strain, stationary creep; n = 1 is Lame) -> hoop / radial / axial / vonMises at Bore, Outer (and R); ' +
  'beam_stationary { M_Nmm, b_mm, h_mm, n, y_mm? } -> outerFibreMPa, elasticOuterFibreMPa, atQuarterHeightMPa; ' +
  'maxwell { E_MPa, tau_s, t_s }; kelvin_voigt { E_MPa, tau_s, t_s }; sls { Einf_MPa, E1_MPa, tau_s, t_s } -> E(t), J(t), retardation time; ' +
  'prony_relaxation { Einf_MPa, terms [{ E_MPa, tau_s }], t_s }; ' +
  'wlf_shift { C1, C2_K, T_minus_Tr_K (>= 0), optionally Einf_MPa, E1_MPa, tau_s, t_s for the shifted SLS modulus }; ' +
  'convert_norton_a { A, n, m, from_stress_unit, from_time_unit, to_stress_unit, to_time_unit }.';

const sig = (value: number): string => significantNumber(value, 6);

/** A, n, m of the material's creep law merged into `inputs` (and the law), or the coded refusal. */
function withLaw(
  doc: CadDocument,
  check: CreepCheck,
  material: string,
  inputs: Readonly<Record<string, unknown>>,
): { readonly inputs: Record<string, unknown>; readonly law: CreepLaw } | CommandResult {
  if (!NORTON_CHECKS.has(check))
    return refuseCrp(doc, NAME, 'CRP_INPUT_INVALID', `material applies to the norton checks only, not ${check}`, [material], ['material']);
  const given = ['A', 'n', 'm'].filter((key) => Object.hasOwn(inputs, key));
  if (given.length > 0)
    return refuseCrp(
      doc,
      NAME,
      'CRP_INPUT_INVALID',
      `${given.join(', ')} come from the creep law of '${material}': drop them from inputs`,
      [material],
      ['inputs'],
    );
  const entry = Object.hasOwn(doc.materials, material) ? (doc.materials[material] ?? null) : null;
  if (entry === null) return refuseCrp(doc, NAME, 'CRP_LAW_MISSING', `no material '${material}' in the document`, [material], ['material']);
  const law = creepLawOf(entry, material);
  if (isLawProblem(law)) return refuseCrp(doc, NAME, law.code, law.message, [material], ['material']);
  return { inputs: { ...inputs, A: law.A, n: law.n, m: law.m }, law };
}

/** Refusal when `temperature_K` lies outside the declared validity of `law`; the temperature is consumed (not a check input). */
function temperatureGuard(
  doc: CadDocument,
  law: CreepLaw,
  inputs: Record<string, unknown>,
): { readonly note: string | null } | CommandResult {
  if (!Object.hasOwn(inputs, 'temperature_K')) return { note: null };
  const temperature = inputValue(inputs, { key: 'temperature_K', unit: 'K', sign: 'positive' });
  if (isInputProblem(temperature))
    return refuseCrp(doc, NAME, temperature.code, temperature.message, [law.materialId], ['inputs.temperature_K']);
  delete inputs['temperature_K'];
  const range = law.temperatureRangeK;
  if (range === null) return { note: `model '${law.modelId}' declares no temperature validity: ${sig(temperature)} K is not checked` };
  if (temperature < range[0] || temperature > range[1])
    return refuseCrp(
      doc,
      NAME,
      'CRP_LAW_OUT_OF_RANGE',
      `${sig(temperature)} K is outside the validity ${sig(range[0])}..${sig(range[1])} K of creep model '${law.modelId}'`,
      [law.materialId],
      ['inputs.temperature_K'],
      { temperatureK: temperature, validRangeK: range },
    );
  return { note: null };
}

/**
 * @invariant read-only and pure; the values equal generate_creep_reference.py to 1e-12; every value carries its unit; a material's law gives A, n, m
 *   converted to MPa and s (TR-CRP-12); `unverified` is true when that law's basis is unverified
 * @failure unknown check input missing -> CRP_INPUT_MISSING (names the key); non-finite / wrong dimension / out of domain -> CRP_INPUT_INVALID;
 *   WLF below Tr or C2 + dT <= 0 -> CRP_WLF_OUT_OF_RANGE; material without a creep law -> CRP_LAW_MISSING / CRP_LAW_FORM_UNSUPPORTED;
 *   temperature_K outside the law validity -> CRP_LAW_OUT_OF_RANGE (refusals, unchanged doc)
 */
export const creepClosedForm = defineCommand({
  name: NAME,
  description:
    'Closed-form hand check of creep, stress relaxation and viscoelastic time response (pure, reads no analysis): Norton creep strain at constant ' +
    'stress, relaxation of a bar or a bolt at fixed strain, stationary creep stresses of a thick tube and a bent beam, Maxwell / Kelvin-Voigt / ' +
    'standard linear solid / Prony, WLF shift, and the unit conversion of the Norton coefficient A. Compare with an FE creep analysis (creep_report ' +
    'quickCheck) or use it to size a hold before solving. Norton law: eps_dot = A sigma^n t^m, sigma in MPa, t in s, strain dimensionless, time ' +
    'hardening. ' +
    INPUT_GUIDE +
    ' With material (a document material whose default constitutive set has a creep_norton law) the norton checks read A, n, m from it ' +
    '(converted to MPa and s) and an optional temperature_K input is checked against its validity (CRP_LAW_OUT_OF_RANGE, never extrapolated). ' +
    'Returns data { check, values { name: { value, unit } }, formula, inputs, provenance, unverified, unverifiedReasons, warnings }.',
  annotations: { readOnly: true },
  params: z.object({
    check: z.enum(CHECKS).describe('Which closed form to evaluate.'),
    inputs: z.record(z.string(), z.unknown()).describe('Inputs of the check, keyed with the unit suffix (see the command description).'),
    material: z
      .string()
      .optional()
      .describe('Document material name whose creep law supplies A, n, m (norton checks only); omit to give A, n, m in inputs.'),
  }),
  run: (doc, { check, inputs, material }): CommandResult => {
    let resolved: Record<string, unknown> = { ...inputs };
    let law: CreepLaw | null = null;
    let note: string | null = null;
    if (material !== undefined) {
      const found = withLaw(doc, check, material, inputs);
      if ('summary' in found) return found;
      resolved = found.inputs;
      law = found.law;
      const guard = temperatureGuard(doc, law, resolved);
      if ('summary' in guard) return guard;
      note = guard.note;
    } else if (Object.hasOwn(inputs, 'temperature_K'))
      return refuseCrp(
        doc,
        NAME,
        'CRP_INPUT_INVALID',
        'temperature_K is checked against a material law: give material, or drop it',
        [],
        ['inputs'],
      );
    const output = runCheck(check, resolved);
    if (isCheckFailure(output)) return failed(doc, output);
    const warnings = [...output.warnings, ...(note === null ? [] : [note])];
    const values = Object.entries(output.values)
      .map(([key, entry]) => `${key} ${sig(entry.value)} ${entry.unit}`)
      .join(', ');
    return report(doc, `${NAME}: ${check}: ${values}${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ''}.`, {
      check,
      values: output.values,
      formula: output.formula,
      inputs: resolved,
      provenance: {
        formula: output.formula,
        generator: 'docs/physics/11-creep-viscoelasticity/validation/generate_creep_reference.py',
        law:
          law === null
            ? null
            : {
                materialId: law.materialId,
                modelId: law.modelId,
                basis: law.basis,
                source: law.source,
                storedStressUnit: law.stressUnit,
                storedTimeUnit: law.timeUnit,
              },
      },
      unverified: law !== null && law.unverifiedReasons.length > 0,
      unverifiedReasons: law === null ? [] : law.unverifiedReasons,
      warnings,
    });
  },
});

function failed(doc: CadDocument, failure: CheckFailure): CommandResult {
  return refuseCrp(doc, NAME, failure.code, failure.message, [], failure.key === undefined ? [] : [`inputs.${failure.key}`]);
}
