import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { MM_PER_UNIT } from '@core/model/units';
import { refuse } from '../../codes';
import { buildAccessGraph } from '../graph/accessGraph';
import { routeTree } from '../graph/search';
import { GRAPH_LIMITS, isRefusal } from '../graph/types';
import { evaluateTarget, type TargetResult } from './evaluateTarget';
import { valveTargets, type ReachTarget } from './valveTargets';

const COMMAND = 'check_reachability';

/** What the check does not model (named in every answer, so a green result is not read as more than it is). */
const NOT_EVALUATED = [
  'reach is a horizontal distance in plan to the walking surface, not a 3D reach envelope',
  'guard-rails are not barriers: two touching surfaces are connected whatever railing stands between them',
  'headroom and clear width of the route legs are not judged here (check_access: STA_PLATFORM_HEADROOM, STA_PLATFORM_WIDTH)',
];

/**
 * @affects none: read-only query, answers in `data` { verdict, targets, findings, operatingHeight, graph, unreachableSurfaces, notEvaluated, reviewRequired }
 * @invariant a target is judged on the best surface within reach (inside the band and connected first); a target that cannot be judged is a finding, never a pass; deterministic and bounded (5000 targets)
 * @failure no level -> STA_NO_GRADE; graph / target caps -> STA_ACCESS_GRAPH_LIMIT; no target source, inverted band, targetsFrom in a non-mm document -> STA_TARGETS_INVALID; repeated tag -> STA_TARGET_DUPLICATE
 */
export const checkReachability = defineCommand({
  name: 'check_reachability',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Can an operator reach each operating point (valve handwheel, instrument, equipment access point) from grade? Builds the access graph of the BUILDING model: grade (the lowest level) and the walking surfaces ' +
    '(floor slabs, grating panels, generated platforms) are nodes; fixed ladders, steel and concrete stairs and surfaces that touch (within 10 mm, tops within 20 mm) are edges. For each target the surface it is operated from is the ' +
    'best one at or below the point within maxHorizontalReachMm in plan (inside the band and connected to grade first, then the highest), with height above it, plan reach and the route from grade. ' +
    'Findings (all fail, ruleset project): STA_OPERATING_HEIGHT (height above the surface outside operatingHeightMm), STA_REACH (no surface at or below the point within reach), STA_ACCESS_NO_EGRESS (the surface has no route to grade); ' +
    'a valve without an operating point is STA_TARGET_UNLOCATED (warn, never a pass). The band and the reach are project inputs with no default (their source is echoed). Points are ABSOLUTE document coordinates in DOCUMENT UNITS (z = elevation, not level-relative); ' +
    'band, reach and every length in the answer are millimetres. targetsFrom: ["valves"] adds the handwheel centre of every valve of the routed piping (millimetre documents only). Read-only; reviewRequired is always true.',
  params: z.object({
    targets: z
      .array(
        z.object({
          tag: z.string().min(1).describe('Unique tag of the operating point, e.g. "HV-101"; selects the target in the answer.'),
          kind: z.string().min(1).describe('Free label echoed in the answer: "valve_handwheel", "instrument", "equipment", ...'),
          point: z
            .tuple([z.number(), z.number(), z.number()])
            .describe('Operating point [x, y, z] in DOCUMENT UNITS, absolute (z = elevation, not level-relative).'),
        }),
      )
      .optional()
      .describe('Explicit operating points. Give these and/or targetsFrom.'),
    targetsFrom: z
      .array(z.enum(['valves']))
      .optional()
      .describe(
        'Targets read from the model: "valves" = the handwheel centre (valve centre + stem direction x catalogue stem height) of every valve of the routed piping, tagged by its tag (else its inline id).',
      ),
    operatingHeightMm: z
      .object({
        min: z.number().describe('Lowest operating height above the walking surface, millimetres.'),
        max: z.number().describe('Highest operating height above the walking surface, millimetres.'),
        source: z
          .string()
          .min(1)
          .describe('Where the band comes from (project document, clause); echoed in the answer. It has no default.'),
      })
      .describe(
        'Operating-height band of the project: the height of the operating point above the surface it is operated from must lie inside [min, max].',
      ),
    maxHorizontalReachMm: z
      .number()
      .min(0)
      .describe('Largest plan distance, millimetres, from the operating point to the edge of the surface the operator stands on.'),
    gradeIsWalkable: z
      .boolean()
      .optional()
      .describe('Whether targets may be operated from grade (unbounded, at the lowest level elevation). Default true.'),
  }),
  run: (doc, params): CommandResult => {
    const { min, max, source } = params.operatingHeightMm;
    if (min > max)
      return refuse(doc, COMMAND, 'STA_TARGETS_INVALID', `operatingHeightMm min ${min} is above max ${max}`, [], ['operatingHeightMm']);
    const explicit = params.targets ?? [];
    const from = params.targetsFrom ?? [];
    if (explicit.length === 0 && from.length === 0)
      return refuse(doc, COMMAND, 'STA_TARGETS_INVALID', 'no target: give targets and/or targetsFrom', [], ['targets', 'targetsFrom']);
    if (from.includes('valves') && doc.units !== 'mm')
      return refuse(
        doc,
        COMMAND,
        'STA_TARGETS_INVALID',
        `targetsFrom needs a millimetre document (this one is in ${doc.units})`,
        [],
        ['targetsFrom'],
      );
    if (explicit.length > GRAPH_LIMITS.targets)
      return refuse(doc, COMMAND, 'STA_ACCESS_GRAPH_LIMIT', `${explicit.length} targets (limit ${GRAPH_LIMITS.targets})`, [], ['targets']);
    const factor = MM_PER_UNIT[doc.units];
    const sourced = from.includes('valves') ? valveTargets(doc) : { targets: [], skippedRuns: [] };
    const targets: ReachTarget[] = [
      ...explicit.map(
        (target): ReachTarget => ({
          tag: target.tag,
          kind: target.kind,
          pointMm: [target.point[0] * factor, target.point[1] * factor, target.point[2] * factor],
          source: 'explicit',
        }),
      ),
      ...sourced.targets,
    ];
    if (targets.length > GRAPH_LIMITS.targets)
      return refuse(doc, COMMAND, 'STA_ACCESS_GRAPH_LIMIT', `${targets.length} targets (limit ${GRAPH_LIMITS.targets})`, [], ['targets']);
    const counts = new Map<string, number>();
    for (const target of targets) counts.set(target.tag, (counts.get(target.tag) ?? 0) + 1);
    const repeated = [...counts].filter(([, count]) => count > 1).map(([tag]) => tag);
    if (repeated.length > 0)
      return refuse(doc, COMMAND, 'STA_TARGET_DUPLICATE', `tag(s) used by more than one target: ${repeated.join(', ')}`, repeated, [
        'targets',
      ]);
    const graph = buildAccessGraph(doc);
    if (isRefusal(graph)) return refuse(doc, COMMAND, graph.code, graph.message);

    const tree = routeTree(graph);
    const settings = {
      band: { minMm: min, maxMm: max, source },
      reachMm: params.maxHorizontalReachMm,
      gradeIsWalkable: params.gradeIsWalkable ?? true,
    };
    const results: TargetResult[] = targets.map((target) => evaluateTarget(graph, tree, settings, target));
    const findings = results.flatMap((result) => result.findings);
    const failing = results.filter((result) => !result.ok);
    const unreachable = graph.nodes.filter((node) => !tree.via.has(node.id)).map((node) => node.id);
    const verdict = failing.length === 0 ? 'pass' : findings.some((finding) => finding.severity === 'fail') ? 'fail' : 'warn';
    return report(
      doc,
      `${COMMAND}: ${verdict} — ${results.length} target(s), ${results.length - failing.length} ok, ${failing.length} with findings` +
        (failing.length === 0 ? '' : ` (${[...new Set(findings.map((finding) => finding.code))].join(', ')})`) +
        `; ${graph.nodes.length - 1} surface(s), ${graph.edges.length} edge(s), ${unreachable.length} surface(s) without a route to grade; band ${min}..${max} mm (${source}), reach ${params.maxHorizontalReachMm} mm; review required.`,
      {
        verdict,
        targets: results,
        findings,
        operatingHeight: { minMm: min, maxMm: max, source },
        maxHorizontalReachMm: params.maxHorizontalReachMm,
        gradeIsWalkable: settings.gradeIsWalkable,
        gradeElevationMm: graph.gradeMm,
        graph: {
          surfaces: graph.nodes.length - 1,
          edges: graph.edges.length,
          connectors: graph.edges.filter((edge) => edge.kind !== 'adjacent').length,
          dangling: graph.dangling,
        },
        unreachableSurfaces: unreachable,
        sourceSkippedRuns: sourced.skippedRuns,
        notEvaluated: NOT_EVALUATED,
        reviewRequired: true,
      },
    );
  },
});
