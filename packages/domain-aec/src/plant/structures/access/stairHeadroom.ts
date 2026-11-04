/**
 * Headroom over the pitch line of a steel stair (06 STA, ISO-STR-HEADROOM: ISO 14122-3 free height 2300 mm, grade B). The pitch line joins the nosings
 * (flat over a landing); the stair plan (clear width x run, from the first to the last riser) is sampled every 50 mm along and across, and at every sample
 * the vertical line above the pitch line is intersected with every obstruction: the least gap between the pitch line and an underside is the headroom.
 * Obstructions: building solids (steel, columns, walls, beams, equipment, pipes and trays, concrete stairs), spec-driven pipe runs with their insulation
 * (clash bodies), other ladders / stairs / gratings / railings, and slabs outside their openings. Not obstructions: the stair itself with its hand-rails,
 * the surfaces it leaves from and arrives on, and everything that ends at or below the pitch line there.
 * @invariant pure; null headroom = nothing modelled above the stair (never a pass by a default height); an obstruction through the stair reads 0
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { fromMm, toMm } from '@core/model/units';
import { pointInPolygon } from '@lib/polygon';
import type { BuildingModel, SteelStairElement } from '@aec/building/types';
import { elementsOf } from '../../../building/model';
import { accessLinks, hostedRailings, type Hosted } from '../clash/structuresClashBodies';
import { boxFootprint } from '../ladder/boxFootprint';
import { ruleById, type AccessRule, type RulesetName } from '../rules/ruleTable';
import { directionOf, layoutSteelStair } from '../stair/steelStairLayout';
import { stairSizes } from '../stair/steelStairMeasure';
import { breachFinding, type Finding } from './finding';
import { allCandidates, verticalSpan, type Candidate } from './obstructions';

/** Sample spacing along and across the stair, mm. */
const SAMPLE_MM = 50;
/** An underside this close to the pitch line or below counts as at the stair, not above it, mm. */
const TOUCH_MM = 1;

export interface StairHeadroomReport {
  readonly stairId: string;
  /** Least clear height over the pitch line, mm; null when nothing modelled is above the stair. */
  readonly headroomMm: number | null;
  /** The obstruction that sets it (building element id or clash-body id). */
  readonly obstructionId: string | null;
}

export interface SlabCandidate {
  readonly id: string;
  readonly ring: ReadonlyArray<Vec2>;
  readonly openings: ReadonlyArray<ReadonlyArray<Vec2>>;
  readonly bottom: number;
  readonly top: number;
}

function slabsOf(building: BuildingModel): SlabCandidate[] {
  return elementsOf(building, 'slab').flatMap((slab) => {
    const level = building.levels[slab.levelId];
    if (level === undefined) return [];
    const top = level.elevation + slab.offset;
    return [{ id: slab.id, ring: slab.boundary, openings: slab.openings ?? [], bottom: top - slab.thickness, top }];
  });
}

/** Height of the pitch line above the stair start at plan station `station`: linear between nosings, flat over a landing. */
function pitchHeight(stair: SteelStairElement, stations: ReadonlyArray<number>, station: number): number {
  const landings = new Set(stair.landings.map((landing) => landing.afterRiser));
  for (let riser = 1; riser < stair.riserCount; riser++) {
    const [from, to] = [stations[riser - 1] as number, stations[riser] as number];
    if (station > to) continue;
    if (landings.has(riser) || !(to > from)) return riser * stair.riserHeight;
    return riser * stair.riserHeight + (stair.riserHeight * (station - from)) / (to - from);
  }
  return stair.riserCount * stair.riserHeight;
}

/** What every steel stair of one check_access shares: the obstruction boxes, the slabs and the hosted railings, computed once. */
export interface HeadroomContext {
  readonly candidates: readonly Candidate[];
  readonly slabs: readonly SlabCandidate[];
  readonly hosted: Hosted;
}

export function headroomContext(doc: CadDocument, building: BuildingModel): HeadroomContext {
  return { candidates: allCandidates(doc, building), slabs: slabsOf(building), hosted: hostedRailings(building) };
}

/** Sorted distinct sample positions: the regular grid on 0..length plus every given edge, clamped, with a point just either side of each. */
function positions(length: number, step: number, edges: ReadonlyArray<number>, inset: number): number[] {
  const count = Math.max(1, Math.ceil(length / step));
  const found = new Set<number>();
  for (let index = 0; index <= count; index++) found.add(Math.min(length, (length * index) / count));
  for (const edge of edges) {
    const at = Math.min(length, Math.max(0, edge));
    found.add(at);
    found.add(Math.min(length, Math.max(0, at + inset)));
    found.add(Math.min(length, Math.max(0, at - inset)));
  }
  return [...found].sort((p, q) => p - q);
}

/** The headroom of one steel stair, or null when its level is missing. */
export function stairHeadroom(
  doc: CadDocument,
  building: BuildingModel,
  stair: SteelStairElement,
  context: HeadroomContext = headroomContext(doc, building),
): StairHeadroomReport | null {
  const level = building.levels[stair.levelId];
  if (level === undefined) return null;
  const exclude = new Set(accessLinks(doc, building, stair, context.hosted));
  const candidates = context.candidates.filter((candidate) => !exclude.has(candidate.id) && !exclude.has(candidate.group));
  const slabs = context.slabs.filter((slab) => !exclude.has(slab.id));
  const { stations, run } = layoutSteelStair(stair, stairSizes(doc, stair));
  const { forward, left } = directionOf(stair.angle);
  const base = level.elevation + stair.start[2];
  const [step, touch] = [fromMm(doc, SAMPLE_MM), fromMm(doc, TOUCH_MM)];
  const at = (station: number, side: number): Vec2 => [
    stair.start[0] + forward[0] * station + left[0] * side,
    stair.start[1] + forward[1] * station + left[1] * side,
  ];
  // Obstructions whose plan extent meets the stair plan: their edges (in stair coordinates) join the sample positions, so a narrow one is never missed.
  const corners = [at(0, -stair.width / 2), at(run, -stair.width / 2), at(run, stair.width / 2), at(0, stair.width / 2)];
  const [minX, maxX] = [Math.min(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[0]))];
  const [minY, maxY] = [Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[1]))];
  const near = candidates.filter((c) => c.max[0] >= minX && c.min[0] <= maxX && c.max[1] >= minY && c.min[1] <= maxY);
  const alongEdges: number[] = [];
  const acrossEdges: number[] = [];
  for (const candidate of near)
    for (const [x, y] of boxFootprint(candidate.box).ring) {
      const [dx, dy] = [x - stair.start[0], y - stair.start[1]];
      alongEdges.push(dx * forward[0] + dy * forward[1]);
      acrossEdges.push(dx * left[0] + dy * left[1] + stair.width / 2);
    }
  const inset = fromMm(doc, 0.01);
  const alongs = positions(run, step, alongEdges, inset);
  const acrosses = positions(stair.width, step, acrossEdges, inset);
  let least = Infinity;
  let obstruction: string | null = null;
  const consider = (id: string, pitch: number, low: number, high: number): void => {
    if (high <= pitch + touch) return;
    const gap = Math.max(0, low - pitch);
    if (gap < least) [least, obstruction] = [gap, id];
  };
  for (const station of alongs) {
    const pitch = base + pitchHeight(stair, stations, station);
    for (const across of acrosses) {
      const [x, y] = at(station, across - stair.width / 2);
      for (const candidate of near) {
        if (x < candidate.min[0] || x > candidate.max[0] || y < candidate.min[1] || y > candidate.max[1]) continue;
        const span = verticalSpan(candidate.box, x, y);
        if (span !== null) consider(candidate.id, pitch, span[0], span[1]);
      }
      for (const slab of slabs)
        if (pointInPolygon([x, y], slab.ring) && !slab.openings.some((opening) => pointInPolygon([x, y], opening)))
          consider(slab.id, pitch, slab.bottom, slab.top);
    }
  }
  return { stairId: stair.id, headroomMm: obstruction === null ? null : toMm(doc, least), obstructionId: obstruction };
}

/** The row evaluated for steel stairs under `rulesets` (none without iso_14122: the row has no OSHA counterpart). */
export const stairHeadroomRules = (rulesets: readonly RulesetName[]): AccessRule[] =>
  rulesets.includes('iso_14122') ? [ruleById('ISO-STR-HEADROOM')] : [];

/** Finding (when the row is breached) and report of one steel stair. */
export function checkStairHeadroom(
  doc: CadDocument,
  building: BuildingModel,
  stair: SteelStairElement,
  rulesets: readonly RulesetName[],
  context?: HeadroomContext,
): { finding: Finding | null; report: StairHeadroomReport | null } {
  const report = stairHeadroom(doc, building, stair, context);
  if (report === null || report.headroomMm === null || !rulesets.includes('iso_14122')) return { finding: null, report };
  const finding = breachFinding(ruleById('ISO-STR-HEADROOM'), 'STA_STAIR_HEADROOM', stair.id, report.headroomMm);
  const where = report.obstructionId === null ? {} : { location: `under ${report.obstructionId}` };
  return { finding: finding === null ? null : { ...finding, ...where }, report };
}
