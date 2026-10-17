/**
 * check_machining (07 FTR M2): design-for-machining rules on the holes and pockets of a part. Every threshold is data `{ value, source }`
 * given by the caller; a missing one is reported (`rulesSkipped` + FTR_RULE_THRESHOLD_MISSING), never assumed (AF-30, AF-31).
 */

import { type CadDocument, is3D } from '../../model/types';
import type { FtrCheckData, FtrFinding, FtrWaiver } from '../../model/manufacturing';
import { FTR_CODES } from '../../model/manufacturing';
import type { MachinedHole } from '../../geometry/featureInstances';
import { countersinkLand } from '../../lib/holeMath';
import { buildMeshBvh } from '../../geometry/meshBvh';
import { localThickness } from '../../geometry/featureThickness';
import { meshDiagonal } from '../../geometry/meshExtent';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { operandRecipe } from '../brep/kernelShape';
import { report } from '../noop';
import { machinedPart } from './machined';
import { refuse, resultMeta } from './ftr';

const RULE_NAMES = ['minLand', 'maxDepthRatio', 'toolDiameter'] as const;

const ruleSchema = z.object({
  rule: z
    .enum(RULE_NAMES)
    .describe(
      '"minLand": minimum cylindrical land under a countersink (thickness - cone depth), in document length units; ' +
        '"maxDepthRatio": maximum hole depth / diameter ratio, dimensionless; ' +
        '"toolDiameter": cutter diameter for the pocket corner check, in document length units.',
    ),
  value: z
    .number()
    .positive()
    .describe('Threshold value, in the unit of the rule (document length units, or dimensionless for maxDepthRatio).'),
  source: z.string().describe('Where the value comes from (standard, handbook, company rule): mandatory.'),
});

const waiverSchema = z.object({
  code: z.enum(FTR_CODES).describe('The finding code to waive.'),
  ids: z.array(z.string()).describe('Ids the waiver covers (feature ids of the finding).'),
  approvalRef: z.string().describe('Id of the human-signed approval record that accepts the finding.'),
});

const SEVERITY_ORDER = { fail: 0, warn: 1, info: 2 } as const;

/** The first result (sorted by severity, code, ids) is the most serious: the report is deterministic (AF-13). */
function ordered(findings: readonly FtrFinding[]): FtrFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      a.ids.join(',').localeCompare(b.ids.join(',')),
  );
}

const missingThreshold = (rule: string): FtrFinding => ({
  code: 'FTR_RULE_THRESHOLD_MISSING',
  severity: 'warn',
  ids: [rule],
  remediation: 'set the threshold in the rule (with its source) to enable this check',
});

/**
 * @affects nothing — read-only
 * @invariant data = FtrCheckData: status, findings sorted by severity / code / ids, rulesApplied, rulesSkipped; the local thickness comes from a
 *   ray cast on the part, or from `thickness`; a waiver never turns a fail into info here (no human approval record exists yet)
 * @failure missing / non-solid entity (FTR_PART_NOT_FOUND), thickness needed but neither measurable nor given (FTR_NEEDS_EXACT_KERNEL) -> rejected no-op
 */
export const checkMachining = defineCommand({
  name: 'check_machining',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Check the holes and pockets of a part against machining rules and return findings with stable codes: countersink knife edge ' +
    '(FTR_CSK_KNIFE_EDGE: cone depth >= local thickness), thin land (FTR_CSK_LAND_BELOW_MIN), hole depth / diameter ratio ' +
    '(FTR_HOLE_DEPTH_RATIO_HIGH) and pocket corner radius below the cutter radius (FTR_POCKET_CORNER_BELOW_TOOL_RADIUS). Holes and pockets ' +
    'come from add_hole / add_pocket, or are recognised from the B-rep of an imported solid. Thresholds are data you pass in rules ' +
    '([{ rule, value, source }]); a rule whose threshold is missing is skipped and reported (rulesSkipped, FTR_RULE_THRESHOLD_MISSING), never ' +
    'assumed. The local material thickness at each hole is measured by a ray cast along the hole axis, unless you give thickness ' +
    '(document length unit). Waivers are accepted only with a human-signed approval record, which does not exist yet: a waiver ' +
    'leaves the finding failing and adds FTR_WAIVER_NOT_APPROVED. Lengths in the document length unit, angles in degrees. Query: exit 0 even ' +
    'when findings fail; data = { status, findings, rulesApplied, rulesSkipped } + units + reviewRequired (computed by llull, not approved).',
  params: z.object({
    id: z.string().describe('Id of the 3D solid to check.'),
    rules: z
      .array(ruleSchema)
      .optional()
      .describe(
        'Thresholds, one entry per rule { rule, value, source }. A rule you omit is skipped and reported (a later entry replaces an earlier one).',
      ),
    thickness: z
      .number()
      .positive()
      .optional()
      .describe('Local material thickness override, in document length units; replaces the ray cast at every hole.'),
    waivers: z.array(waiverSchema).optional().describe('Requested waivers; none can be honoured without a human-signed approval record.'),
  }),
  run: (doc: CadDocument, { id, rules: ruleList = [], thickness, waivers = [] }, ctx): CommandResult => {
    const rules: Partial<Record<(typeof RULE_NAMES)[number], { value: number; source: string }>> = {};
    for (const { rule, value, source } of ruleList) rules[rule] = { value, source };
    const entity = doc.entities[id];
    if (!entity || !is3D(entity) || entity.kind === 'instance')
      return refuse(
        doc,
        'check_machining',
        'FTR_PART_NOT_FOUND',
        `no 3D solid '${id}'`,
        'list entities with describe_scene, then pass a solid id',
        [id],
        ['id'],
      );
    const kernel = (ctx ?? currentContext()).kernel;
    if (kernel === null)
      return refuse(
        doc,
        'check_machining',
        'FTR_NEEDS_EXACT_KERNEL',
        'no kernel is available',
        'rerun with --kernel occt, or pass thickness',
        [id],
      );
    const recipe = operandRecipe(kernel, entity);
    const part = machinedPart(kernel, recipe);
    const shape = thickness === undefined ? kernel.evaluate(recipe) : null;
    const mesh = shape === null ? null : kernel.tessellate(shape);
    const bvh = mesh === null ? null : buildMeshBvh(mesh);
    const reach = mesh === null ? 0 : 2 * meshDiagonal(mesh);
    const thicknessAt = (hole: MachinedHole): number | null => thickness ?? (bvh === null ? null : localThickness(bvh, hole, reach));
    const needsThickness = part.holes.some((hole) => hole.kind === 'countersink' || hole.through);
    if (needsThickness && thickness === undefined && bvh === null)
      return refuse(
        doc,
        'check_machining',
        'FTR_NEEDS_EXACT_KERNEL',
        'the local thickness cannot be measured without a buildable solid',
        'rerun with --kernel occt, or pass thickness',
        [id],
        ['thickness'],
      );
    const findings: FtrFinding[] = [];
    const applied: string[] = [];
    const skipped = new Set<string>();
    const unit = doc.units;
    for (const hole of part.holes) {
      const t = thicknessAt(hole);
      if (hole.kind === 'countersink' && hole.cskDepth !== undefined) {
        applied.push('csk_knife_edge');
        if (rules.minLand === undefined) skipped.add('minLand');
        if (t === null)
          findings.push({
            code: 'FTR_NEEDS_EXACT_KERNEL',
            severity: 'warn',
            ids: [hole.id],
            remediation: 'pass thickness: the local thickness could not be measured here',
          });
        else {
          const land = countersinkLand(t, hole.cskDepth).value;
          if (land <= 0)
            findings.push({
              code: 'FTR_CSK_KNIFE_EDGE',
              severity: 'fail',
              ids: [hole.id],
              value: land,
              unit,
              remediation: 'use thicker material, a smaller head, or a dimpled (formed) countersink',
            });
          else if (rules.minLand !== undefined) {
            applied.push('minLand');
            if (land < rules.minLand.value)
              findings.push({
                code: 'FTR_CSK_LAND_BELOW_MIN',
                severity: 'warn',
                ids: [hole.id],
                value: land,
                limit: rules.minLand.value,
                unit,
                source: rules.minLand.source,
                remediation: 'increase thickness or reduce countersink diameter',
              });
          }
        }
      }
      const depth = hole.through ? t : (hole.depth ?? null);
      if (rules.maxDepthRatio === undefined) skipped.add('maxDepthRatio');
      else if (depth !== null) {
        applied.push('maxDepthRatio');
        const ratio = depth / hole.diameter;
        if (ratio > rules.maxDepthRatio.value)
          findings.push({
            code: 'FTR_HOLE_DEPTH_RATIO_HIGH',
            severity: 'warn',
            ids: [hole.id],
            value: ratio,
            limit: rules.maxDepthRatio.value,
            source: rules.maxDepthRatio.source,
            remediation: 'reduce depth or increase diameter',
          });
      }
    }
    for (const pocket of part.pockets) {
      const tool = rules.toolDiameter?.value ?? pocket.toolDiameter;
      if (tool === undefined) {
        skipped.add('toolDiameter');
        continue;
      }
      applied.push('pocket_corner_vs_tool');
      if (pocket.cornerRadius < tool / 2)
        findings.push({
          code: 'FTR_POCKET_CORNER_BELOW_TOOL_RADIUS',
          severity: 'fail',
          ids: [pocket.id],
          value: pocket.cornerRadius,
          limit: tool / 2,
          unit,
          ...(rules.toolDiameter === undefined ? {} : { source: rules.toolDiameter.source }),
          remediation: 'increase cornerRadius to >= tool radius or use a smaller cutter',
        });
    }
    for (const rule of [...skipped].sort()) findings.push(missingThreshold(rule));
    waivers.forEach((waiver: FtrWaiver, index) =>
      findings.push({
        code: 'FTR_WAIVER_NOT_APPROVED',
        severity: 'fail',
        ids: [`waivers.${index}`, waiver.code, ...waiver.ids],
        remediation: 'a qualified person must record the approval (gap 09); the agent cannot',
      }),
    );
    const sorted = ordered(findings);
    const status = sorted.some((f) => f.severity === 'fail') ? 'fail' : sorted.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
    const data: FtrCheckData = {
      ...resultMeta(doc, {
        formulas: { land: 'land=T-c', depthRatio: 'depth/diameter', cornerVsTool: 'cornerRadius >= toolDiameter/2' },
        inputs: Object.fromEntries([
          ...(thickness === undefined ? [] : [['thickness', { value: thickness, unit, source: 'parameter' }] as const]),
          ...Object.entries(rules).flatMap(([name, rule]) =>
            rule === undefined ? [] : [[name, { value: rule.value, source: rule.source }] as const],
          ),
        ]),
        sources: ['07 FTR §5.3', '07 FTR §7.2'],
      }),
      status,
      findings: sorted,
      rulesApplied: [...new Set(applied)].sort(),
      rulesSkipped: [...skipped].sort().map((rule) => ({ rule, code: 'FTR_RULE_THRESHOLD_MISSING' as const })),
    };
    const fails = sorted.filter((f) => f.severity === 'fail').length;
    const warns = sorted.filter((f) => f.severity === 'warn').length;
    return report(
      doc,
      `check_machining: '${id}' (${part.source} features: ${part.holes.length} holes, ${part.pockets.length} pockets) status ${status}: ${fails} fail, ${warns} warn` +
        `${skipped.size === 0 ? '' : `; rules skipped, threshold missing: ${[...skipped].sort().join(', ')}`}. ` +
        'Computed by llull, not approved — a qualified person must review before manufacture.',
      data,
    );
  },
});
