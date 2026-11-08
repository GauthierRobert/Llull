/** material_chart_data (PHY-12 FR-SEL-18, AF-21): the numbers of an Ashby chart - points on two axes and the slope of the index guide lines. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { catalogEntry } from '@core/model/propertyCatalog';
import type { CadDocument } from '@core/model/types';
import { basesOf, mixedBasesWarning, unverifiedSummary } from './bases';
import { candidateList, candidateProblem, layupOf } from './candidates';
import { issue, REVIEW_SENTENCE, refuseSel } from './codes';
import { evaluateIndex, isExcluded as isExcludedIndex } from './indices';
import { BASE_UNITS, exponentValue, ruleOf } from './indexRules';
import {
  MAX_CANDIDATES,
  optionsProblem,
  resolveOptionsOf,
  strengthSchema,
  temperatureSchema,
  thicknessSchema,
  directionSchema,
  unique,
} from './inputs';
import { layupSchema, resolveCandidateProperty } from './layups';
import type { ResolveOptions } from './properties';
import { INDEX_CASES, type Excluded, type IndexCase, type PropertyUse } from './types';

const COMMAND = 'material_chart_data';

const axisSchema = z.object({
  property: z
    .string()
    .optional()
    .describe(
      'A catalogue property on this axis (density, E, Fty, k ...): E in GPa, strengths in MPa, density in Mg/m^3, others in their canonical unit.',
    ),
  index: z
    .enum(INDEX_CASES)
    .optional()
    .describe('Or a performance index on this axis (material_index lists the cases). Give exactly one of property / index.'),
  strengthProperty: strengthSchema.optional(),
});

type Axis = z.output<typeof axisSchema>;

const isExcluded = (value: AxisValue | Excluded): value is Excluded => 'code' in value;

interface AxisValue {
  readonly value: number;
  readonly unit: string;
  readonly inputs: readonly PropertyUse[];
}

/** Base unit of a chart property: E in GPa, a strength in MPa, density in Mg/m^3, else the catalogue unit. */
const unitOfProperty = (property: string): string | undefined => {
  const entry = catalogEntry(property);
  return entry === undefined
    ? undefined
    : property === 'density'
      ? BASE_UNITS.density
      : property === 'E'
        ? BASE_UNITS.E
        : entry.strength
          ? BASE_UNITS.strength
          : entry.canonicalUnit;
};

/** The axis problem as a message (not exactly one of property / index, unknown property, strength index without strengthProperty), else null. */
function axisProblem(name: string, axis: Axis): string | null {
  if ((axis.property === undefined) === (axis.index === undefined)) return `${name}: give exactly one of property or index`;
  if (axis.property !== undefined && unitOfProperty(axis.property) === undefined)
    return `${name}.property: '${axis.property}' is not a catalogue property`;
  if (axis.index !== undefined && ruleOf(axis.index)?.property === 'strength' && axis.strengthProperty === undefined)
    return `${name}: ${axis.index} needs strengthProperty`;
  return null;
}

function valueOf(
  doc: CadDocument,
  material: string,
  axis: Axis,
  options: ResolveOptions,
  layup: Parameters<typeof resolveCandidateProperty>[5],
): AxisValue | Excluded {
  if (axis.property !== undefined) {
    const found = resolveCandidateProperty(doc, material, axis.property, unitOfProperty(axis.property) ?? '1', options, layup);
    return found.ok
      ? { value: found.use.value, unit: found.use.unit, inputs: [found.use] }
      : { material, code: found.code, reason: found.reason, missing: [found.property] };
  }
  const rule = axis.index === undefined ? undefined : ruleOf(axis.index);
  if (rule === undefined) return { material, code: 'SEL_PARAMS_INVALID', reason: 'no index', missing: [] };
  const result = evaluateIndex(doc, material, rule, { ...options, strengthProperty: axis.strengthProperty, layup });
  return isExcludedIndex(result) ? result : { value: result.value, unit: result.unit, inputs: result.inputs };
}

interface Guide {
  readonly case: IndexCase;
  readonly slope: number;
  readonly exponent: { readonly num: number; readonly den: number };
  readonly constant: number | null;
  readonly through: string | null;
  readonly line: readonly (readonly [number, number])[];
}

/**
 * @affects nothing - read-only; data { points[{ material, x, y, inputs }], excluded[], axes, guides[{ case, slope, constant, through, line }], basesUsed, warnings, unverified, reviewRequired }
 * @invariant numbers only (the chart is drawn elsewhere); values in base units; a guide P^n / rho = C is the line log P = (1 / n) log rho + (log C) / n, slope exactly den / num of the rule exponent,
 *   drawn through the best candidate of its index; a candidate missing an axis value is excluded, never plotted
 * @failure axis without exactly one of property / index, unknown property, guide without x = density and y = the property of its case SEL_PARAMS_INVALID; unknown material SEL_MATERIAL_NOT_FOUND (refusals)
 */
export const materialChartData = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'The numbers behind an Ashby chart of materials of the document: one point { material, x, y } per candidate for two axes, each a catalogue property (density, E, Fty ...) or a performance index, ' +
    'in base units (E GPa, strength MPa, density Mg/m^3; log-log axes in a chart). guides lists index cases whose guide line P^n / rho = C is returned: on log P against log rho the slope is exactly 1/n ' +
    '(tie_stiffness E/rho: 1, beam_stiffness and column_buckling E^(1/2)/rho: 2, panel_stiffness E^(1/3)/rho: 3, tie_strength 1, beam_strength 3/2, panel_strength 2); guides need x = density and y = the property of the case ' +
    '(E for stiffness cases, the strength property for strength cases), pass through the best candidate of the index and come with their two end points over the x range. A candidate without an axis value is listed in excluded ' +
    '(SEL_PROPERTY_MISSING), never plotted. Returns data { points, excluded, axes: { x, y }, guides: [{ case, slope, constant, through, line }], basesUsed, warnings, unverified, reviewRequired }. Read-only.',
  params: z.object({
    materials: z
      .union([
        z.array(z.string()).max(MAX_CANDIDATES),
        z.object({ library: z.string().describe('Library id: every material imported from it is plotted.') }),
      ])
      .describe('Material ids of the document, or { library } for every record imported from one library.'),
    x: axisSchema.describe('x axis: { property } or { index }.'),
    y: axisSchema.describe('y axis: { property } or { index }.'),
    guides: z
      .array(z.enum(INDEX_CASES))
      .optional()
      .describe('Index cases whose guide lines are returned (need x = density, y = the property of the case).'),
    layups: z
      .record(z.string(), layupSchema)
      .optional()
      .describe(
        'Layup of each composite (06 lamina) candidate: { <lamina id>: { laminate } }; compared through its in-plane Ex (SEL_ANISOTROPIC).',
      ),
    direction: directionSchema.optional(),
    thickness: thicknessSchema.optional(),
    temperature: temperatureSchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const problem = axisProblem('x', params.x) ?? axisProblem('y', params.y) ?? optionsProblem(params);
    if (problem !== null) return refuseSel(doc, COMMAND, 'SEL_PARAMS_INVALID', problem, [], [problem.split(/[:.]/)[0] ?? 'params']);
    const guides = unique(params.guides ?? []);
    const yProperty = params.y.property;
    for (const guide of guides) {
      const rule = ruleOf(guide);
      const yFits = yProperty !== undefined && (rule?.property === 'E' ? yProperty === 'E' : catalogEntry(yProperty)?.strength === true);
      if (params.x.property !== 'density' || !yFits)
        return refuseSel(
          doc,
          COMMAND,
          'SEL_PARAMS_INVALID',
          `guide ${guide} needs x = density and y = ${rule?.property === 'E' ? 'E' : 'its strength property'}`,
          [],
          ['guides'],
        );
    }
    const listed = candidateList(doc, params.materials);
    if (!Array.isArray(listed)) return refuseSel(doc, COMMAND, listed.code, listed.message, listed.ids, [listed.path]);
    const materials = listed;
    const candidateIssue = candidateProblem(doc, materials, params.layups);
    if (candidateIssue !== null)
      return refuseSel(
        doc,
        COMMAND,
        candidateIssue.code,
        candidateIssue.message,
        candidateIssue.ids,
        [candidateIssue.path],
        candidateIssue.detail,
      );
    const options = resolveOptionsOf(params);
    const points: { material: string; x: number; y: number; inputs: readonly PropertyUse[] }[] = [];
    const excluded: Excluded[] = [];
    let units: { x: string; y: string } | null = null;
    for (const material of materials) {
      const layup = layupOf(params.layups, material);
      const x = valueOf(doc, material, params.x, options, layup);
      const y = valueOf(doc, material, params.y, options, layup);
      if (isExcluded(x) || isExcluded(y)) {
        excluded.push(isExcluded(x) ? x : (y as Excluded));
        continue;
      }
      units = { x: x.unit, y: y.unit };
      points.push({ material, x: x.value, y: y.value, inputs: [...x.inputs, ...y.inputs] });
    }
    const drawn: Guide[] = guides.map((guide) => {
      const rule = ruleOf(guide);
      const exponent = rule?.exponent ?? { num: 1, den: 1 };
      const n = rule === undefined ? 1 : exponentValue(rule);
      const scored = points
        .map((point) => ({ material: point.material, index: Math.pow(point.y, n) / point.x }))
        .sort((a, b) => b.index - a.index || a.material.localeCompare(b.material));
      const best = scored[0];
      const xs = points.map((point) => point.x);
      const [low, high] = [Math.min(...xs), Math.max(...xs)];
      return {
        case: guide,
        slope: exponent.den / exponent.num,
        exponent,
        constant: best?.index ?? null,
        through: best?.material ?? null,
        line: best === undefined ? [] : [low, high].map((x): readonly [number, number] => [x, Math.pow(best.index * x, 1 / n)]),
      };
    });
    const bases = basesOf(points.flatMap((point) => point.inputs));
    const weak = points.filter((point) => point.inputs.some((input) => input.unverified));
    const warnings = [
      ...unverifiedSummary(
        weak.map((point) => point.material),
        weak.flatMap((point) =>
          point.inputs.flatMap((input) => input.unverifiedReasons.map((reason) => `${point.material} ${input.property}: ${reason}`)),
        ),
      ),
      ...mixedBasesWarning(bases, materials),
      ...excluded.map((entry) => issue(entry.code, 'warning', `'${entry.material}' not plotted: ${entry.reason}`, [entry.material])),
    ];
    return report(
      doc,
      `${COMMAND}: ${points.length} point(s), ${excluded.length} excluded, ${drawn.length} guide(s)${weak.length > 0 ? '; UNVERIFIED inputs (typical / supplier / legacy values)' : ''}; ${REVIEW_SENTENCE}.`,
      {
        points,
        excluded,
        axes: { x: { ...params.x, unit: units?.x ?? null, scale: 'log' }, y: { ...params.y, unit: units?.y ?? null, scale: 'log' } },
        guides: drawn,
        basesUsed: bases,
        warnings,
        unverified: weak.length > 0,
        reviewRequired: true,
      },
    );
  },
});
