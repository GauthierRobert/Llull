/** set_nonlinear_controls: NLGEOM, convergence controls and increment output of a nonlinear_static case. */

import type { ConvergencePreset, NonlinearSettings } from '@core/model/analysis';
import type { NonlinearThresholds } from '@core/model/nonlinear';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema } from '../shared/schemas';
import { refuseNls } from './codes';
import { convergenceValueProblems } from './shape';
import { hyperelasticParts, isRefusal, nonlinearCase, nonlinearOf, withNonlinear } from './settings';

const thresholdSchema = (unit: string, meaning: string): z.ZodObject<{ value: z.ZodNumber; source: z.ZodString }> =>
  z
    .object({
      value: z.number().describe(`The limit, a finite number > 0, in ${unit}.`),
      source: z
        .string()
        .min(1)
        .describe('Who or which rule states this limit (owner, company rule, standard clause): required, there is no default.'),
    })
    .describe(meaning);

const FIELD_TEXT =
  'custom only: *CONTROLS PARAMETERS=FIELD tolerances, key -> number > 0; unlisted keys keep the CalculiX default. Keys: ' +
  'Rn (largest residual force relative to the average force, default 0.005), Cn (largest correction relative to the largest incremental ' +
  'solution, 0.02), q0 and qu (force thresholds below which a residual is zero, automatic), Rp (residual tolerance of the 2nd check, 0.02), ' +
  'eps (correction tolerance of the 2nd check, 1e-5), Ceps (largest correction at a node with a low residual, 0.001), Rl (line-search ' +
  'residual tolerance, 1e-8).';
const TIME_TEXT =
  'custom only: *CONTROLS PARAMETERS=TIME INCREMENTATION values, key -> integer > 0; unlisted keys keep the CalculiX default. Keys: ' +
  'I0 (iterations before a stagnating residual may be accepted, 4), IR (iterations before the convergence rate is checked, 8), IP (iterations ' +
  'before the looser tolerance applies, 9), IC (iterations after which divergence is assumed, 16), IL (iterations beyond which the next ' +
  'increment shrinks, 10), IG (iterations below which it grows, 4), IS (iterations of the cutback test, 12), IA (maximum cutbacks of an ' +
  'increment, 5), IJ (iterations between Jacobian updates, 6), IT (maximum iterations per increment, 200).';

/** The thresholds actually given (the schema output may hold explicit undefined under exactOptionalPropertyTypes). */
function definedThresholds(input: Record<string, { value: number; source: string } | undefined>): NonlinearThresholds {
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, entry]) => (entry === undefined ? [] : [[key, { value: entry.value, source: entry.source }]])),
  );
}

/**
 * @affects doc.analysis.cases[analysisId].nonlinear (created on the first call: nlgeom, convergence, outputIncrements; affected: [analysisId])
 * @invariant nlgeom is always explicit; setting again replaces the three settings and keeps steps, probes and constitutive sets
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; case not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; custom value <= 0, threshold value <= 0 or source empty, custom without
 *   values, values on ccx_default or every < 1 -> NLS_CONTROL_INVALID (refusals, unchanged doc); nlgeom false with a hyperelastic part -> NLS_CONTROL_INVALID
 */
export const setNonlinearControls = defineCommand({
  name: 'set_nonlinear_controls',
  description:
    'Set the global controls of a nonlinear_static analysis (CalculiX): nlgeom (REQUIRED, no default: true = large displacement / ' +
    '*STEP NLGEOM, false = small displacement with material nonlinearity only), the convergence criteria and which increments are stored. ' +
    'convergence: name "ccx_default" (no *CONTROLS card, CalculiX defaults) or "custom" with field (the *CONTROLS FIELD tolerances R_n, ' +
    'C_n, ...) and/or timeIncrementation (I_0 ... I_T). outputIncrements: "all" (every increment, a curve point per increment; default), ' +
    '"last_per_step" or { every: n }. Creates the nonlinear settings of the case on first use and keeps existing steps, probes and ' +
    'constitutive sets on later calls. Optional thresholds (permanent set, small rotation / strain limits, each with a source) feed check_nonlinear. Next: set_part_constitutive_set, add_analysis_step, add_curve_probe, then the host runs fea_mesh and fea_solve.',
  annotations: { idempotent: true },
  params: z.object({
    analysisId: analysisIdSchema,
    nlgeom: z
      .boolean()
      .describe(
        'true = geometric nonlinearity (large displacements, *STEP NLGEOM); false = small displacements (refused when a part uses a hyperelastic set: CalculiX forces NLGEOM for those). Always state it.',
      ),
    convergence: z
      .object({
        name: z.enum(['ccx_default', 'custom']).describe('ccx_default = CalculiX defaults (no *CONTROLS); custom = the values below.'),
        field: z.record(z.string(), z.number()).optional().describe(FIELD_TEXT),
        timeIncrementation: z.record(z.string(), z.number()).optional().describe(TIME_TEXT),
      })
      .optional()
      .describe('Convergence criteria; default ccx_default.'),
    thresholds: z
      .object({
        permanentDisplacement: thresholdSchema(
          'DOCUMENT length units',
          'Largest acceptable residual displacement after the step that unloads every load (permanent set).',
        ).optional(),
        permanentPeeq: thresholdSchema(
          'equivalent plastic strain (dimensionless)',
          'Largest acceptable residual equivalent plastic strain after the unloading step.',
        ).optional(),
        smallRotation: thresholdSchema(
          'radians',
          'Largest rotation for which small-displacement theory (nlgeom false) is acceptable.',
        ).optional(),
        strain: thresholdSchema(
          'strain (dimensionless)',
          'Largest equivalent plastic strain for which small-displacement theory (nlgeom false) is acceptable.',
        ).optional(),
      })
      .optional()
      .describe(
        'Judgement limits for check_nonlinear, each { value, source } with NO default (ask the owner or the company rule): permanentDisplacement (document length units) and permanentPeeq judge the residual state after an unloading step (NLS_PERMANENT_SET_EXCEEDED); smallRotation (radians) and strain (equivalent plastic strain) judge nlgeom false (NLS_NLGEOM_RECOMMENDED). Replaces the stored thresholds when given, keeps them when omitted. They do not change the solution: results stay current.',
      ),
    outputIncrements: z
      .union([z.enum(['all', 'last_per_step']), z.object({ every: z.number().int().describe('Store every n-th increment (n >= 1).') })])
      .optional()
      .describe('Which increments are stored for fields and curve probes: "all" (default), "last_per_step" or { every: n }.'),
  }),
  run: (doc, { analysisId, nlgeom, convergence, outputIncrements = 'all', thresholds }): CommandResult => {
    const found = nonlinearCase(doc, 'set_nonlinear_controls', analysisId);
    if (isRefusal(found)) return found;
    const preset: ConvergencePreset =
      convergence === undefined
        ? { name: 'ccx_default' }
        : {
            name: convergence.name,
            ...(convergence.field !== undefined ? { field: convergence.field } : {}),
            ...(convergence.timeIncrementation !== undefined ? { timeIncrementation: convergence.timeIncrementation } : {}),
          };
    const problem = convergenceValueProblems(preset, 'convergence')[0];
    if (problem !== undefined)
      return refuseNls(doc, 'set_nonlinear_controls', 'NLS_CONTROL_INVALID', problem, [analysisId], ['convergence']);
    if (typeof outputIncrements === 'object' && !(outputIncrements.every >= 1))
      return refuseNls(
        doc,
        'set_nonlinear_controls',
        'NLS_CONTROL_INVALID',
        'outputIncrements.every must be an integer >= 1',
        [analysisId],
        ['outputIncrements'],
      );
    const hyper = nlgeom ? [] : hyperelasticParts(doc, found.analysis, nonlinearOf(found.analysis).constitutiveSets);
    if (hyper.length > 0)
      return refuseNls(
        doc,
        'set_nonlinear_controls',
        'NLS_CONTROL_INVALID',
        `nlgeom false is not possible: part(s) ${hyper.join(', ')} use a hyperelastic set and CalculiX switches NLGEOM on for those`,
        [analysisId, ...hyper],
        ['nlgeom'],
      );
    const bad =
      thresholds === undefined
        ? undefined
        : Object.entries(thresholds).find(([, entry]) => entry !== undefined && !(Number.isFinite(entry.value) && entry.value > 0));
    if (bad !== undefined)
      return refuseNls(
        doc,
        'set_nonlinear_controls',
        'NLS_CONTROL_INVALID',
        `thresholds.${bad[0]}.value must be a finite number > 0`,
        [analysisId],
        [`thresholds.${bad[0]}`],
      );
    const next: NonlinearSettings = {
      ...nonlinearOf(found.analysis),
      nlgeom,
      convergence: preset,
      outputIncrements,
      ...(thresholds === undefined ? {} : { thresholds: definedThresholds(thresholds) }),
    };
    const output = typeof outputIncrements === 'string' ? outputIncrements : `every ${outputIncrements.every}`;
    return changed(
      withNonlinear(doc, found.analysis, next),
      `set_nonlinear_controls: '${analysisId}' nlgeom ${nlgeom}, convergence ${preset.name}, output increments ${output}; ${next.stepOrder.length} step(s), ${next.probeOrder.length} curve probe(s).`,
      [analysisId],
    );
  },
});
