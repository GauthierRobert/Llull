/**
 * Foundation verification of portal-frame columns: pad footing soil bearing (Meyerhof effective
 * width), uplift (EQU), sliding, and base plate concrete bearing + anchor bolts.
 * @layer core/commands/building/industrial
 */

import type {
  BasePlateElement,
  BuildingModel,
  FootingElement,
  SteelMemberElement,
} from '../../../model/building';
import type { CadDocument } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import { getBuilding, isFiniteNumber, noChange, toMetres } from '../model';
import { toCsv } from '../quantities';
import { findProfile } from '../steel/profiles';
import { polygonArea } from '../../../../lib/polygon';
import {
  describeLoads,
  FRAME_LOAD_PROPERTIES,
  resolveFrameLoads,
  type FrameLoadParams,
} from './frameCheck';
import {
  baseReactions,
  WIND_CASES,
  type BaseReaction,
  type FrameLoads,
  type LoadCase,
} from './frameModel';
import { anchorBoltResistance, yieldStrength } from './steelDesign';
import { BEARING_STRENGTH, checkPlateMN } from './basePlateMN';

export interface FoundationRow {
  /** Column mark. */
  readonly column: string;
  /** Footing mark, or '—' for a plate-only column. */
  readonly footing: string;
  /** Footing id for soil checks, base plate id for plate checks. */
  readonly elementId: string;
  readonly check: string;
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly utilisation: number;
  readonly combination: string;
}

export interface FoundationCheckParams extends FrameLoadParams {
  soilBearing?: number;
  thrustTie?: boolean;
  tieCapacity?: number;
  soilModulus?: number;
  clayLayer?: ClayLayer;
}

export interface ClayLayer {
  /** Depth of the layer top below the founding level, m. */
  readonly topDepth: number;
  /** Layer thickness, m. */
  readonly thickness: number;
  /** Virgin compression index Cc. */
  readonly compressionIndex: number;
  /** Recompression index Cr (default Cc / 5; only used with preconsolidationPressure). */
  readonly recompressionIndex?: number;
  /** Initial void ratio e0. */
  readonly voidRatio: number;
  /** Bulk unit weight, kN/m³ (default 19). */
  readonly unitWeight?: number;
  /** Preconsolidation pressure σ'p, kPa (default: normally consolidated). */
  readonly preconsolidationPressure?: number;
}

export type Factors = Partial<Record<LoadCase, number>>;
export interface Combination {
  readonly name: string;
  readonly factors: Factors;
}

const CONCRETE_UNIT_WEIGHT = 25; // kN/m³
const BACKFILL_UNIT_WEIGHT = 18; // kN/m³
const FRICTION = 0.45;
/** EN 1997-1 DA2 partial factor on sliding resistance. */
const GAMMA_R_H = 1.1;
const MAX_UTILISATION = 99;
const MIN_EFFECTIVE_RATIO = 0.01;
const TOLERANCE_METRES = 0.1;
/** 2 × H16 B500 bars: 2 × 201 mm² × 435 N/mm², kN. */
const DEFAULT_TIE_CAPACITY = 175;
const DEFAULT_SOIL_MODULUS = 20; // MPa
const POISSON_RATIO = 0.3;
/** Influence factor of a rigid square footing (elastic half-space; flexible centre = 1.12). */
const SETTLEMENT_INFLUENCE = 0.88;
const SETTLEMENT_LIMIT_MM = 25;
const DIFFERENTIAL_RATIO = 500;
const WATER_UNIT_WEIGHT = 9.81; // kN/m³
const DEFAULT_CLAY_UNIT_WEIGHT = 19; // kN/m³
const CONSOLIDATION_SUBLAYERS = 5;

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

/** SLS characteristic combinations for soil bearing. */
function serviceCombinations(wind: boolean, crane: boolean): Combination[] {
  const list: Combination[] = [{ name: 'G+S', factors: { G: 1, S: 1 } }];
  if (wind) {
    for (const { loadCase, label } of WIND_CASES) {
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
      for (const { loadCase, label } of WIND_CASES) {
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
    for (const { loadCase, label } of WIND_CASES) {
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

interface Candidate {
  value: number;
  limit: number;
  combination: string;
  utilisation: number;
}

function worst(candidates: Candidate[]): Candidate | null {
  return candidates.reduce<Candidate | null>(
    (best, item) => (best === null || item.utilisation > best.utilisation ? item : best),
    null,
  );
}

function footingNetPressure(
  doc: CadDocument,
  reaction: BaseReaction,
  footing: FootingElement,
): { pressure: number; breadth: number; length: number; foundingDepth: number } {
  const [widthX, lengthY, thickness] = [footing.width, footing.length, footing.thickness].map(
    (value) => toMetres(doc, value),
  ) as [number, number, number];
  const backfill = Math.max(0, -toMetres(doc, footing.topOffset));
  const area = widthX * lengthY;
  const { v } = combine(reaction, { G: 1, S: 1 });
  const gross =
    (v + (CONCRETE_UNIT_WEIGHT * thickness + BACKFILL_UNIT_WEIGHT * backfill) * area) / area;
  return {
    pressure: Math.max(0, gross - BACKFILL_UNIT_WEIGHT * (thickness + backfill)),
    breadth: Math.min(widthX, lengthY),
    length: Math.max(widthX, lengthY),
    foundingDepth: thickness + backfill,
  };
}

/** Strict validation of a clay layer; returns an error message or null. */
export function clayLayerError(layer: unknown): string | null {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) {
    return 'clayLayer must be an object { topDepth, thickness, compressionIndex, voidRatio, ... }';
  }
  const fields = layer as Record<string, unknown>;
  const positive = (name: string, allowZero = false): string | null => {
    const value = fields[name];
    return isFiniteNumber(value) && (allowZero ? value >= 0 : value > 0)
      ? null
      : `clayLayer.${name} must be a number ${allowZero ? '>= 0' : '> 0'}`;
  };
  const optional = (name: string): string | null =>
    fields[name] === undefined ? null : positive(name);
  const error =
    positive('topDepth', true) ??
    positive('thickness') ??
    positive('compressionIndex') ??
    positive('voidRatio') ??
    optional('recompressionIndex') ??
    optional('unitWeight') ??
    optional('preconsolidationPressure');
  if (error) return error;
  const unitWeight = (fields.unitWeight as number | undefined) ?? DEFAULT_CLAY_UNIT_WEIGHT;
  if (unitWeight <= WATER_UNIT_WEIGHT) {
    return `clayLayer.unitWeight must be > ${WATER_UNIT_WEIGHT} kN/m³ (water)`;
  }
  const cr = fields.recompressionIndex as number | undefined;
  if (cr !== undefined && cr > (fields.compressionIndex as number)) {
    return 'clayLayer.recompressionIndex must be <= compressionIndex';
  }
  return null;
}

/**
 * Primary consolidation settlement (mm) of a clay layer in 5 sublayers: groundwater at the founding level,
 * γ' = unitWeight − 9.81, σ'0 = 18 D + γ' z (D = founding depth, z below the founding level), Δσ = q B L / ((B + z)(L + z)) at the sublayer centre (2:1 spreading),
 * s = Σ Cc h/(1+e0) log10((σ'0+Δσ)/σ'0); with σ'p, Cr up to σ'p and Cc beyond.
 * @pure
 */
export function consolidationSettlement(
  netPressure: number,
  breadth: number,
  length: number,
  layer: ClayLayer,
  foundingDepth: number = 0,
): number {
  const effectiveWeight = (layer.unitWeight ?? DEFAULT_CLAY_UNIT_WEIGHT) - WATER_UNIT_WEIGHT;
  const recompression = layer.recompressionIndex ?? layer.compressionIndex / 5;
  const sublayer = layer.thickness / CONSOLIDATION_SUBLAYERS;
  let total = 0;
  for (let index = 0; index < CONSOLIDATION_SUBLAYERS; index++) {
    const z = layer.topDepth + (index + 0.5) * sublayer;
    const initial = BACKFILL_UNIT_WEIGHT * foundingDepth + effectiveWeight * z;
    const increase = (netPressure * breadth * length) / ((breadth + z) * (length + z));
    const final = initial + increase;
    const preconsolidation = layer.preconsolidationPressure;
    let strainIndex: number;
    if (preconsolidation === undefined || preconsolidation <= initial) {
      strainIndex = layer.compressionIndex * Math.log10(final / initial);
    } else if (final <= preconsolidation) {
      strainIndex = recompression * Math.log10(final / initial);
    } else {
      strainIndex =
        recompression * Math.log10(preconsolidation / initial) +
        layer.compressionIndex * Math.log10(final / preconsolidation);
    }
    total += (sublayer * strainIndex) / (1 + layer.voidRatio);
  }
  return total * 1000;
}

/**
 * Elastic settlement (mm) of a pad under SLS G+S: s = q B (1 − ν²) Is / Es, Is 0.88 (rigid square), q = (V + footing + backfill) / area − 18 kN/m³ × founding depth.
 * @pure
 */
export function footingSettlement(
  doc: CadDocument,
  reaction: BaseReaction,
  footing: FootingElement,
  soilModulus: number,
): number {
  const { pressure, breadth } = footingNetPressure(doc, reaction, footing);
  return (
    ((pressure * breadth * (1 - POISSON_RATIO ** 2) * SETTLEMENT_INFLUENCE) /
      (soilModulus * 1000)) *
    1000
  );
}

/** Elastic + primary consolidation settlement (mm) of a pad. */
export function footingSettlementParts(
  doc: CadDocument,
  reaction: BaseReaction,
  footing: FootingElement,
  soilModulus: number,
  clayLayer?: ClayLayer,
): { elastic: number; consolidation: number; total: number } {
  const elastic = footingSettlement(doc, reaction, footing, soilModulus);
  const { pressure, breadth, length, foundingDepth } = footingNetPressure(doc, reaction, footing);
  const consolidation = clayLayer
    ? consolidationSettlement(pressure, breadth, length, clayLayer, foundingDepth)
    : 0;
  return { elastic, consolidation, total: elastic + consolidation };
}

function footingRows(
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
    const equCombinations: Combination[] = WIND_CASES.map(({ loadCase, label }) => ({
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

function plateRows(
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

function differentialRows(
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

/**
 * Checks footings and base plates of the columns of a level.
 * @pure
 */
export function checkFoundations(
  doc: CadDocument,
  levelId: string,
  loads: FrameLoads,
  soilBearing: number,
  thrustTie: boolean,
  tieCapacity: number,
  soilModulus: number = DEFAULT_SOIL_MODULUS,
  clayLayer?: ClayLayer,
): { rows: FoundationRow[]; footings: number; plates: number; unchecked: number } {
  const building = getBuilding(doc);
  const wind = loads.windPressure > 0;
  const rows: FoundationRow[] = [];
  let footings = 0;
  let plates = 0;
  const reactions = baseReactions(doc, building, levelId, loads);
  const checkedFootings = new Set<string>();
  const tieDone = new Set<string>();
  // Tied frames: the ground slab (cast around the columns) adds its friction, shared per column.
  const slabWeight = thrustTie
    ? Object.values(building.elements).reduce(
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
      )
    : 0;
  const settlements: Array<{
    frame: string;
    x: number;
    column: string;
    footing: FootingElement;
    settlement: number;
  }> = [];
  const slabShare = reactions.length > 0 ? slabWeight / reactions.length : 0;
  for (const reaction of reactions) {
    const column = building.elements[reaction.columnId];
    if (column?.category !== 'member') continue;
    const siblings = reactions.filter((other) => other.frame === reaction.frame);
    const slidingHorizontal = (factors: Factors): number =>
      thrustTie
        ? siblings.reduce((sum, other) => sum + combine(other, factors).h, 0) / siblings.length
        : combine(reaction, factors).h;
    const footing = findFooting(doc, building, levelId, column);
    const plate = findPlate(building, column.id);
    if (thrustTie && !tieDone.has(reaction.frame) && (footing || plate)) {
      tieDone.add(reaction.frame);
      const gravity = ultimateCombinations(
        wind,
        siblings.some((other) => hasCase(other, 'CL') || hasCase(other, 'CR')),
        false,
      ).filter((combination) => !/W/.test(combination.name));
      const tie = gravity
        .flatMap((combination) =>
          siblings.map((other) => ({
            other,
            combination,
            force: Math.abs(combine(other, combination.factors).h),
          })),
        )
        .reduce((best, item) => (item.force > best.force ? item : best));
      rows.push({
        column: reaction.frame,
        footing: '—',
        elementId: tie.other.columnId,
        check: `thrust tie force (assumed 2 H16 B500 = ${round(tieCapacity, 0)} kN)`,
        value: tie.force,
        limit: tieCapacity,
        unit: 'kN',
        utilisation: Math.min(tie.force / tieCapacity, MAX_UTILISATION),
        combination: tie.combination.name,
      });
    }
    if (footing) {
      footings += 1;
      checkedFootings.add(footing.id);
      rows.push(
        ...footingRows(
          doc,
          reaction,
          column.mark,
          footing,
          soilBearing,
          wind,
          slidingHorizontal,
          slabShare,
          soilModulus,
          clayLayer,
        ),
      );
      settlements.push({
        frame: reaction.frame,
        x: footing.location[0],
        column: column.mark,
        footing,
        settlement: footingSettlementParts(doc, reaction, footing, soilModulus, clayLayer).total,
      });
    }
    if (plate) {
      plates += 1;
      rows.push(
        ...plateRows(doc, building, reaction, column.mark, footing?.mark ?? '—', plate, wind),
      );
    }
  }
  rows.push(...differentialRows(doc, settlements));
  const unchecked = Object.values(building.elements).filter(
    (element) =>
      element.category === 'footing' &&
      element.levelId === levelId &&
      !checkedFootings.has(element.id),
  ).length;
  return { rows, footings, plates, unchecked };
}

const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * @command check_foundations
 * @pure read-only
 * @affects none; data = { rows: FoundationRow[], csv, maxUtilisation, failures }
 * @failure bad params / unknown level / no footing or base plate under a frame column -> no data
 */
export const foundationCheck: CommandDefinition<FoundationCheckParams> = {
  name: 'check_foundations',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Preliminary foundation check of the portal-frame columns of a level, from the characteristic ' +
    'base reactions of the same frame analysis as check_portal_frames (same deadLoad / snowLoad / ' +
    'windPressure / craneCapacity inputs). For every column with a pad footing (location at the ' +
    'column base) and/or a base plate: (1) soil bearing under SLS G+S, G+S+0.6W (either way), G+W, ' +
    'G+C, pressure = (V + footing 25 kN/m³ + backfill 18 kN/m³ above the footing up to the level) / ' +
    'area, with load eccentricity from H × (footing depth + backfill) reducing the width to B′ = B − 2e ' +
    '(Meyerhof) against `soilBearing` (kPa, default 150); (2) uplift EQU, 0.9 × (footing + backfill ' +
    'weight) vs net uplift under 0.9G + 1.5W (only with windPressure > 0); (3) sliding, H vs ' +
    'μ = 0.45 × (V + weights) / γR,h (γR,h = 1.1, EN 1997 DA2) under 1.0G + 1.5 S / W / 1.35 C, with ' +
    'the thrust shared across the frame columns when thrustTie (a tie or slab is assumed to take ' +
    'the gravity thrust, checked against tieCapacity under 1.35G + 1.5S / crane without wind, and ' +
    'the ground slab weight adds its friction, shared per column); (4) base plate: concrete bearing under ' +
    '1.35G + 1.5S / wind / crane combinations vs fjd = 2/3 × 1.5 × fcd (C25/30, fcd 16.7 N/mm²) over ' +
    'the whole plate area, anchor tension (uplift shared by all bolts vs 0.9 fub As / 1.25) and ' +
    'bolt shear + tension interaction (shear αbc fub As / 1.25 with αbc = 0.44 − 0.0003 fyb, threads ' +
    'in the shear plane, EN 1993-1-8 §6.2.2(7); Ft/1.4), always grade 8.8. Fixed column bases (base plates ' +
    "with fixity 'fixed', add_portal_frame_building columnBase) add the base moment: bearing eccentricity " +
    'e = (M + H·lever) / (V + W), an overturning EQU row (stabilising 0.9G·B/2 vs destabilising moment) and a ' +
    "'base plate M+N' row (concrete bearing block fjd, tension anchor bolts Ft = (M − N zc)/z, plate bending; " +
    'EN 1993-1-8 §6.2.8 simplified; design_portal_frames sizes the plate). Simplifications: pinned ' +
    'bases have no moment, horizontal force taken at the plate level, bending in the smaller footing ' +
    'side, no biaxial effects, no backfill reduction for the column, no friction in the anchor ' +
    'shear check, no footing reinforcement or punching (see design_footings). (5) Elastic settlement of each pad under SLS G+S, s = q B (1 − ν²) Is / Es (net pressure q − 18 kN/m³ × founding depth, i.e. footing + backfill weight replaces excavated soil; Is 0.88 rigid square, ν 0.3, Es = `soilModulus`, default 20 MPa) vs 25 mm, plus the worst differential settlement between adjacent columns of a frame vs L/500. With the optional `clayLayer` the primary consolidation of a clay layer below the footing (5 sublayers, groundwater at the founding level, γ′ = unitWeight − 9.81, σ′0 = 18 kN/m³ × founding depth + γ′ z, Δσ by 2:1 spreading, s = Σ Cc h/(1+e0) log10((σ′0+Δσ)/σ′0), Cr up to preconsolidationPressure and Cc beyond) is added to the elastic settlement (same 25 mm limit, row text gives both parts) and feeds the differential row. Returns one row per check ' +
    'and column (worst combination); utilisation > 1 fails. Not a substitute for a geotechnical ' +
    'or structural engineer.',
  paramsSchema: {
    type: 'object',
    properties: {
      ...FRAME_LOAD_PROPERTIES,
      soilBearing: {
        type: 'number',
        description: 'Allowable (SLS) soil bearing pressure in kPa. Default 150. Must be > 0.',
      },
      thrustTie: {
        type: 'boolean',
        description:
          'true = the frame thrust is carried by a tie (ground slab cast around the columns or tie ' +
          "bars): each frame's columns share the frame's net horizontal reaction for the sliding " +
          'check and one tie-force row per frame is added. false = every pad resists its own ' +
          'horizontal reaction by friction. Default true when the level has a slab element, else false.',
      },
      soilModulus: {
        type: 'number',
        description:
          'Soil elastic (Young) modulus Es in MPa for the settlement rows. Default 20. Must be > 0.',
      },
      clayLayer: {
        type: 'object',
        description:
          'Optional compressible clay layer under the pads, adds primary consolidation settlement to the settlement rows. ' +
          'topDepth: depth of the layer top below the founding level, m (>= 0). thickness: m (> 0). compressionIndex: Cc (> 0). ' +
          'recompressionIndex: Cr (> 0, <= Cc; default Cc/5, used only with preconsolidationPressure). voidRatio: e0 (> 0). ' +
          'unitWeight: bulk kN/m³ (> 9.81, default 19; groundwater assumed at the founding level; σ′0 = 18 kN/m³ × founding depth + γ′·z). ' +
          'preconsolidationPressure: σ′p in kPa (> 0; omit for normally consolidated clay). Required: topDepth, thickness, compressionIndex, voidRatio.',
        properties: {
          topDepth: { type: 'number', description: 'Layer top below founding level, m (>= 0).' },
          thickness: { type: 'number', description: 'Layer thickness, m (> 0).' },
          compressionIndex: { type: 'number', description: 'Compression index Cc (> 0).' },
          recompressionIndex: {
            type: 'number',
            description: 'Recompression index Cr (> 0, <= Cc). Default Cc/5.',
          },
          voidRatio: { type: 'number', description: 'Initial void ratio e0 (> 0).' },
          unitWeight: {
            type: 'number',
            description: 'Bulk unit weight kN/m³ (> 9.81). Default 19.',
          },
          preconsolidationPressure: {
            type: 'number',
            description:
              "Preconsolidation pressure σ'p in kPa (> 0). Default: normally consolidated.",
          },
        },
        required: ['topDepth', 'thickness', 'compressionIndex', 'voidRatio'],
      },
      tieCapacity: {
        type: 'number',
        description:
          'Tie capacity in kN used for the tie-force row (thrustTie only). Default 175 = 2 × H16 B500 ' +
          'bars (fyd 435 N/mm²). Must be > 0.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const soilBearing = params.soilBearing ?? 150;
    if (!isFiniteNumber(soilBearing) || soilBearing <= 0) {
      return noChange(doc, 'check_foundations failed: soilBearing must be a number > 0 (kPa).');
    }
    const soilModulus = params.soilModulus ?? DEFAULT_SOIL_MODULUS;
    if (!isFiniteNumber(soilModulus) || soilModulus <= 0) {
      return noChange(doc, 'check_foundations failed: soilModulus must be a number > 0 (MPa).');
    }
    if (params.clayLayer !== undefined) {
      const clayError = clayLayerError(params.clayLayer);
      if (clayError) return noChange(doc, `check_foundations failed: ${clayError}.`);
    }
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved) return noChange(doc, `check_foundations failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const tieCapacity = params.tieCapacity ?? DEFAULT_TIE_CAPACITY;
    if (
      !isFiniteNumber(tieCapacity) ||
      tieCapacity <= 0 ||
      (params.thrustTie !== undefined && typeof params.thrustTie !== 'boolean')
    ) {
      return noChange(
        doc,
        'check_foundations failed: tieCapacity must be a number > 0 (kN) and thrustTie a boolean.',
      );
    }
    const thrustTie =
      params.thrustTie ??
      Object.values(getBuilding(doc).elements).some(
        (element) => element.category === 'slab' && element.levelId === levelId,
      );
    const { rows, footings, plates, unchecked } = checkFoundations(
      doc,
      levelId,
      loads,
      soilBearing,
      thrustTie,
      tieCapacity,
      soilModulus,
      params.clayLayer,
    );
    if (rows.length === 0) {
      return noChange(
        doc,
        `check_foundations failed: no portal frame column with a footing or base plate on level '${levelId}'.`,
      );
    }
    const failures = rows.filter((row) => row.utilisation > 1);
    const worstRow = rows.reduce((best, row) => (row.utilisation > best.utilisation ? row : best));
    const csv = toCsv(
      [
        'Column',
        'Footing',
        'Check',
        'Value',
        'Limit',
        'Unit',
        'Utilisation',
        'Status',
        'Combination',
      ],
      rows.map((row) => [
        row.column,
        row.footing,
        row.check,
        round(row.value),
        round(row.limit),
        row.unit,
        round(row.utilisation),
        row.utilisation > 1 ? 'FAIL' : 'OK',
        row.combination,
      ]),
    );
    const failureIds = [...new Set(failures.map((row) => row.elementId))];
    return {
      document: doc,
      summary:
        `Checked ${footings} footing(s) and ${plates} base plate(s) on level '${levelId}' ` +
        `(${describeLoads(loads)}, soil ${soilBearing} kPa, Es ${soilModulus} MPa, ${thrustTie ? `thrust taken by a tie / slab (capacity ${tieCapacity} kN)` : 'thrust resisted by pad friction'}): ${rows.length} check(s), ` +
        (unchecked > 0
          ? `${unchecked} footing(s) not checked (no analysed frame column, e.g. gable posts); `
          : '') +
        `max utilisation ${round(worstRow.utilisation)} (${worstRow.column} ${worstRow.check}, ${worstRow.combination}); ` +
        (failures.length === 0
          ? 'all OK (no reinforcement check).'
          : `${failures.length} failure(s): ${failures
              .slice(0, 8)
              .map((row) => `${row.column} ${row.check} ${round(row.utilisation)}`)
              .join(', ')}${failures.length > 8 ? ', …' : ''}.`),
      affected: [],
      data: {
        rows,
        csv,
        maxUtilisation: worstRow.utilisation,
        failures: failureIds,
      },
    };
  },
};
