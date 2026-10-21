/** add_temperature_limit: sourced temperature limits that check_temperature_limits compares with the results. */

import type { TemperatureLimit } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget } from '../shared/target';
import { isProblem, problem, thermalCaseOf, withThermal, type Problem } from './access';
import { plainSource, sourceSchema } from './bcModel';
import { refuseThermal } from './codes';
import { inScale, quantityProblem } from './quantities';

/**
 * @affects doc.analysis.cases[analysisId].thermal.limits (adds 1 limit, id `tl-<step>.<k>`; affected: [limitId])
 * @invariant exactly one of entityId / target; at least one of min / max, both temperatures, min < max; source.citation mandatory (never defaulted)
 * @failure no source -> THM_LIMIT_SOURCE_REQUIRED; no bound, bad scope or temperature -> THM_LIMIT_INVALID / THM_UNITS_MISMATCH /
 *   FEA_PART_NOT_IN_ANALYSIS / FEA_TARGET_UNRESOLVED; unknown analysis, other case type (refusals, unchanged doc)
 */
export const addTemperatureLimit = defineCommand({
  name: 'add_temperature_limit',
  description:
    'Attach an operating temperature limit to a part (entityId) or to faces / points (target) of a heat_* analysis; returns the limit id ' +
    'in affected[0]. Give max and/or min as { value, unit } (degC | K | degF). `source` is MANDATORY: where the limit comes from ' +
    '(component datasheet, company rule, material record); llull ships no limit tables and never defaults one. check_temperature_limits ' +
    'then reports margin, PASS / MARGINAL / FAIL per bound; an exceeded limit is dispositioned only by a human (dispose_thermal_limit).',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name, e.g. "board max junction".'),
    entityId: z.string().optional().describe('Scope: id of an analysed part; the limit applies to the whole part. Exclusive with target.'),
    target: feaTargetSchema.optional().describe('Scope: faces / edges / points of a part. Exclusive with entityId.'),
    max: quantitySchema.optional().describe('Upper temperature limit { value, unit }.'),
    min: quantitySchema.optional().describe('Lower temperature limit { value, unit }.'),
    source: sourceSchema.optional().describe('REQUIRED: citation (and locator) of the limit.'),
  }),
  run: (doc, params): CommandResult => {
    const { analysisId, name, entityId, target, max, min, source } = params;
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'add_temperature_limit', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    if (source === undefined || source.citation.trim() === '')
      return fail(
        problem(
          'THM_LIMIT_SOURCE_REQUIRED',
          'a temperature limit needs a source (citation); limits are never defaulted',
          [analysisId],
          ['source'],
        ),
      );
    const invalid = (message: string, path: string): CommandResult => fail(problem('THM_LIMIT_INVALID', message, [analysisId], [path]));
    if (max === undefined && min === undefined) return invalid('give max and/or min', 'max');
    const scope: TemperatureLimit['scope'] | null =
      target !== undefined && entityId === undefined
        ? { target: toTarget(target) }
        : entityId !== undefined && target === undefined
          ? { entityId }
          : null;
    if (scope === null) return invalid('give exactly one of entityId and target', 'entityId');
    for (const [path, bound] of [
      ['max', max],
      ['min', min],
    ] as const) {
      const bad = bound === undefined ? null : quantityProblem('temperature', bound);
      if (bad !== null) return fail(problem('THM_UNITS_MISMATCH', `${path}: ${bad}`, [analysisId], [path]));
    }
    const scale = found.thermal.temperatureScale;
    if (max !== undefined && min !== undefined && !(inScale(min, scale) < inScale(max, scale)))
      return invalid('min must be below max', 'min');
    if (target !== undefined) {
      const bad = targetProblem(doc, found.analysisCase, toTarget(target));
      if (bad !== null) return fail(problem(bad.code, bad.message, [target.entityId], ['target']));
    } else if (entityId !== undefined && !Object.hasOwn(found.analysisCase.parts, entityId))
      return fail(problem('FEA_PART_NOT_IN_ANALYSIS', `entity '${entityId}' is not a part of '${analysisId}'`, [entityId], ['entityId']));
    const limit: TemperatureLimit = {
      id: nextId('tl'),
      name,
      scope,
      ...(max !== undefined ? { max } : {}),
      ...(min !== undefined ? { min } : {}),
      source: plainSource(source),
    };
    const thermal = {
      ...found.thermal,
      limits: { ...found.thermal.limits, [limit.id]: limit },
      limitOrder: [...found.thermal.limitOrder, limit.id],
    };
    const bounds = [
      max === undefined ? null : `max ${max.value} ${max.unit}`,
      min === undefined ? null : `min ${min.value} ${min.unit}`,
    ].filter(Boolean);
    return changed(
      withThermal(doc, found, thermal),
      `add_temperature_limit: '${limit.id}' (${name}) ${bounds.join(', ')} [${source.citation}] in '${analysisId}'.`,
      [limit.id],
    );
  },
});
