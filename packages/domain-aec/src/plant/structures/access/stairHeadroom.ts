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
import { accessLinks } from '../clash/structuresClashBodies';
import { ruleById, type AccessRule, type RulesetName } from '../rules/ruleTable';
import { directionOf, layoutSteelStair } from '../stair/steelStairLayout';
import { stairSizes } from '../stair/steelStairMeasure';
import { breachFinding, type Finding } from './finding';
import { allCandidates, verticalSpan } from './obstructions';

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

interface SlabCandidate {
  readonly id: string;
  readonly ring: ReadonlyArray<Vec2>;
  readonly openings: ReadonlyArray<ReadonlyArray<Vec2>>;
  readonly bottom: number;
  readonly top: number;
}

function slabsOf(building: BuildingModel, exclude: ReadonlySet<string>): SlabCandidate[] {
  return elementsOf(building, 'slab').flatMap((slab) => {
    const level = building.levels[slab.levelId];
    if (level === undefined || exclude.has(slab.id)) return [];
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

/** The headroom of one steel stair, or null when its level is missing. */
export function stairHeadroom(doc: CadDocument, building: BuildingModel, stair: SteelStairElement): StairHeadroomReport | null {
  const level = building.levels[stair.levelId];
  if (level === undefined) return null;
  const exclude = new Set(accessLinks(doc, building, stair));
  const candidates = allCandidates(doc, building, exclude);
  const slabs = slabsOf(building, exclude);
  const { stations, run } = layoutSteelStair(stair, stairSizes(doc, stair));
  const { forward, left } = directionOf(stair.angle);
  const base = level.elevation + stair.start[2];
  const [step, touch] = [fromMm(doc, SAMPLE_MM), fromMm(doc, TOUCH_MM)];
  const alongCount = Math.max(1, Math.ceil(run / step));
  const acrossCount = Math.max(1, Math.ceil(stair.width / step));
  let least = Infinity;
  let obstruction: string | null = null;
  const consider = (id: string, pitch: number, low: number, high: number): void => {
    if (high <= pitch + touch) return;
    const gap = Math.max(0, low - pitch);
    if (gap < least) [least, obstruction] = [gap, id];
  };
  for (let along = 0; along <= alongCount; along++) {
    const station = Math.min(run, along * step);
    const pitch = base + pitchHeight(stair, stations, station);
    for (let across = 0; across <= acrossCount; across++) {
      const side = -stair.width / 2 + (stair.width * across) / acrossCount;
      const x = stair.start[0] + forward[0] * station + left[0] * side;
      const y = stair.start[1] + forward[1] * station + left[1] * side;
      for (const candidate of candidates) {
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
): { finding: Finding | null; report: StairHeadroomReport | null } {
  const report = stairHeadroom(doc, building, stair);
  if (report === null || report.headroomMm === null || !rulesets.includes('iso_14122')) return { finding: null, report };
  const finding = breachFinding(ruleById('ISO-STR-HEADROOM'), 'STA_STAIR_HEADROOM', stair.id, report.headroomMm);
  const where = report.obstructionId === null ? {} : { location: `under ${report.obstructionId}` };
  return { finding: finding === null ? null : { ...finding, ...where }, report };
}
