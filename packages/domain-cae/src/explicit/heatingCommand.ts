/** set_adiabatic_heating: adiabatic heating of a Johnson–Cook material in an explicit case (RS-8, PHY-19 TECHNICAL_SPEC §13.9). */

import type { ExplicitHeating } from '@core/model/explicit';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema } from '../shared/schemas';
import { refuseExplicit } from './codes';
import { DEFAULT_TAYLOR_QUINNEY } from './defaults';
import { explicitCase, withSpec } from './model';

/**
 * @affects doc.analysis.cases[analysisId].explicit.heating (sets or, with enabled false, removes the heating of one material)
 * @invariant β defaults to the named DEFAULT_TAYLOR_QUINNEY; the specific heat is never stored here: the job reads the material's cp model
 * @failure unknown / non-explicit case -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE; no controls -> EXP_CONTROLS_MISSING; a material no part of
 *   the case uses -> EXP_TARGET_NOT_IN_CASE; β outside [0, 1] -> EXP_PARAM_INVALID
 */
export const setAdiabaticHeating = defineCommand({
  name: 'set_adiabatic_heating',
  description:
    'Turn on adiabatic heating for a Johnson-Cook material of an explicit_dynamics case: the plastic work heats the material, ' +
    'dT = beta * sigma_y * d(eps_p) / (rho * c_p), and the flow stress softens by (1 - T*^m), T* = (T - T_transition) / (T_melt - T_transition); ' +
    'the D5 term of the Johnson-Cook failure strain uses the same T*. beta = Taylor-Quinney coefficient (default 0.9, LS-DYNA). The specific ' +
    "heat c_p comes from the material's cp property model (define_property_model property cp), read when the job is built; the run starts at " +
    'the Johnson-Cook transition temperature. enabled false removes the heating (isothermal).',
  params: z.object({
    analysisId: analysisIdSchema,
    material: z.string().describe('Document material id (create_material name) used by a part of the case.'),
    taylorQuinney: z.number().optional().describe('Fraction beta of the plastic work turned into heat, 0..1. Default 0.9 (named).'),
    enabled: z.boolean().optional().describe('false removes the heating of this material. Default true.'),
  }),
  run: (doc, { analysisId, material, taylorQuinney, enabled = true }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseExplicit(doc, 'set_adiabatic_heating', code, message, [analysisId], paths);
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return fail(found.code, found.message);
    const { analysisCase, spec } = found;
    if (spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls yet`);
    const used = Object.keys(analysisCase.parts).some((entityId) => doc.entities[entityId]?.materialId === material);
    if (!used) return fail('EXP_TARGET_NOT_IN_CASE', `no part of '${analysisId}' uses material '${material}'`, ['material']);
    const rest = Object.fromEntries(Object.entries(spec.heating ?? {}).filter(([id]) => id !== material));
    if (!enabled) {
      const { heating, ...withoutHeating } = spec;
      void heating;
      const next = Object.keys(rest).length === 0 ? withoutHeating : { ...withoutHeating, heating: rest };
      return changed(withSpec(doc, analysisCase, next), `set_adiabatic_heating: '${material}' is isothermal in ${analysisId}.`, [
        analysisId,
      ]);
    }
    if (taylorQuinney !== undefined && !(taylorQuinney >= 0 && taylorQuinney <= 1))
      return fail('EXP_PARAM_INVALID', `taylorQuinney ${taylorQuinney} is outside [0, 1]`, ['taylorQuinney']);
    const beta = taylorQuinney === undefined ? DEFAULT_TAYLOR_QUINNEY() : { value: taylorQuinney, source: 'caller', defaulted: false };
    const entry: ExplicitHeating = { taylorQuinney: beta };
    return changed(
      withSpec(doc, analysisCase, { ...spec, heating: { ...rest, [material]: entry } }),
      `set_adiabatic_heating: '${material}' heats adiabatically in ${analysisId} (beta ${beta.value}${beta.defaulted ? ', default' : ''}); ` +
        'c_p from its cp model at job build.',
      [analysisId],
    );
  },
});
