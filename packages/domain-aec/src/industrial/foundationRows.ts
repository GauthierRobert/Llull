/**
 * foundationCheck: foundationRows.
 * @layer core/commands/building
 */

import type { BasePlateElement, BuildingModel, FootingElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { getBuilding, toMetres } from '../model';
import { findProfile } from '../steel/profiles';
import { polygonArea } from '@lib/polygon';
import type { BaseReaction } from './frameModel';
import { anchorBoltResistance, yieldStrength } from './steelDesign';
import { BEARING_STRENGTH, checkPlateMN } from './basePlateMN';
import {
  BACKFILL_UNIT_WEIGHT,
  CONCRETE_UNIT_WEIGHT,
  type ClayLayer,
  type Combination,
  DIFFERENTIAL_RATIO,
  FRICTION,
  type Factors,
  type FoundationRow,
  GAMMA_R_H,
  MAX_UTILISATION,
  MIN_EFFECTIVE_RATIO,
  POISSON_RATIO,
  SETTLEMENT_INFLUENCE,
  SETTLEMENT_LIMIT_MM,
} from './foundationModel';
import {
  type Candidate,
  FOUNDATION_WIND_CASES,
  combine,
  footingMoment,
  hasCase,
  hasMoment,
  plateDemands,
  serviceCombinations,
  ultimateCombinations,
  worst,
} from './foundationCombinations';
import { footingSettlementParts } from './foundationSettlement';

/** Footing check rows (bearing, uplift, overturning, sliding, settlement) of one column's pad. */
export function footingRows(
  doc: CadDocument,
  reaction: BaseReaction,
  columnMark: string,
  footing: FootingElement,
  soilBearing: number,
  wind: boolean,
  slidingHorizontal: (factors: Factors) => number,
  slabShare: number,
  soilModulus: number,
  clayLayer?: ClayLayer,
): FoundationRow[] {
  const crane = hasCase(reaction, 'CL') || hasCase(reaction, 'CR');
  const [widthX, lengthY, thickness] = [footing.width, footing.length, footing.thickness].map(
    (value) => toMetres(doc, value),
  ) as [number, number, number];
  const backfill = Math.max(0, -toMetres(doc, footing.topOffset));
  // Bending dimension = the smaller plan side (frame plane direction unknown: conservative).
  const [breadth, depthLength] = [Math.min(widthX, lengthY), Math.max(widthX, lengthY)];
  const area = breadth * depthLength;
  const selfWeight = CONCRETE_UNIT_WEIGHT * area * thickness;
  const soilWeight = BACKFILL_UNIT_WEIGHT * area * backfill;
  const weights = selfWeight + soilWeight;
  const lever = thickness + backfill;
  const row = (check: string, best: Candidate, unit: string): FoundationRow => ({
    column: columnMark,
    footing: footing.mark,
    elementId: footing.id,
    check,
    value: best.value,
    limit: best.limit,
    unit,
    utilisation: best.utilisation,
    combination: best.combination,
  });
  const rows: FoundationRow[] = [];

  const bearing: Candidate[] = [];
  for (const combination of serviceCombinations(wind, crane)) {
    const { v, h, m } = combine(reaction, combination.factors);
    const total = v + weights;
    if (total <= 0) continue;
    const eccentricity = footingMoment(m, h, lever) / total;
    const effective = Math.max(breadth - 2 * eccentricity, MIN_EFFECTIVE_RATIO * breadth);
    const pressure = total / (effective * depthLength);
    bearing.push({
      value: pressure,
      limit: soilBearing,
      combination: combination.name,
      utilisation: Math.min(pressure / soilBearing, MAX_UTILISATION),
    });
  }
  const bearingWorst = worst(bearing);
  if (bearingWorst) rows.push(row('soil bearing', bearingWorst, 'kPa'));

  if (wind) {
    const uplift: Candidate[] = [];
    const resisting = 0.9 * weights;
    const equCombinations: Combination[] = FOUNDATION_WIND_CASES.map(({ loadCase, label }) => ({
      name: `0.9G+1.5${label}`,
      factors: { G: 0.9, [loadCase]: 1.5 },
    }));
    for (const combination of equCombinations) {
      const net = Math.max(0, -combine(reaction, combination.factors).v);
      uplift.push({
        value: net,
        limit: resisting,
        combination: combination.name,
        utilisation: resisting > 0 ? Math.min(net / resisting, MAX_UTILISATION) : MAX_UTILISATION,
      });
    }
    const upliftWorst = worst(uplift);
    if (upliftWorst) rows.push(row('uplift EQU (0.9 Gstb vs 0.9G+1.5W)', upliftWorst, 'kN'));
  }

  if (hasMoment(reaction)) {
    const overturning: Candidate[] = [];
    const equ = ultimateCombinations(wind, crane, true).map((combination) => ({
      ...combination,
      factors: { ...combination.factors, G: 0.9 },
    }));
    for (const combination of equ) {
      const { v, h, m } = combine(reaction, combination.factors);
      const destabilising = footingMoment(m, h, lever);
      const stabilising = Math.max(0, (v + 0.9 * weights) * (breadth / 2));
      overturning.push({
        value: destabilising,
        limit: stabilising,
        combination: combination.name.replace('1.0G', '0.9G'),
        utilisation:
          stabilising > 0
            ? Math.min(destabilising / stabilising, MAX_UTILISATION)
            : destabilising > 0
              ? MAX_UTILISATION
              : 0,
      });
    }
    const overturningWorst = worst(overturning);
    if (overturningWorst) {
      rows.push(
        row(
          'overturning EQU (stabilising 0.9G·B/2 vs destabilising moment)',
          overturningWorst,
          'kNm',
        ),
      );
    }
  }

  const sliding: Candidate[] = [];
  for (const combination of ultimateCombinations(wind, crane, true)) {
    const { v } = combine(reaction, combination.factors);
    const h = slidingHorizontal(combination.factors);
    const resistance = (FRICTION * Math.max(0, v + weights + slabShare)) / GAMMA_R_H;
    const demand = Math.abs(h);
    sliding.push({
      value: demand,
      limit: resistance,
      combination: combination.name,
      utilisation:
        resistance > 0
          ? Math.min(demand / resistance, MAX_UTILISATION)
          : demand > 0
            ? MAX_UTILISATION
            : 0,
    });
  }
  const slidingWorst = worst(sliding);
  if (slidingWorst)
    rows.push(row(`sliding (mu ${FRICTION}, gammaR,h ${GAMMA_R_H})`, slidingWorst, 'kN'));

  const parts = footingSettlementParts(doc, reaction, footing, soilModulus, clayLayer);
  const breakdown = clayLayer
    ? `elastic ${round(parts.elastic, 1)} mm + consolidation ${round(parts.consolidation, 1)} mm, `
    : '';
  rows.push(
    row(
      `settlement (${breakdown}elastic Es ${soilModulus} MPa, rigid square Is ${SETTLEMENT_INFLUENCE}, nu ${POISSON_RATIO}, net q = q − 18 kN/m³ × founding depth)`,
      {
        value: parts.total,
        limit: SETTLEMENT_LIMIT_MM,
        combination: 'G+S',
        utilisation: Math.min(parts.total / SETTLEMENT_LIMIT_MM, MAX_UTILISATION),
      },
      'mm',
    ),
  );
  return rows;
}

export function plateRows(
  doc: CadDocument,
  building: BuildingModel,
  reaction: BaseReaction,
  columnMark: string,
  footingMark: string,
  plate: BasePlateElement,
  wind: boolean,
): FoundationRow[] {
  const crane = hasCase(reaction, 'CL') || hasCase(reaction, 'CR');
  const toMm = (value: number): number => toMetres(doc, value) * 1000;
  const areaMm2 = toMm(plate.length) * toMm(plate.width);
  const bolts = Math.max(1, plate.boltCount);
  const resistance = anchorBoltResistance(toMm(plate.boltDiameter));
  const [tensionLimit, shearLimit] = [resistance.tension / 1000, resistance.shear / 1000];
  const row = (check: string, best: Candidate, unit: string): FoundationRow => ({
    column: columnMark,
    footing: footingMark,
    elementId: plate.id,
    check,
    value: best.value,
    limit: best.limit,
    unit,
    utilisation: best.utilisation,
    combination: best.combination,
  });
  const rows: FoundationRow[] = [];

  const bearing: Candidate[] = ultimateCombinations(wind, crane, false).map((combination) => {
    const compression = Math.max(0, combine(reaction, combination.factors).v);
    const stress = areaMm2 > 0 ? (compression * 1000) / areaMm2 : 0;
    return {
      value: stress,
      limit: BEARING_STRENGTH,
      combination: combination.name,
      utilisation: Math.min(stress / BEARING_STRENGTH, MAX_UTILISATION),
    };
  });
  const bearingWorst = worst(bearing);
  if (bearingWorst) rows.push(row('plate concrete bearing fjd (C25/30)', bearingWorst, 'N/mm²'));

  const favourable = ultimateCombinations(wind, crane, true);
  const tension: Candidate[] = [];
  const interaction: Candidate[] = [];
  for (const combination of favourable) {
    const { v, h } = combine(reaction, combination.factors);
    const perBoltTension = Math.max(0, -v) / bolts;
    const perBoltShear = Math.abs(h) / bolts;
    tension.push({
      value: perBoltTension,
      limit: tensionLimit,
      combination: combination.name,
      utilisation: Math.min(perBoltTension / tensionLimit, MAX_UTILISATION),
    });
    const combined = perBoltShear / shearLimit + perBoltTension / (1.4 * tensionLimit);
    interaction.push({
      value: combined,
      limit: 1,
      combination: combination.name,
      utilisation: Math.min(Math.max(combined, perBoltShear / shearLimit), MAX_UTILISATION),
    });
  }
  const ultimate = ultimateCombinations(wind, crane, false);
  for (const combination of ultimate) {
    const { v, h } = combine(reaction, combination.factors);
    const perBoltShear = Math.abs(h) / bolts;
    const perBoltTension = Math.max(0, -v) / bolts;
    const combined = perBoltShear / shearLimit + perBoltTension / (1.4 * tensionLimit);
    interaction.push({
      value: combined,
      limit: 1,
      combination: combination.name,
      utilisation: Math.min(Math.max(combined, perBoltShear / shearLimit), MAX_UTILISATION),
    });
  }
  const tensionWorst = worst(tension);
  if (wind && tensionWorst) {
    rows.push(
      row(
        `anchor tension Ft,Rd M${Math.round(toMm(plate.boltDiameter))} 8.8`,
        tensionWorst,
        'kN/bolt',
      ),
    );
  }
  const interactionWorst = worst(interaction);
  if (interactionWorst) {
    rows.push(row('anchor shear + tension (Fv/Fv,Rd + Ft/1.4Ft,Rd)', interactionWorst, '-'));
  }
  const column = building.elements[plate.memberId];
  const profile = column?.category === 'member' ? findProfile(column.profile) : undefined;
  if (plate.fixity === 'fixed' && column?.category === 'member' && profile) {
    const geometry = {
      length: toMm(plate.length),
      width: toMm(plate.width),
      thickness: toMm(plate.thickness),
      boltCount: plate.boltCount,
      boltDiameter: toMm(plate.boltDiameter),
      columnDepth: profile.h,
    };
    const fy = yieldStrength(plate.material);
    const moments: Array<Candidate & { detail: string }> = plateDemands(reaction, wind).map(
      (demand) => {
        const verdict = checkPlateMN(geometry, demand.normal, demand.moment, fy);
        return {
          value: verdict.boltTension,
          limit: verdict.boltLimit,
          combination: demand.combination,
          utilisation: verdict.utilisation,
          detail: `N ${demand.normal.toFixed(0)} kN, M ${demand.moment.toFixed(0)} kNm: ${verdict.check}`,
        };
      },
    );
    const momentWorst = moments.reduce<(Candidate & { detail: string }) | null>(
      (best, item) => (best === null || item.utilisation > best.utilisation ? item : best),
      null,
    );
    if (momentWorst) {
      rows.push(row(`base plate M+N (${momentWorst.detail})`, momentWorst, 'kN/bolt'));
    }
  }
  return rows;
}

export function differentialRows(
  doc: CadDocument,
  settlements: ReadonlyArray<{
    frame: string;
    x: number;
    column: string;
    footing: FootingElement;
    settlement: number;
  }>,
): FoundationRow[] {
  let best: FoundationRow | null = null;
  for (const frame of new Set(settlements.map((item) => item.frame))) {
    const ordered = settlements.filter((item) => item.frame === frame).sort((a, b) => a.x - b.x);
    for (let index = 1; index < ordered.length; index++) {
      const [a, b] = [ordered[index - 1], ordered[index]] as [
        (typeof ordered)[number],
        (typeof ordered)[number],
      ];
      const spanMm = toMetres(doc, b.x - a.x) * 1000;
      if (spanMm <= 0) continue;
      const limit = spanMm / DIFFERENTIAL_RATIO;
      const value = Math.abs(a.settlement - b.settlement);
      const utilisation = Math.min(value / limit, MAX_UTILISATION);
      if (best === null || utilisation > best.utilisation) {
        best = {
          column: `${a.column}–${b.column}`,
          footing: `${a.footing.mark}/${b.footing.mark}`,
          elementId: a.footing.id,
          check: `differential settlement (L/${DIFFERENTIAL_RATIO}, ${round(spanMm / 1000, 1)} m)`,
          value,
          limit,
          unit: 'mm',
          utilisation,
          combination: 'G+S',
        };
      }
    }
  }
  return best ? [best] : [];
}

/** Weight (kN) of the ground slabs of a level (their friction is shared per column for tied frames). */
export function groundSlabWeight(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
): number {
  return Object.values(building.elements).reduce(
    (sum, element) =>
      element.category === 'slab' && element.levelId === levelId
        ? sum +
          CONCRETE_UNIT_WEIGHT *
            polygonArea(
              element.boundary.map(([x, y]): [number, number] => [
                toMetres(doc, x),
                toMetres(doc, y),
              ]),
            ) *
            toMetres(doc, element.thickness)
        : sum,
    0,
  );
}

/** Horizontal force (kN) resisted by one pad: shared across the frame columns when `thrustTie`. */
export function slidingHorizontalOf(
  reactions: ReadonlyArray<BaseReaction>,
  reaction: BaseReaction,
  thrustTie: boolean,
): (factors: Factors) => number {
  const siblings = reactions.filter((other) => other.frame === reaction.frame);
  return (factors) =>
    thrustTie
      ? siblings.reduce((sum, other) => sum + combine(other, factors).h, 0) / siblings.length
      : combine(reaction, factors).h;
}

/** Tie / slab assumed by default when the level has a slab element. */
export function defaultThrustTie(doc: CadDocument, levelId: string): boolean {
  return Object.values(getBuilding(doc).elements).some(
    (element) => element.category === 'slab' && element.levelId === levelId,
  );
}

export const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;
