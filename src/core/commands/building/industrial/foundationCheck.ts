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
import { polygonArea } from '../../../../lib/polygon';
import {
  describeLoads,
  FRAME_LOAD_PROPERTIES,
  resolveFrameLoads,
  type FrameLoadParams,
} from './frameCheck';
import { baseReactions, type BaseReaction, type FrameLoads, type LoadCase } from './frameModel';
import { boltResistance } from './steelDesign';

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
}

type Factors = Partial<Record<LoadCase, number>>;
interface Combination {
  readonly name: string;
  readonly factors: Factors;
}

const CONCRETE_UNIT_WEIGHT = 25; // kN/m³
const BACKFILL_UNIT_WEIGHT = 18; // kN/m³
const FRICTION = 0.45;
const FCD = 25 / 1.5; // C25/30, N/mm²
const CONCENTRATION_FACTOR = 1.5;
const BEARING_STRENGTH = (2 / 3) * FCD * CONCENTRATION_FACTOR; // N/mm²
const MAX_UTILISATION = 99;
const MIN_EFFECTIVE_RATIO = 0.01;
const TOLERANCE_METRES = 0.1;
/** 2 × H16 B500 bars: 2 × 201 mm² × 435 N/mm², kN. */
const DEFAULT_TIE_CAPACITY = 175;

function combine(reaction: BaseReaction, factors: Factors): { v: number; h: number } {
  let v = 0;
  let h = 0;
  for (const [loadCase, factor] of Object.entries(factors) as [LoadCase, number][]) {
    const forces = reaction.cases[loadCase];
    if (!forces) continue;
    v += (factor * forces.vertical) / 1000;
    h += (factor * forces.horizontal) / 1000;
  }
  return { v, h };
}

function hasCase(reaction: BaseReaction, loadCase: LoadCase): boolean {
  const forces = reaction.cases[loadCase];
  return forces !== undefined && (forces.vertical !== 0 || forces.horizontal !== 0);
}

/** SLS characteristic combinations for soil bearing. */
function serviceCombinations(wind: boolean, crane: boolean): Combination[] {
  const list: Combination[] = [{ name: 'G+S', factors: { G: 1, S: 1 } }];
  if (wind) {
    list.push(
      { name: 'G+S+0.6W→', factors: { G: 1, S: 1, WL: 0.6 } },
      { name: 'G+S+0.6W←', factors: { G: 1, S: 1, WR: 0.6 } },
      { name: 'G+W→', factors: { G: 1, WL: 1 } },
      { name: 'G+W←', factors: { G: 1, WR: 1 } },
    );
  }
  if (crane) {
    list.push(
      { name: 'G+C(left)', factors: { G: 1, CL: 1 } },
      { name: 'G+C(right)', factors: { G: 1, CR: 1 } },
    );
  }
  return list;
}

/** ULS combinations; `favourable` uses 1.0G (uplift / sliding), otherwise 1.35G (compression). */
function ultimateCombinations(wind: boolean, crane: boolean, favourable: boolean): Combination[] {
  const g = favourable ? 1 : 1.35;
  const list: Combination[] = [];
  if (favourable) {
    list.push({ name: '1.0G+1.5S', factors: { G: g, S: 1.5 } });
    if (wind) {
      list.push(
        { name: '1.0G+1.5W→', factors: { G: g, WL: 1.5 } },
        { name: '1.0G+1.5W←', factors: { G: g, WR: 1.5 } },
      );
    }
    if (crane) {
      list.push(
        { name: '1.0G+1.35C(left)', factors: { G: g, CL: 1.35 } },
        { name: '1.0G+1.35C(right)', factors: { G: g, CR: 1.35 } },
      );
    }
    return list;
  }
  list.push({ name: '1.35G+1.5S', factors: { G: g, S: 1.5 } });
  if (wind) {
    list.push(
      { name: '1.35G+1.5W→+0.75S', factors: { G: g, WL: 1.5, S: 0.75 } },
      { name: '1.35G+1.5W←+0.75S', factors: { G: g, WR: 1.5, S: 0.75 } },
    );
  }
  if (crane) {
    list.push(
      { name: '1.35G+1.35C(left)+0.75S', factors: { G: g, CL: 1.35, S: 0.75 } },
      { name: '1.35G+1.35C(right)+0.75S', factors: { G: g, CR: 1.35, S: 0.75 } },
    );
  }
  return list;
}

function columnBaseLocation(column: SteelMemberElement): { x: number; y: number } {
  const base = column.start[2] <= column.end[2] ? column.start : column.end;
  return { x: base[0], y: base[1] };
}

function findFooting(
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

function findPlate(building: BuildingModel, columnId: string): BasePlateElement | null {
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

function footingRows(
  doc: CadDocument,
  reaction: BaseReaction,
  columnMark: string,
  footing: FootingElement,
  soilBearing: number,
  wind: boolean,
  slidingHorizontal: (factors: Factors) => number,
  slabShare: number,
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
    const { v, h } = combine(reaction, combination.factors);
    const total = v + weights;
    if (total <= 0) continue;
    const eccentricity = (Math.abs(h) * lever) / total;
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
    for (const combination of ultimateCombinations(wind, crane, true).filter((c) =>
      /W/.test(c.name),
    )) {
      const net = Math.max(0, -combine(reaction, combination.factors).v);
      uplift.push({
        value: net,
        limit: resisting,
        combination: combination.name,
        utilisation: resisting > 0 ? Math.min(net / resisting, MAX_UTILISATION) : MAX_UTILISATION,
      });
    }
    const upliftWorst = worst(uplift);
    if (upliftWorst) rows.push(row('uplift EQU (0.9 Gstb >= net 1.0G+1.5W)', upliftWorst, 'kN'));
  }

  const sliding: Candidate[] = [];
  for (const combination of ultimateCombinations(wind, crane, true)) {
    const { v } = combine(reaction, combination.factors);
    const h = slidingHorizontal(combination.factors);
    const resistance = FRICTION * Math.max(0, v + weights + slabShare);
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
  if (slidingWorst) rows.push(row(`sliding (mu ${FRICTION})`, slidingWorst, 'kN'));
  return rows;
}

function plateRows(
  doc: CadDocument,
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
  const resistance = boltResistance(toMm(plate.boltDiameter));
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
  return rows;
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
        true,
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
        ),
      );
    }
    if (plate) {
      plates += 1;
      rows.push(...plateRows(doc, reaction, column.mark, footing?.mark ?? '—', plate, wind));
    }
  }
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
    'weight) vs net uplift under 1.0G + 1.5W (only with windPressure > 0); (3) sliding, H vs μ = 0.45 ' +
    '× (V + weights) under 1.0G + 1.5 S / W / 1.35 C, with the thrust shared across the frame columns ' +
    'when thrustTie (a tie or slab is assumed to take the gravity thrust, checked against tieCapacity, and the ground slab weight adds its friction, shared per column); (4) base plate: concrete bearing under ' +
    '1.35G + 1.5S / wind / crane combinations vs fjd = 2/3 × 1.5 × fcd (C25/30, fcd 16.7 N/mm²) over ' +
    'the whole plate area, anchor tension (uplift shared by all bolts vs 0.9 fub As / 1.25) and ' +
    'bolt shear + tension interaction (αv 0.6, Ft/1.4), always grade 8.8. Simplifications: pinned ' +
    'bases (no moment), horizontal force taken at the plate level, bending in the smaller footing ' +
    'side, no biaxial effects, no backfill reduction for the column, no friction in the anchor ' +
    'shear check, no footing reinforcement or punching, no settlement. Returns one row per check ' +
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
        `(${describeLoads(loads)}, soil ${soilBearing} kPa, ${thrustTie ? `thrust taken by a tie / slab (capacity ${tieCapacity} kN)` : 'thrust resisted by pad friction'}): ${rows.length} check(s), ` +
        (unchecked > 0
          ? `${unchecked} footing(s) not checked (no analysed frame column, e.g. gable posts); `
          : '') +
        `max utilisation ${round(worstRow.utilisation)} (${worstRow.column} ${worstRow.check}, ${worstRow.combination}); ` +
        (failures.length === 0
          ? 'all OK (pinned bases, no settlement / reinforcement checks).'
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
