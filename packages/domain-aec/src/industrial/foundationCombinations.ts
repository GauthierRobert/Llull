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

const CRANE_CASES: ReadonlyArray<readonly [string, LoadCase]> = [
  ['C(left)', 'CL'],
  ['C(right)', 'CR'],
  ['C5(left)', 'CL5'],
  ['C5(right)', 'CR5'],
];

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
    for (const [label, loadCase] of CRANE_CASES)
      list.push({ name: `G+${label}`, factors: { G: 1, [loadCase]: 1 } });
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
  // Compression combinations carry the snow companion 0.75 S; the favourable ones do not.
  const companion = favourable ? {} : { S: 0.75 };
  const name = (variable: string, withSnow = !favourable): string =>
    `${favourable ? '1.0' : '1.35'}G+${variable}${withSnow ? '+0.75S' : ''}`;
  const list: Combination[] = [{ name: name('1.5S', false), factors: { G: g, S: 1.5 } }];
  if (wind) {
    for (const { loadCase, label } of FOUNDATION_WIND_CASES) {
      list.push({ name: name(`1.5${label}`), factors: { G: g, [loadCase]: 1.5, ...companion } });
    }
  }
  if (crane) {
    for (const [label, loadCase] of CRANE_CASES) {
      list.push({ name: name(`1.35${label}`), factors: { G: g, [loadCase]: 1.35, ...companion } });
    }
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

export function worst<T extends Candidate>(candidates: ReadonlyArray<T>): T | null {
  return candidates.reduce<T | null>(
    (best, item) => (best === null || item.utilisation > best.utilisation ? item : best),
    null,
  );
}
