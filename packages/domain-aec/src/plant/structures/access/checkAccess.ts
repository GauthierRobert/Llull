import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { elementsOf, getBuilding } from '@aec/building/model';
import { assemblyStaleReason } from '../../../building/assemblyHandlers';
import type { AssemblyKind, BimCategory } from '@aec/building/types';
import { refuse, remediationOf } from '../codes';
import { RULESET_NAMES, RULE_TABLE_VERSION, type AccessRule } from '../rules/ruleTable';
import { checkEdges, edgeRuleUnsetFinding, type EdgeReport } from './edgeChecks';
import { unverifiedFindings, type Finding } from './finding';
import { LADDER_RULES_NOT_EVALUATED, checkLadder, ladderRules } from './ladderChecks';
import { checkPlatforms, type PlatformReport } from './platformChecks';
import { checkRailing, RAILING_RULES_NOT_EVALUATED, railingRules } from './railingChecks';
import { checkStair, checkSteelStair, CONCRETE_STAIR_HEADROOM_NOT_EVALUATED, STAIR_RULES_NOT_EVALUATED, stairRules } from './stairChecks';
import { checkStairHeadroom, stairHeadroomRules, type StairHeadroomReport } from './stairHeadroom';

type Verdict = 'pass' | 'warn' | 'fail';

const CHECKED_CATEGORIES: ReadonlyArray<BimCategory> = ['stair', 'steelStair', 'slab', 'grating', 'railing', 'ladder', 'assembly'];

const staleAssemblyFinding = (id: string, kind: AssemblyKind, reason: string): Finding => {
  const rack = kind === 'pipe_rack';
  const code = rack ? 'STA_RACK_STALE' : 'STA_PLATFORM_STALE';
  return {
    code,
    ruleId: rack ? 'RACK-CURRENT' : 'PLATFORM-CURRENT',
    ruleset: 'project',
    clause: rack
      ? 'a generated pipe rack matches the parameters it is derived from'
      : 'a generated platform matches the vessel and beams it is derived from',
    severity: 'fail',
    grade: 'A',
    ids: [id],
    measured: { value: 1, unit: rack ? 'stale pipe racks' : 'stale platforms' },
    limit: { max: 0, unit: rack ? 'stale pipe racks' : 'stale platforms' },
    remediation: remediationOf(code),
    source: reason,
  };
};

const verdictOf = (findings: readonly Finding[]): Verdict =>
  findings.some((finding) => finding.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass';

/**
 * @affects none: read-only query, answers in `data` { verdict, findings, byId, edges, checked, ruleTableVersion, reviewRequired, unverifiedRulesUsed, notEvaluated }
 * @invariant grade A breach = fail, grade B breach = warn + STA_RULE_UNVERIFIED, grade C never evaluated; reviewRequired is always true
 * @failure an id that is not a building element -> STA_UNKNOWN_ELEMENT; unknown ruleset -> CMD_INVALID_PARAMS
 */
export const checkAccess = defineCommand({
  name: 'check_access',
  description:
    'Check access means of the BUILDING model against the access rules (ISO 14122, OSHA 29 CFR 1910) and list findings with stable STA_* codes, ' +
    'measured value, limit, clause, source and a one-line fix. It covers concrete stairs (add_stair) and steel stairs (add_steel_stair): Blondel 2h+g, riser, tread, pitch angle, width, ' +
    'flight rise (the longest flight between landings), for steel stairs the headroom over the pitch line (ISO-STR-HEADROOM 2300 mm, grade B, STA_STAIR_HEADROOM: the least gap from the nosing line to the lowest modelled underside over the stair plan - steel, columns, equipment, pipes and trays with their insulation, other stairs, ladders, gratings, slabs outside their openings; data.stairHeadroom[] gives mm and the obstruction; null = nothing above, not a pass), guard-rails (add_railing: top-rail height, clear space between rails, toe plate), fixed ladders (add_ladder: rung pitch, clear width, back clearance, stile extension, fall protection by height and installation date, cage start / hoops / diameter, landing interval), the gratings and guard-rails of generated platforms (pass the platform assembly id: it stands for its parts; a platform that no longer matches its vessel or beams fails with STA_PLATFORM_STALE, a pipe rack that no longer matches its parameters with STA_RACK_STALE), and for generated platforms the walkway width (ISO-PLT-WIDTH, STA_PLATFORM_WIDTH), the headroom over the deck to the lowest modelled obstruction (ISO-PLT-HEADROOM, STA_PLATFORM_HEADROOM: other surfaces, walls, columns, steel, equipment; pipes and trays are not modelled as obstructions) and the route to grade through the access graph (STA_ACCESS_NO_EGRESS: a platform no ladder or stair reaches fails; routes start at grade = the lowest building level, reported per platform as gradeLevelId / gradeElevationMm; egressRoutesRequired asks for several edge-disjoint routes, e.g. 2 for a second means of egress) and open edges of slabs (add_slab) and grating panels (add_grating). Only grade A rules fail; grade B rules warn and add STA_RULE_UNVERIFIED; the result always has ' +
    'reviewRequired: true (a qualified person signs access means). Lengths in the answer are millimetres and angles degrees, whatever the document units. ' +
    'Open edges need edgeDropThresholdMm (no graded rule exists, so there is no default): without it the edge check is skipped with the warning STA_EDGE_RULE_UNSET. ' +
    'The drop is measured from the slab top to the next surface below (another slab, else the lowest level elevation); an edge is protected when the drop is ' +
    'within the threshold or a guard covers it: a wall of the level or a guard-rail (add_railing, role guardrail, gaps without a gate excepted) standing on the surface whose top reaches the ' +
    'strictest top-rail minimum of the requested rulesets above it (1100 mm for iso_14122, 990.6 mm for osha_1910), or the shell of a vertical vessel that high within the largest guard-rail opening (500 mm iso_14122, 482.6 mm osha_1910) of the edge. ' +
    'Read-only; see list_access_rules for the rows.',
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
        'Building element ids (stairs, steel stairs, slabs, gratings, railings, ladders) to check. Default: every one. Other element kinds are listed under `skipped`.',
      ),
    include: z
      .array(z.enum(['stairs', 'edges', 'railings', 'ladders', 'platforms']))
      .optional()
      .describe(
        'Which checks to run: "stairs" (concrete and steel stairs), "edges" (open edges of slabs and gratings) and/or "railings" (guard-rail rules) and/or "ladders" (fixed-ladder rules) and/or "platforms" (platform width, headroom and route to grade). Default all five.',
      ),
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
    egressRoutesRequired: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe(
        'Platform egress: how many edge-disjoint routes to grade every generated platform needs (a second means of egress = 2). Default 1: only a missing route is a finding. No graded rule gives the number: say where it comes from in egressSource.',
      ),
    egressSource: z
      .string()
      .optional()
      .describe('Where egressRoutesRequired comes from (project document, clause); echoed in the findings.'),
  }),
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    const unknown = (params.ids ?? []).filter((id) => building.elements[id] === undefined);
    if (unknown.length > 0)
      return refuse(doc, 'check_access', 'STA_UNKNOWN_ELEMENT', `no building element ${unknown.join(', ')}`, unknown, ['ids']);
    // A platform assembly stands for its gratings and railings (the parts the rules apply to).
    const wanted =
      params.ids === undefined
        ? undefined
        : new Set(
            params.ids.flatMap((id) => {
              const element = building.elements[id];
              return element?.category === 'assembly' ? element.partIds : [id];
            }),
          );
    const include = params.include ?? ['stairs', 'edges', 'railings', 'ladders', 'platforms'];
    const picked = <T extends { id: string }>(
      elements: readonly T[],
      kind: 'stairs' | 'edges' | 'railings' | 'ladders' | 'platforms',
    ): T[] => (include.includes(kind) ? elements.filter((element) => wanted?.has(element.id) ?? true) : []);
    const stairs = picked(elementsOf(building, 'stair'), 'stairs');
    const steelStairs = picked(elementsOf(building, 'steelStair'), 'stairs');
    const slabIds = picked(elementsOf(building, 'slab'), 'edges').map((slab) => slab.id);
    const gratingIds = picked(elementsOf(building, 'grating'), 'edges').map((grating) => grating.id);
    const surfaceIds = [...slabIds, ...gratingIds];
    const railings = picked(elementsOf(building, 'railing'), 'railings');
    const ladders = picked(elementsOf(building, 'ladder'), 'ladders');
    const skipped = (params.ids ?? []).filter((id) => !CHECKED_CATEGORIES.includes(building.elements[id]?.category ?? 'grid'));

    const rules: AccessRule[] = [
      ...(stairs.length + steelStairs.length > 0 ? stairRules(params.rulesets) : []),
      ...(steelStairs.length > 0 ? stairHeadroomRules(params.rulesets) : []),
      ...(railings.length > 0 ? railingRules(params.rulesets) : []),
      ...(ladders.length > 0 ? ladderRules(ladders, params.rulesets) : []),
    ];
    const headroom = steelStairs.map((stair) => checkStairHeadroom(doc, building, stair, params.rulesets));
    const breaches = [
      ...stairs.flatMap((stair) => checkStair(doc, stair, params.rulesets)),
      ...steelStairs.flatMap((stair) => checkSteelStair(doc, stair, params.rulesets)),
      ...headroom.flatMap((judged) => (judged.finding === null ? [] : [judged.finding])),
      ...railings.flatMap((railing) => checkRailing(doc, railing, params.rulesets)),
      ...ladders.flatMap((ladder) => checkLadder(doc, ladder, params.rulesets)),
    ];
    const findings: Finding[] = [...breaches, ...unverifiedFindings(breaches, rules)];
    // A generated platform or pipe rack that no longer matches what it is derived from is never green (update_access_platform / update_pipe_rack re-derive it).
    const platforms = elementsOf(building, 'assembly').filter(
      (assembly) => params.ids === undefined || params.ids.includes(assembly.id) || assembly.partIds.some((id) => params.ids?.includes(id)),
    );
    for (const assembly of platforms) {
      const reason = assemblyStaleReason(doc, building, assembly);
      if (reason !== null) findings.push(staleAssemblyFinding(assembly.id, assembly.kind, reason));
    }

    let platformReports: PlatformReport[] = [];
    if (include.includes('platforms')) {
      const judged = checkPlatforms(doc, building, platforms, params.rulesets, {
        routes: params.egressRoutesRequired ?? 1,
        source: params.egressSource,
      });
      findings.push(...judged.findings);
      platformReports = judged.reports;
    }

    let edges: EdgeReport[] = [];
    if (surfaceIds.length > 0) {
      if (params.edgeDropThresholdMm === undefined) findings.push(edgeRuleUnsetFinding());
      else {
        const result = checkEdges(
          doc,
          building,
          surfaceIds,
          { mm: params.edgeDropThresholdMm, source: params.edgeDropSource },
          params.rulesets,
        );
        edges = result.edges;
        findings.push(...result.findings);
      }
    }

    const byId = Object.fromEntries(
      [
        ...stairs.map((stair) => stair.id),
        ...steelStairs.map((stair) => stair.id),
        ...railings.map((railing) => railing.id),
        ...ladders.map((ladder) => ladder.id),
        ...surfaceIds,
        ...platforms.map((assembly) => assembly.id),
      ].map((id) => {
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
      checked: {
        stairs: stairs.length + steelStairs.length,
        slabs: slabIds.length,
        gratings: gratingIds.length,
        railings: railings.length,
        ladders: ladders.length,
        platforms: platformReports.length,
        edges: edges.length,
      },
      platforms: platformReports,
      stairHeadroom: headroom.flatMap((judged) => (judged.report === null ? [] : [judged.report])) satisfies StairHeadroomReport[],
      skipped,
      rulesets: params.rulesets,
      ruleTableVersion: RULE_TABLE_VERSION,
      reviewRequired: true,
      unverifiedRulesUsed: rules.filter((rule) => rule.grade === 'B').map((rule) => rule.id),
      notEvaluated: [
        ...(stairs.length > 0 ? [CONCRETE_STAIR_HEADROOM_NOT_EVALUATED] : []),
        ...(stairs.length + steelStairs.length > 0 ? STAIR_RULES_NOT_EVALUATED : []),
        ...(steelStairs.length > 0 && !params.rulesets.includes('iso_14122')
          ? [{ ruleId: 'ISO-STR-HEADROOM', reason: 'judged only under iso_14122 (not requested)' }]
          : []),
        ...(railings.length > 0 ? RAILING_RULES_NOT_EVALUATED : []),
        ...(ladders.length > 0 ? LADDER_RULES_NOT_EVALUATED : []),
        ...(platformReports.length > 0
          ? [
              ...(params.rulesets.includes('iso_14122')
                ? []
                : ['ISO-PLT-WIDTH', 'ISO-PLT-HEADROOM'].map((ruleId) => ({
                    ruleId,
                    reason: 'judged only under iso_14122 (not requested)',
                  }))),
              {
                ruleId: 'ISO-PLT-HEADROOM',
                reason:
                  'pipes, cable trays, ducts, ladders and stairs above a platform are not modelled as obstructions; the clear width is the deck width between its edges (posts and toe plates are not deducted)',
              },
            ]
          : []),
        ...(railings.some((railing) => railing.role === 'handrail')
          ? [{ ruleId: 'handrail', reason: 'no hand-rail rule rows are loaded: hand-rails are listed but not checked' }]
          : []),
      ],
    };
    return report(
      doc,
      `check_access: ${verdict} — ${stairs.length} stair(s)${steelStairs.length > 0 ? `, ${steelStairs.length} steel stair(s)` : ''}, ${railings.length} railing(s), ${ladders.length} ladder(s), ${platformReports.length} platform(s), ${surfaceIds.length} slab/grating surface(s) (${edges.length} edges): ${fails} fail, ${findings.length - fails} warn ` +
        `(rule table ${RULE_TABLE_VERSION}); review required.`,
      data,
    );
  },
});
