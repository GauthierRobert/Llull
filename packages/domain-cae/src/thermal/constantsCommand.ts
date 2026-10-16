/** set_thermal_physical_constants: an explicit, sourced Stefan-Boltzmann constant for a heat_* analysis (PHY-03 FR-THM-20). */

import type { ThermalSetup } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema } from '../shared/schemas';
import { isProblem, problem, thermalCaseOf, withThermal, type Problem } from './access';
import { refuseThermal } from './codes';
import { STEFAN_BOLTZMANN } from '@lib/thermalClosedForms';

/**
 * @affects doc.analysis.cases[analysisId].thermal.stefanBoltzmann (set, or cleared to the SI default when no value is given)
 * @invariant stored as { value (W/(m^2 K^4)), source, defaulted: false }; deck, heat flows and thermal_report use it
 * @failure unknown analysis / non-thermal case -> refusal; value not finite and positive, or no source -> THM_CONSTANT_INVALID (unchanged doc)
 */
export const setThermalPhysicalConstants = defineCommand({
  name: 'set_thermal_physical_constants',
  description:
    'Override the Stefan-Boltzmann constant of a heat_* analysis (W/(m^2*K^4)) with a sourced value, e.g. to reproduce a published ' +
    'benchmark that rounds sigma (5.67e-8). Without stefanBoltzmann the override is removed and the exact SI value 5.670374419e-8 applies. ' +
    'The override is recorded with defaulted: false and its source in thermal_report.physicalConstants and enters the input hash.',
  params: z.object({
    analysisId: analysisIdSchema,
    stefanBoltzmann: z
      .object({
        value: z.number().describe('Stefan-Boltzmann constant in W/(m^2*K^4), finite and > 0.'),
        source: z.string().describe('Citation of the value (a benchmark statement, a standard, a company rule); required.'),
      })
      .optional()
      .describe('The override. Omit to restore the SI exact default.'),
  }),
  run: (doc, { analysisId, stefanBoltzmann }): CommandResult => {
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'set_thermal_physical_constants', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    const rest = Object.fromEntries(Object.entries(found.thermal).filter(([key]) => key !== 'stefanBoltzmann')) as ThermalSetup;
    if (stefanBoltzmann === undefined)
      return changed(
        withThermal(doc, found, rest),
        `set_thermal_physical_constants: '${analysisId}' uses the SI exact Stefan-Boltzmann constant ${STEFAN_BOLTZMANN}.`,
        [analysisId],
      );
    if (!Number.isFinite(stefanBoltzmann.value) || !(stefanBoltzmann.value > 0) || stefanBoltzmann.source.trim() === '')
      return fail(
        problem(
          'THM_CONSTANT_INVALID',
          'the Stefan-Boltzmann constant must be finite, positive and sourced',
          [analysisId],
          ['stefanBoltzmann'],
        ),
      );
    const named = { value: stefanBoltzmann.value, unit: 'W/(m^2 K^4)', source: stefanBoltzmann.source, defaulted: false };
    return changed(
      withThermal(doc, found, { ...rest, stefanBoltzmann: named }),
      `set_thermal_physical_constants: '${analysisId}' Stefan-Boltzmann ${named.value} W/(m^2 K^4) (${named.source}).`,
      [analysisId],
    );
  },
});
