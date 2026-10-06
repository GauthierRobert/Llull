/**
 * @layer domain-aec
 */

import type { FootingElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '../model';
import {
  BACKFILL_UNIT_WEIGHT,
  CONCRETE_UNIT_WEIGHT,
  type Combination,
  DIFFERENTIAL_RATIO,
  FRICTION,
  footingMetres,
  type FootingCheckContext,
  type FoundationRow,
  type PadSettlement,
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
  serviceCombinations,
  ultimateCombinations,
  worst,
} from './foundationCombinations';
import { footingSettlementParts } from './foundationSettlement';
import { round } from '../numeric';

/** demand / resistance capped at MAX_UTILISATION; zero resistance fails any demand. */
const demandRatio = (demand: number, resistance: number): number =>
  resistance > 0
    ? Math.min(demand / resistance, MAX_UTILISATION)
    : demand > 0
      ? MAX_UTILISATION
      : 0;

export const rowOf =
  (column: string, footing: string, elementId: string) =>
  (check: string, best: Candidate, unit: string): FoundationRow => ({
    column,
    footing,
    elementId,
    check,
    value: best.value,
    limit: best.limit,
    unit,
    utilisation: best.utilisation,
    combination: best.combination,
  });

/** Footing check rows (bearing, uplift, overturning, sliding, settlement) of one column's pad. */
export function footingRows(
  context: FootingCheckContext,
  footing: FootingElement,
  columnMark: string,
): FoundationRow[] {
  const { doc, reaction, soilBearing, wind, slidingHorizontal, slabShare, soilModulus, clayLayer } =
    context;
  const crane = hasCase(reaction, 'CL') || hasCase(reaction, 'CR');
  // Bending dimension = the smaller plan side (frame plane direction unknown: conservative).
  const { breadth, length: depthLength, thickness, backfill } = footingMetres(doc, footing);
  const area = breadth * depthLength;
  const selfWeight = CONCRETE_UNIT_WEIGHT * area * thickness;
  const soilWeight = BACKFILL_UNIT_WEIGHT * area * backfill;
  const weights = selfWeight + soilWeight;
  const lever = thickness + backfill;
  const row = rowOf(columnMark, footing.mark, footing.id);
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
        utilisation: demandRatio(destabilising, stabilising),
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
      utilisation: demandRatio(demand, resistance),
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

export function differentialRows(
  doc: CadDocument,
  settlements: ReadonlyArray<PadSettlement>,
): FoundationRow[] {
  let best: FoundationRow | null = null;
  for (const frame of new Set(settlements.map((item) => item.frame))) {
    const ordered = settlements.filter((item) => item.frame === frame).sort((a, b) => a.x - b.x);
    for (let index = 1; index < ordered.length; index++) {
      const [a, b] = [ordered[index - 1], ordered[index]] as [PadSettlement, PadSettlement];
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
