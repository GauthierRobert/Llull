import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { elementsOf, getBuilding } from '@aec/building/model';
import { refuse } from '../codes';
import { RULESET_NAMES, RULE_TABLE_VERSION, type AccessRule } from '../rules/ruleTable';
import { checkEdges, edgeRuleUnsetFinding, type EdgeReport } from './edgeChecks';
import { unverifiedFindings, type Finding } from './finding';
import { checkStair, STAIR_RULES_NOT_EVALUATED, stairRules } from './stairChecks';

type Verdict = 'pass' | 'warn' | 'fail';

const verdictOf = (findings: readonly Finding[]): Verdict =>
  findings.some((finding) => finding.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass';

/**
 * @affects none: read-only query, answers in `data` { verdict, findings, byId, edges, ruleTableVersion, reviewRequired, unverifiedRulesUsed, notEvaluated }
 * @invariant grade A breach = fail, grade B breach = warn + STA_RULE_UNVERIFIED, grade C never evaluated; reviewRequired is always true
 * @failure an id that is not a building element -> STA_UNKNOWN_ELEMENT; unknown ruleset -> CMD_INVALID_PARAMS
 */
export const checkAccess = defineCommand({
  name: 'check_access',
  description:
    'Check access means of the BUILDING model against the access rules (ISO 14122, OSHA 29 CFR 1910) and list findings with stable STA_* codes, ' +
    'measured value, limit, clause, source and a one-line fix. M1 covers existing concrete stairs (add_stair: Blondel 2h+g, riser, tread, pitch angle, width, ' +
    'flight rise) and slab open edges (add_slab). Only grade A rules fail; grade B rules warn and add STA_RULE_UNVERIFIED; the result always has ' +
    'reviewRequired: true (a qualified person signs access means). Lengths in the answer are millimetres and angles degrees, whatever the document units. ' +
    'Open edges need edgeDropThresholdMm (no graded rule exists, so there is no default): without it the edge check is skipped with the warning STA_EDGE_RULE_UNSET. ' +
    'The drop is measured from the slab top to the next surface below (another slab, else the lowest level elevation); an edge is protected when the drop is ' +
    'within the threshold or a wall of the slab level reaching at least 1100 mm above the slab top covers it. Read-only; see list_access_rules for the rows.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    rulesets: z
      .array(z.enum(RULESET_NAMES))
      .min(1)
      .describe(
        'Rulesets to evaluate: "iso_14122" (ISO 14122-2/3/4:2016) and/or "osha_1910" (OSHA 29 CFR 1910.23/25/28/29). No default: choose the site standard.',
      ),
    ids: z
      .array(z.string())
      .optional()
      .describe(
        'Building element ids (stairs, slabs) to check. Default: every stair and slab. Other element kinds are listed under `skipped`.',
      ),
    include: z
      .array(z.enum(['stairs', 'edges']))
      .optional()
      .describe('Which checks to run: "stairs" (concrete stairs) and/or "edges" (slab open edges). Default both.'),
    edgeDropThresholdMm: z
      .number()
      .positive()
      .optional()
      .describe(
        'Open-edge check only: a drop above this height (millimetres, whatever the document units) needs protection. No default: it has no graded source.',
      ),
    edgeDropSource: z
      .string()
      .optional()
      .describe('Where edgeDropThresholdMm comes from (project document, clause); echoed in the findings.'),
  }),
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    const unknown = (params.ids ?? []).filter((id) => building.elements[id] === undefined);
    if (unknown.length > 0)
      return refuse(doc, 'check_access', 'STA_UNKNOWN_ELEMENT', `no building element ${unknown.join(', ')}`, unknown, ['ids']);
    const wanted = params.ids === undefined ? undefined : new Set(params.ids);
    const include = params.include ?? ['stairs', 'edges'];
    const picked = <T extends { id: string }>(elements: readonly T[], kind: 'stairs' | 'edges'): T[] =>
      include.includes(kind) ? elements.filter((element) => wanted?.has(element.id) ?? true) : [];
    const stairs = picked(elementsOf(building, 'stair'), 'stairs');
    const slabIds = picked(elementsOf(building, 'slab'), 'edges').map((slab) => slab.id);
    const skipped = (params.ids ?? []).filter(
      (id) => building.elements[id]?.category !== 'stair' && building.elements[id]?.category !== 'slab',
    );

    const rules: AccessRule[] = stairs.length > 0 ? stairRules(params.rulesets) : [];
    const stairBreaches = stairs.flatMap((stair) => checkStair(doc, stair, params.rulesets));
    const findings: Finding[] = [...stairBreaches, ...unverifiedFindings(stairBreaches, rules)];

    let edges: EdgeReport[] = [];
    if (slabIds.length > 0) {
      if (params.edgeDropThresholdMm === undefined) findings.push(edgeRuleUnsetFinding());
      else {
        const result = checkEdges(doc, building, slabIds, { mm: params.edgeDropThresholdMm, source: params.edgeDropSource });
        edges = result.edges;
        findings.push(...result.findings);
      }
    }

    const byId = Object.fromEntries(
      [...stairs.map((stair) => stair.id), ...slabIds].map((id) => {
        const own = findings.flatMap((finding, index) => (finding.ids.includes(id) ? [index] : []));
        return [id, { verdict: verdictOf(own.map((index) => findings[index] as Finding)), findings: own }];
      }),
    );
    const verdict = verdictOf(findings);
    const fails = findings.filter((finding) => finding.severity === 'fail').length;
    const data = {
      verdict,
      findings,
      byId,
      edges,
      checked: { stairs: stairs.length, slabs: slabIds.length, edges: edges.length },
      skipped,
      rulesets: params.rulesets,
      ruleTableVersion: RULE_TABLE_VERSION,
      reviewRequired: true,
      unverifiedRulesUsed: rules.filter((rule) => rule.grade === 'B').map((rule) => rule.id),
      notEvaluated: stairs.length > 0 ? STAIR_RULES_NOT_EVALUATED : [],
    };
    return report(
      doc,
      `check_access: ${verdict} — ${stairs.length} stair(s), ${slabIds.length} slab(s) (${edges.length} edges): ${fails} fail, ${findings.length - fails} warn ` +
        `(rule table ${RULE_TABLE_VERSION}); review required.`,
      data,
    );
  },
});
