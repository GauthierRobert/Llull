/** set_johnson_cook_failure: Johnson–Cook failure constants of a material for an explicit case (TR-EXP-21, RS-8b erosion). */

import type { ExplicitFailure } from '@core/model/explicit';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema } from '../shared/schemas';
import { refuseExplicit } from './codes';
import { explicitCase, withSpec } from './model';

/**
 * @affects doc.analysis.cases[analysisId].explicit.failure (sets or, without D, removes the constants of one material)
 * @invariant never defaulted: D1–D5 and their source come from the caller (spec Q7: no J–C constants in any library)
 * @failure unknown / non-explicit case -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE; no controls -> EXP_CONTROLS_MISSING; unknown material or a
 *   material no part of the case uses -> EXP_TARGET_NOT_IN_CASE; an empty source -> EXP_PARAM_INVALID (non-finite D is rejected by the schema)
 */
export const setJohnsonCookFailure = defineCommand({
  name: 'set_johnson_cook_failure',
  description:
    'Give a material of an explicit_dynamics case Johnson-Cook failure constants: eps_f = [D1 + D2 exp(D3 s)][1 + D4 ln(rate/rate0)][1 + D5 T*], s = ' +
    'mean stress / von Mises (positive in tension, the 1985 convention: D3 is usually negative), rate0 = the Johnson-Cook reference rate of the ' +
    'material. Damage D = sum(d eps_p / eps_f); an element whose damage reaches 1 is eroded (no stress, counted in failedElements). Needs the ' +
    'Johnson-Cook strength law on the material (PHY-02 set). No default: give the five values and where they come from (report, table, page). ' +
    'Omit D to remove the constants.',
  params: z.object({
    analysisId: analysisIdSchema,
    material: z.string().describe('Document material id (create_material name) used by a part of the case.'),
    D: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]).optional().describe('[D1, D2, D3, D4, D5]; omit to remove.'),
    source: z.string().optional().describe('REQUIRED with D: where the constants come from, e.g. "DOT/FAA/AR-03/57 table 5, p. 12".'),
  }),
  run: (doc, { analysisId, material, D, source }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseExplicit(doc, 'set_johnson_cook_failure', code, message, [analysisId], paths);
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return fail(found.code, found.message);
    const { analysisCase, spec } = found;
    if (spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls yet`);
    const used = Object.keys(analysisCase.parts).some((entityId) => doc.entities[entityId]?.materialId === material);
    if (!used) return fail('EXP_TARGET_NOT_IN_CASE', `no part of '${analysisId}' uses material '${material}'`, ['material']);
    const rest = Object.fromEntries(Object.entries(spec.failure ?? {}).filter(([id]) => id !== material));
    if (D === undefined) {
      const { failure, ...withoutFailure } = spec;
      void failure;
      const next = Object.keys(rest).length === 0 ? withoutFailure : { ...withoutFailure, failure: rest };
      return changed(
        withSpec(doc, analysisCase, next),
        `set_johnson_cook_failure: '${material}' has no failure constants in ${analysisId}.`,
        [analysisId],
      );
    }
    if (source === undefined || source.trim() === '') return fail('EXP_PARAM_INVALID', 'give the source of the constants', ['source']);
    const entry: ExplicitFailure = { D, source };
    return changed(
      withSpec(doc, analysisCase, { ...spec, failure: { ...rest, [material]: entry } }),
      `set_johnson_cook_failure: '${material}' D = [${D.join(', ')}] (${source}) in ${analysisId}; elements erode at damage 1.`,
      [analysisId],
    );
  },
});
