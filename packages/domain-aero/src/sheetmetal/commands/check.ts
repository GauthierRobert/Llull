import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import type { FtrCheckData, FtrFinding } from '@core/model/manufacturing';
import { type CheckContext, type RuleOutcome, holeDistances, minBendRadius, minFlange, reliefPresent } from '../checks';
import { getModel, ruleOfPart } from '../graph';
import { REVIEW_NOTE, refuse, resultMeta } from '../result';
import { ruleUnverifiedInputs } from '../rules';

const SEVERITY_RANK = { fail: 0, warn: 1, info: 2 } as const;

function sorted(findings: readonly FtrFinding[]): FtrFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.code.localeCompare(b.code) ||
      a.ids.join('/').localeCompare(b.ids.join('/')),
  );
}

/**
 * @affects none; data = FtrCheckData { partId, status, findings[], rulesApplied[], rulesSkipped[] } + FtrResultMeta
 * @invariant every rule with data runs; a rule missing a threshold / table row is reported (warn finding + rulesSkipped), never silently skipped; unverified inputs always raise FTR_UNVERIFIED_DATA; a waiver never turns a fail into a pass (no gap 09 approval exists)
 * @failure unknown part -> rejected FTR_PART_NOT_FOUND (findings are never refusals)
 */
export const checkSheetMetal = defineCommand({
  name: 'check_sheet_metal',
  description:
    'Run every sheet-metal design rule the document holds data for on a part and return pass / warn / fail findings (read-only; the exit status stays 0, problems are findings). ' +
    'Rules: minimum bend radius against the imported radius table for the rule material/temper/thickness (FTR_BEND_RADIUS_BELOW_MIN with the table row as source, FTR_BEND_RADIUS_NO_TABLE_ROW, FTR_SHARP_BEND_FORBIDDEN), ' +
    'hole-to-bend and hole-to-edge distance, minimum flange length and bend relief (thresholds come from the rule; a missing one gives FTR_RULE_THRESHOLD_MISSING and is listed in rulesSkipped), ' +
    'and FTR_UNVERIFIED_DATA whenever an unverified table, row or threshold was used. Lengths are in the document length unit. ' +
    'waivers (code, ids, approvalRef) turn nothing into a pass: a waiver needs a human-signed approval record that does not exist yet, so the finding stays fail and FTR_WAIVER_NOT_APPROVED is added. ' +
    'data: { status, findings[{code, severity, ids, value, limit, unit, source, remediation}], rulesApplied[], rulesSkipped[], unverified, unverifiedInputs[], reviewRequired, provenance }. ' +
    'The result is computed by llull, not approved. End every sheet-metal job with this check.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    waivers: z
      .array(
        z.object({
          code: z.string().describe('FTR code of the finding to waive, e.g. FTR_BEND_RADIUS_BELOW_MIN.'),
          ids: z.array(z.string()).describe('Part / node ids of the finding.'),
          approvalRef: z.string().describe('Reference of the human-signed approval record that accepts the finding.'),
        }),
      )
      .optional()
      .describe(
        'Waiver requests. They are honoured only with a human-signed approval (not available yet): otherwise FTR_WAIVER_NOT_APPROVED.',
      ),
  }),
  run: (doc, { id, waivers = [] }): CommandResult => {
    const model = getModel(doc);
    const part = model.parts[id];
    if (part === undefined)
      return refuse(
        doc,
        'check_sheet_metal',
        'FTR_PART_NOT_FOUND',
        `no sheet-metal part "${id}"`,
        'List parts with describe_scene or create one with add_sheet_metal_base.',
        { paths: ['id'] },
      );
    const rule = ruleOfPart(model, part);
    if (rule === undefined)
      return refuse(
        doc,
        'check_sheet_metal',
        'FTR_RULE_NOT_FOUND',
        `rule "${part.rule}" of part ${id} is missing`,
        'Recreate the rule with create_sheet_metal_rule.',
        { ids: [id] },
      );
    const context: CheckContext = { unit: doc.units, model, part, rule };
    const outcomes: RuleOutcome[] = [
      minBendRadius(context),
      holeDistances(context, 'holeToBend'),
      holeDistances(context, 'holeToEdge'),
      minFlange(context),
      reliefPresent(context),
    ];
    const unverifiedInputs = ruleUnverifiedInputs(model, rule, doc.units);
    const findings: FtrFinding[] = outcomes.flatMap((outcome) => outcome.findings);
    if (unverifiedInputs.length > 0)
      findings.push({
        code: 'FTR_UNVERIFIED_DATA',
        severity: 'warn',
        ids: unverifiedInputs.map((input) => input.id),
        source: unverifiedInputs.map((input) => input.source).join('; '),
        remediation: 'Confirm the value against its source, or have a qualified person accept it.',
      });
    waivers.forEach((waiver, index) =>
      findings.push({
        code: 'FTR_WAIVER_NOT_APPROVED',
        severity: 'fail',
        ids: [`waivers[${index}]`, waiver.code, ...waiver.ids],
        source: waiver.approvalRef,
        remediation: 'A qualified person must record the approval (gap 09); the agent cannot.',
      }),
    );
    const ordered = sorted(findings);
    const status = ordered.some((finding) => finding.severity === 'fail')
      ? 'fail'
      : ordered.some((finding) => finding.severity === 'warn')
        ? 'warn'
        : 'pass';
    const rulesSkipped = outcomes.flatMap((outcome) =>
      outcome.skipped === undefined ? [] : [{ rule: outcome.rule, code: outcome.skipped }],
    );
    const meta = resultMeta({
      lengthUnit: doc.units,
      unverifiedInputs,
      formulas: {},
      inputs: {
        thickness: { value: rule.thickness, unit: doc.units, source: `rule ${rule.name}` },
        ...Object.fromEntries(
          Object.entries(rule.thresholds ?? {}).map(([key, threshold]) => [
            key,
            { value: threshold.value, unit: doc.units, source: threshold.source },
          ]),
        ),
      },
      sources: [`rule ${rule.name}`, ...model.radiusTable.map((row) => row.source)],
    });
    const data: FtrCheckData & { readonly partId: string } = {
      partId: id,
      status,
      findings: ordered,
      rulesApplied: outcomes.filter((outcome) => outcome.skipped === undefined).map((outcome) => outcome.rule),
      rulesSkipped,
      ...meta,
    };
    const counts = (severity: FtrFinding['severity']): number => ordered.filter((finding) => finding.severity === severity).length;
    return report(
      doc,
      `check_sheet_metal ${id}: ${status.toUpperCase()} — ${counts('fail')} fail, ${counts('warn')} warn, ${counts('info')} info` +
        `${ordered.length > 0 ? ` [${[...new Set(ordered.map((finding) => finding.code))].join(', ')}]` : ''}; ${data.rulesApplied.length} rule(s) applied, ${rulesSkipped.length} skipped. ${REVIEW_NOTE}`,
      data,
    );
  },
});
