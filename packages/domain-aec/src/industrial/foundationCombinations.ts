/**
 * @layer domain-aec
 */

import type {
  BasePlateElement,
  BuildingModel,
  FootingElement,
  SteelMemberElement,
} from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '../model';
import { type BaseReaction } from './frameModelSolve';
import { WIND_CASES, WIND_PRESSURE_CASES, type LoadCase } from './frameModelTypes';
import { type Combination, type Factors, TOLERANCE_METRES } from './foundationModel';

/** Factored base reaction: vertical v and horizontal h in kN, base moment m in kN·m (CCW +). */
export function combine(
  reaction: BaseReaction,
  factors: Factors,
): { v: number; h: number; m: number } {
  let v = 0;
  let h = 0;
  let m = 0;
  for (const [loadCase, factor] of Object.entries(factors) as [LoadCase, number][]) {
    const forces = reaction.cases[loadCase];
    if (!forces) continue;
    v += (factor * forces.vertical) / 1000;
    h += (factor * forces.horizontal) / 1000;
    m += (factor * forces.moment) / 1e6;
  }
  return { v, h, m };
}

/**
 * Moment (kN·m, magnitude) the column delivers to the footing about its base: the reaction moment
 * m on the column acts on the footing reversed, the reaction h at the footing top (height `lever`)
 * contributes h·lever, so M = |m − h·lever| (both add under wind from either side).
 */
export function footingMoment(m: number, h: number, lever: number): number {
  return Math.abs(m - h * lever);
}

/** True when any case of the reaction carries a base moment (fixed base). */
export function hasMoment(reaction: BaseReaction): boolean {
  return Object.values(reaction.cases).some((forces) => forces.moment !== 0);
}

/** ULS (N kN compression +, M kN·m) pairs of a column base over every combination, for the base plate. */
export function plateDemands(
  reaction: BaseReaction,
  wind: boolean,
): Array<{ combination: string; normal: number; moment: number }> {
  const crane = hasCase(reaction, 'CL') || hasCase(reaction, 'CR');
  return [false, true].flatMap((favourable) =>
    ultimateCombinations(wind, crane, favourable).map((combination) => {
      const { v, m } = combine(reaction, combination.factors);
      return { combination: combination.name, normal: v, moment: Math.abs(m) };
    }),
  );
}

export function hasCase(reaction: BaseReaction, loadCase: LoadCase): boolean {
  const forces = reaction.cases[loadCase];
  return forces !== undefined && (forces.vertical !== 0 || forces.horizontal !== 0);
}

/**
 * Wind cases of the foundation combinations: the four suction cases plus the windward roof-pressure
 * cases of steep / flat roofs (absent cases contribute nothing in `combine`).
 */
export const FOUNDATION_WIND_CASES = [...WIND_CASES, ...WIND_PRESSURE_CASES];

/** SLS characteristic combinations for soil bearing. */
export function serviceCombinations(wind: boolean, crane: boolean): Combination[] {
  const list: Combination[] = [{ name: 'G+S', factors: { G: 1, S: 1 } }];
  if (wind) {
    for (const { loadCase, label } of FOUNDATION_WIND_CASES) {
      list.push(
        { name: `G+S+0.6${label}`, factors: { G: 1, S: 1, [loadCase]: 0.6 } },
        { name: `G+${label}`, factors: { G: 1, [loadCase]: 1 } },
      );
    }
  }
  if (crane) {
    list.push(
      { name: 'G+C(left)', factors: { G: 1, CL: 1 } },
      { name: 'G+C(right)', factors: { G: 1, CR: 1 } },
      { name: 'G+C5(left)', factors: { G: 1, CL5: 1 } },
      { name: 'G+C5(right)', factors: { G: 1, CR5: 1 } },
    );
  }
  return list;
}

/** ULS combinations; `favourable` uses 1.0G (uplift / sliding), otherwise 1.35G (compression). */
export function ultimateCombinations(
  wind: boolean,
  crane: boolean,
  favourable: boolean,
): Combination[] {
  const g = favourable ? 1 : 1.35;
  const list: Combination[] = [];
  if (favourable) {
    list.push({ name: '1.0G+1.5S', factors: { G: g, S: 1.5 } });
    if (wind) {
      for (const { loadCase, label } of FOUNDATION_WIND_CASES) {
        list.push({ name: `1.0G+1.5${label}`, factors: { G: g, [loadCase]: 1.5 } });
      }
    }
    if (crane) {
      list.push(
        { name: '1.0G+1.35C(left)', factors: { G: g, CL: 1.35 } },
        { name: '1.0G+1.35C(right)', factors: { G: g, CR: 1.35 } },
        { name: '1.0G+1.35C5(left)', factors: { G: g, CL5: 1.35 } },
        { name: '1.0G+1.35C5(right)', factors: { G: g, CR5: 1.35 } },
      );
    }
    return list;
  }
  list.push({ name: '1.35G+1.5S', factors: { G: g, S: 1.5 } });
  if (wind) {
    for (const { loadCase, label } of FOUNDATION_WIND_CASES) {
      list.push({ name: `1.35G+1.5${label}+0.75S`, factors: { G: g, [loadCase]: 1.5, S: 0.75 } });
    }
  }
  if (crane) {
    list.push(
      { name: '1.35G+1.35C(left)+0.75S', factors: { G: g, CL: 1.35, S: 0.75 } },
      { name: '1.35G+1.35C(right)+0.75S', factors: { G: g, CR: 1.35, S: 0.75 } },
      { name: '1.35G+1.35C5(left)+0.75S', factors: { G: g, CL5: 1.35, S: 0.75 } },
      { name: '1.35G+1.35C5(right)+0.75S', factors: { G: g, CR5: 1.35, S: 0.75 } },
    );
  }
  return list;
}

function columnBaseLocation(column: SteelMemberElement): { x: number; y: number } {
  const base = column.start[2] <= column.end[2] ? column.start : column.end;
  return { x: base[0], y: base[1] };
}

export function findFooting(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  column: SteelMemberElement,
): FootingElement | null {
  const base = columnBaseLocation(column);
  const tolerance = TOLERANCE_METRES / toMetres(doc, 1);
  for (const element of Object.values(building.elements)) {
    if (
      element.category === 'footing' &&
      element.levelId === levelId &&
      Math.abs(element.location[0] - base.x) <= tolerance &&
      Math.abs(element.location[1] - base.y) <= tolerance
    ) {
      return element;
    }
  }
  return null;
}

export function findPlate(building: BuildingModel, columnId: string): BasePlateElement | null {
  for (const element of Object.values(building.elements)) {
    if (element.category === 'plate' && element.memberId === columnId) return element;
  }
  return null;
}

export interface Candidate {
  value: number;
  limit: number;
  combination: string;
  utilisation: number;
}

export function worst(candidates: Candidate[]): Candidate | null {
  return candidates.reduce<Candidate | null>(
    (best, item) => (best === null || item.utilisation > best.utilisation ? item : best),
    null,
  );
}
