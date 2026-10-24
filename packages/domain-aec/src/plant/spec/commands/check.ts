/** `check_pipe_spec` (plant 01 PSC M2): coverage, overlaps, references, branch table, design conditions, dimensional standard, joints, trust, status, pipes. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../../catalog/codes';
import { BAR_PER_PSI } from '../../catalog/ptRating';
import { checkSpec } from '../checks/run';
import { pipeFindings } from '../checks/document';
import { SPEC_RULES, sortFindings, type SpecFinding } from '../checks/finding';
import { getSpecModel, latestSpec } from '../store';
import { worstStatus, type CheckStatus } from '@core/model/checkResult';
import { elementsOf, getBuilding } from '../../../building/model';

const PRESSURE_UNITS = ['bar', 'psi', 'MPa'] as const;
const TEMPERATURE_UNITS = ['C', 'F'] as const;

/** Bar gauge from a value in `unit`. */
const toBar = (value: number, unit: (typeof PRESSURE_UNITS)[number]): number =>
  unit === 'psi' ? value * BAR_PER_PSI : unit === 'MPa' ? value * 10 : value;

const count = (findings: readonly SpecFinding[], status: CheckStatus): number => findings.filter((entry) => entry.status === status).length;

/**
 * @affects none; data = { scope, status, specs: [{ specId, revision, status, issues, counts, design? }], issues, counts, rulesRun, reviewRequired }
 * @invariant read-only; fails sort before warnings; every fail has a code, ids, paths and a remediation; unverified inputs always produce PSC_DATA_UNVERIFIED (warn); status is pass only with no finding; nothing is defaulted in the design conditions
 * @failure unknown spec (or no specId in scope spec) -> PSC_SPEC_UNKNOWN; bad design conditions -> PSC_UNIT_INVALID
 */
export const checkPipeSpec = defineCommand({
  name: 'check_pipe_spec',
  description:
    'Check a piping spec (read-only) and return pass / warn / fail findings, each with a code, component ids, paths, values and a fix. Passes: coverage (a pipe, elbow, tee, reducer and, for flanged ends, flange + gasket + bolt set at every size: PSC_COVERAGE_GAP), ' +
    'equal-priority overlaps (PSC_AMBIGUOUS_COMPONENT), catalogue references (PSC_CATALOG_UNKNOWN, PSC_CATALOG_ROW_MISSING), branch table completeness (PSC_BRANCH_UNDEFINED), design conditions against the spec rating ' +
    '(PSC_PT_RATING_EXCEEDED with the rating, margin and values in bar; PSC_TEMPERATURE_LIMIT), dimensional-standard mixing at butt-weld ends (PSC_DIM_STANDARD_MIXED when EN 10220 pipe meets ASME B16.9 fittings and the end diameters differ more than 1 mm; PSC_DIM_STANDARD_ROUNDING for 0.1 to 1 mm), ' +
    'joint class / facing and weld-end compatibility (PSC_END_INCOMPATIBLE), unverified data (PSC_DATA_UNVERIFIED, never suppressible) and spec status (PSC_SPEC_NOT_APPROVED for draft). ' +
    'Give design { pressureBar | pressure { value, unit }, temperatureC | temperature { value, unit } } (gauge pressure) to check the rating. scope "document" also checks every pipe element against its spec ' +
    '(PSC_PIPE_NO_SPEC, PSC_SPEC_REVISION_STALE, PSC_PIPE_SPEC_MISMATCH). Results are for a qualified reviewer (reviewRequired true). Next: fix with edit_pipe_spec.',
  params: z.object({
    specId: z
      .string()
      .describe('Spec id to check. Required for scope "spec"; scope "document" without it checks every spec in the document.')
      .optional(),
    revision: z.number().int().positive().describe('Spec revision. Default: the newest.').optional(),
    scope: z
      .enum(['spec', 'document'])
      .describe('"spec" (default): the spec alone. "document": also every pipe element against its spec.')
      .optional(),
    design: z
      .object({
        pressureBar: z.number().min(0).describe('Design pressure in bar gauge. Give this or pressure.').optional(),
        pressure: z
          .object({
            value: z.number().min(0).describe('Pressure value, gauge.'),
            unit: z.enum(PRESSURE_UNITS).describe('bar, psi or MPa.'),
          })
          .describe('Design pressure with its unit (gauge).')
          .optional(),
        temperatureC: z.number().describe('Design temperature in degC. Give this or temperature.').optional(),
        temperature: z
          .object({ value: z.number().describe('Temperature value.'), unit: z.enum(TEMPERATURE_UNITS).describe('C or F.') })
          .describe('Design temperature with its unit.')
          .optional(),
      })
      .describe('Design conditions to check against the spec rating and temperature limits. Omit to skip the design pass.')
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { specId, revision, scope = 'spec', design }): CommandResult => {
    const model = getSpecModel(doc);
    if ((specId === undefined && scope === 'spec') || (specId !== undefined && model.specs[specId] === undefined))
      return refuse(
        doc,
        'check_pipe_spec',
        'PSC_SPEC_UNKNOWN',
        specId === undefined
          ? `give specId for scope "spec" (specs in this document: ${model.specOrder.join(', ') || 'none'})`
          : `no spec "${specId}" (specs in this document: ${model.specOrder.join(', ') || 'none'})`,
        specId === undefined ? [] : [specId],
        ['specId'],
      );
    let conditions: { pressureBar: number; temperatureC: number } | undefined;
    if (design !== undefined) {
      if (
        (design.pressureBar === undefined) === (design.pressure === undefined) ||
        (design.temperatureC === undefined) === (design.temperature === undefined)
      )
        return refuse(
          doc,
          'check_pipe_spec',
          'PSC_UNIT_INVALID',
          'design needs exactly one of pressureBar / pressure and exactly one of temperatureC / temperature (nothing is defaulted)',
          [],
          ['design'],
        );
      const pressureBar =
        design.pressureBar ??
        toBar(
          (design.pressure as NonNullable<typeof design.pressure>).value,
          (design.pressure as NonNullable<typeof design.pressure>).unit,
        );
      const temperature = design.temperature;
      const temperatureC =
        design.temperatureC ?? (temperature?.unit === 'F' ? ((temperature.value - 32) * 5) / 9 : (temperature?.value as number));
      conditions = { pressureBar, temperatureC };
    }
    const ids = specId === undefined ? model.specOrder : [specId];
    const specs = ids.flatMap((id) => {
      const spec = revision === undefined ? latestSpec(doc, id) : model.specs[id]?.find((entry) => entry.revision === revision);
      return spec === undefined ? [] : [{ spec, check: checkSpec(doc, spec, conditions) }];
    });
    if (specs.length === 0)
      return refuse(
        doc,
        'check_pipe_spec',
        'PSC_SPEC_UNKNOWN',
        `spec "${specId}" has no revision ${revision}`,
        [specId ?? ''],
        ['revision'],
      );
    const pipes = scope === 'document' ? pipeFindings(doc) : [];
    const all = sortFindings([...specs.flatMap((entry) => entry.check.findings), ...pipes]);
    const status = worstStatus(all.map((entry) => entry.status));
    const fails = count(all, 'fail');
    const warns = count(all, 'warn');
    return report(
      doc,
      `check_pipe_spec: ${specs.map((entry) => `${entry.spec.id} r${entry.spec.revision}`).join(', ')} ${status} (${fails} fail, ${warns} warn): ${
        all
          .slice(0, 3)
          .map((entry) => entry.code)
          .join(', ') || 'no findings'
      }.`,
      {
        scope,
        status,
        specs: specs.map((entry) => ({
          specId: entry.spec.id,
          revision: entry.spec.revision,
          specStatus: entry.spec.status,
          status: entry.check.status,
          sizesChecked: entry.check.sizes,
          issues: entry.check.findings,
          ...(entry.check.design === undefined ? {} : { design: entry.check.design }),
        })),
        issues: all,
        ...(scope === 'document' ? { pipeElements: elementsOf(getBuilding(doc), 'pipe').length } : {}),
        counts: { fail: fails, warn: warns, not_run: count(all, 'not_run') },
        rulesRun: SPEC_RULES.filter(
          (rule) => (scope === 'document' || rule !== 'document') && (conditions !== undefined || rule !== 'design'),
        ),
        ...(conditions === undefined ? {} : { design: specs[0]?.check.design }),
        reviewRequired: true,
      },
    );
  },
});
