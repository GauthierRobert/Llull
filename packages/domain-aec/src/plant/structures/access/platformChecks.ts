/**
 * Platform rules of `check_access` (06 STA M8): walkway clear width (ISO-PLT-WIDTH), headroom (ISO-PLT-HEADROOM) and the route to grade
 * (STA_ACCESS_NO_EGRESS, from the access graph). Applies to generated platform and circular platform assemblies.
 */

import type { CadDocument } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import { remediationOf, type StaCode } from '../codes';
import { obstacleOf } from '../ladder/ladderClearance';
import { platformSpecSchema } from '../platform/platformSpec';
import { ruleById, type RulesetName } from '../rules/ruleTable';
import { breachFinding, type Finding } from './finding';
import { buildAccessGraph } from './graph/accessGraph';
import { minimumWidth, ringsWithin } from './graph/regions';
import { disjointRoutes, routeTree } from './graph/search';
import { isRefusal, type AccessGraph, type GraphRefusal, type SurfaceNode } from './graph/types';

export interface EgressRequirement {
  /** Edge-disjoint routes to grade that every platform needs (1 = a route). */
  readonly routes: number;
  readonly source: string | undefined;
}

export interface PlatformReport {
  readonly assemblyId: string;
  readonly widthMm: number | null;
  /** Clear height over the deck to the lowest modelled obstruction; null = nothing modelled above. */
  readonly headroomMm: number | null;
  readonly routes: number | null;
  /** Grade the route is searched from: the lowest level; null when the graph could not be built. */
  readonly gradeLevelId: string | null;
  readonly gradeElevationMm: number | null;
}

const projectFinding = (
  code: StaCode,
  ruleId: string,
  clause: string,
  id: string,
  value: number,
  limit: Finding['limit'],
  unit: string,
  source: string,
): Finding => ({
  code,
  ruleId,
  ruleset: 'project',
  clause,
  severity: 'fail',
  grade: 'A',
  ids: [id],
  measured: { value, unit },
  limit,
  remediation: remediationOf(code),
  source,
});

/** Width of the walkway, mm: the least extent of a deck outline, or the radial width of a circular platform; null when the stored parameters do not parse. */
function widthMm(assembly: AssemblyElement, factor: number): number | null {
  if (assembly.kind === 'circular_platform') {
    const width = assembly.params['width'];
    return typeof width === 'number' && width > 0 ? width * factor : null;
  }
  const parsed = platformSpecSchema.safeParse(assembly.params);
  return parsed.success ? minimumWidth(parsed.data.boundary.map(([x, y]) => [x * factor, y * factor])) : null;
}

/** Lowest underside above the deck within its plan, mm above the deck top: other surfaces, walls, columns, steel members and equipment; null when none is above. */
function headroomMm(doc: CadDocument, building: BuildingModel, node: SurfaceNode, assembly: AssemblyElement): number | null {
  const factor = MM_PER_UNIT[doc.units];
  let lowest: number | null = null;
  const consider = (undersideMm: number): void => {
    if (undersideMm > node.topMm + 1 && (lowest === null || undersideMm < lowest)) lowest = undersideMm;
  };
  const own = new Set([assembly.id, ...assembly.partIds]);
  const overlaps = (ring: ReadonlyArray<readonly [number, number]>): boolean =>
    node.regions.some((region) => ringsWithin(region.outer, ring, 0));
  for (const element of Object.values(building.elements)) {
    if (own.has(element.id)) continue;
    const obstacle = obstacleOf(doc, building, element);
    if (obstacle === null) continue;
    if (obstacle.zMin * factor > node.topMm + 1 && overlaps(obstacle.ring.map(([x, y]) => [x * factor, y * factor])))
      consider(obstacle.zMin * factor);
  }
  return lowest === null ? null : lowest - node.topMm;
}

/** Surfaces above this deck (slabs, gratings, other platforms): their undersides are obstructions too. */
function surfaceHeadroomMm(graph: AccessGraph, node: SurfaceNode): number | null {
  let lowest: number | null = null;
  for (const other of graph.nodes) {
    if (other.kind === 'grade' || other.id === node.id) continue;
    const underside = other.topMm - other.thicknessMm;
    if (underside <= node.topMm + 1) continue;
    if (other.regions.some((a) => node.regions.some((b) => ringsWithin(a.outer, b.outer, 0))) && (lowest === null || underside < lowest))
      lowest = underside;
  }
  return lowest === null ? null : lowest - node.topMm;
}

const unjudged = (refusal: GraphRefusal, ids: string[]): Finding => ({
  code: refusal.code,
  ruleId: 'PROJECT-ACCESS-GRAPH',
  ruleset: 'project',
  clause: 'the access graph could be built',
  severity: 'warn',
  grade: 'B',
  ids,
  measured: { value: 0, unit: 'platforms judged for egress' },
  limit: { min: ids.length, unit: 'platforms' },
  remediation: remediationOf(refusal.code),
  source: refusal.message,
});

/**
 * Width, headroom and egress findings of `assemblies` (platform and circular platform kinds only; others are ignored).
 * @invariant a platform whose route cannot be judged (no grade, graph over the cap) is a warning, never a pass
 */
export function checkPlatforms(
  doc: CadDocument,
  building: BuildingModel,
  assemblies: readonly AssemblyElement[],
  rulesets: readonly RulesetName[],
  egress: EgressRequirement,
): { findings: Finding[]; reports: PlatformReport[] } {
  const platforms = assemblies.filter((assembly) => assembly.kind === 'platform' || assembly.kind === 'circular_platform');
  if (platforms.length === 0) return { findings: [], reports: [] };
  const factor = MM_PER_UNIT[doc.units];
  const graph = buildAccessGraph(doc);
  const refusal = isRefusal(graph) ? graph : null;
  const findings: Finding[] =
    refusal === null
      ? []
      : [
          unjudged(
            refusal,
            platforms.map((platform) => platform.id),
          ),
        ];
  const tree = isRefusal(graph) ? null : routeTree(graph);
  const reports: PlatformReport[] = [];
  const iso = rulesets.includes('iso_14122');
  for (const assembly of platforms) {
    const width = widthMm(assembly, factor);
    if (width === null)
      findings.push(
        projectFinding(
          'STA_INVALID_GEOMETRY',
          'PLATFORM-PARAMS',
          'the stored platform parameters describe a walkway',
          assembly.id,
          0,
          { min: 1, unit: 'walkways' },
          'walkways',
          'the assembly parameters do not parse',
        ),
      );
    else if (iso) {
      const found = breachFinding(ruleById('ISO-PLT-WIDTH'), 'STA_PLATFORM_WIDTH', assembly.id, width);
      if (found !== null) findings.push(found);
    }
    let headroom: number | null = null;
    let routes: number | null = null;
    if (!isRefusal(graph) && tree !== null) {
      const node = graph.nodes.find((candidate) => candidate.id === assembly.id);
      if (node === undefined)
        findings.push(
          projectFinding(
            'STA_INVALID_GEOMETRY',
            'PLATFORM-PARAMS',
            'a platform has a grating panel on an existing level',
            assembly.id,
            0,
            { min: 1, unit: 'walking surfaces' },
            'walking surfaces',
            'the assembly has no walking surface in the model',
          ),
        );
      else {
        const steel = headroomMm(doc, building, node, assembly);
        const surface = surfaceHeadroomMm(graph, node);
        headroom = steel === null ? surface : surface === null ? steel : Math.min(steel, surface);
        if (headroom !== null && iso) {
          const found = breachFinding(ruleById('ISO-PLT-HEADROOM'), 'STA_PLATFORM_HEADROOM', assembly.id, headroom);
          if (found !== null) findings.push(found);
        }
        routes = tree.via.has(assembly.id) ? disjointRoutes(graph, assembly.id, egress.routes) : 0;
        if (routes < egress.routes)
          findings.push(
            projectFinding(
              'STA_ACCESS_NO_EGRESS',
              'PROJECT-EGRESS',
              egress.source ??
                (egress.routes === 1
                  ? 'a walking surface needs a route to grade'
                  : 'egressRoutesRequired (caller supplied, no source given)'),
              assembly.id,
              routes,
              { min: egress.routes, unit: 'routes to grade' },
              'routes to grade',
              egress.source ?? 'caller',
            ),
          );
      }
    }
    reports.push({
      assemblyId: assembly.id,
      widthMm: width,
      headroomMm: headroom,
      routes,
      gradeLevelId: isRefusal(graph) ? null : graph.gradeLevelId,
      gradeElevationMm: isRefusal(graph) ? null : graph.gradeMm,
    });
  }
  return { findings, reports };
}
