/**
 * RC pad footing design (EN 1992-1-1, C25/30, B500): bottom mat from bending at the column / base
 * plate face, one-way shear at d, punching at every perimeter within 2d; reinforcement is stored on the footing.
 * @layer core/commands/building/industrial
 */

import type { FootingElement } from '../../../model/building';
import type { CadDocument } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import { elementAffected, fromMm, getBuilding, noChange, toMetres, withElement } from '../model';
import { findProfile } from '../steel/profiles';
import {
  describeLoads,
  FRAME_LOAD_PROPERTIES,
  resolveFrameLoads,
  type FrameLoadParams,
} from './frameCheck';
import { baseReactions, type BaseReaction } from './frameModel';
import {
  combine,
  findFooting,
  findPlate,
  ultimateCombinations,
  hasCase,
  type Combination,
} from './foundationCheck';

const FCK = 25; // N/mm², C25/30
const FCD = FCK / 1.5;
const FYK = 500; // N/mm², B500
const FYD = 0.87 * FYK;
const FCTM = 2.6;
const COVER_MM = 50;
const BAR_DIAMETERS_MM = [12, 16, 20, 25] as const;
const SPACINGS_MM = [100, 125, 150, 175, 200, 225, 250] as const;
const MAX_K = 0.167;
const C_RD_C = 0.12;
const MAX_RHO = 0.02;
const NU = 0.6 * (1 - FCK / 250);
const V_RD_MAX = 0.4 * NU * FCD;
const FALLBACK_COLUMN_MM = 300;
const INTEGRATION_STEPS = 200;
/** Control perimeters checked at a = 2d·i/PUNCHING_STEPS (EN 1992-1-1 §6.4.4(2)). */
const PUNCHING_STEPS = 20;

export interface FootingDesignRow {
  readonly id: string;
  readonly mark: string;
  readonly column: string;
  readonly status: 'designed' | 'failed' | 'unloaded';
  /** mm; null when not designed. */
  readonly barDiameter: number | null;
  /** mm; null when not designed. */
  readonly spacing: number | null;
  /** mm²/m: governing flexural requirement (>= minimum) and the provided area. */
  readonly asRequired: number;
  readonly asProvided: number | null;
  readonly shearUtilisation: number;
  readonly punchingUtilisation: number;
  /** Distance a (mm) from the face of the governing punching perimeter (<= 2d). */
  readonly punchingDistance: number;
  readonly combination: string;
  readonly note: string;
}

export interface Geometry {
  /** Plan sizes and thickness, mm. */
  readonly widthMm: number;
  readonly lengthMm: number;
  readonly thicknessMm: number;
  /** Column / plate face size along x and y, mm. */
  readonly faceXmm: number;
  readonly faceYmm: number;
  /** Lever arm of the horizontal force above the footing base, m. */
  readonly leverM: number;
}

export interface Load {
  readonly combination: string;
  /** Net vertical (kN, compression +) and base moment (kN·m). */
  readonly normal: number;
  readonly moment: number;
}

interface Envelope {
  /** Bending per metre width, kN·m/m. */
  readonly momentX: number;
  readonly momentY: number;
  readonly shearX: number;
  readonly shearY: number;
  /** Punching stress (N/mm²) at u1 and at the column face. */
  readonly punching: ReadonlyArray<number>;
  readonly faceStress: number;
  readonly combination: string;
}

/** Soil pressure along x from the highest-pressure edge: linear, truncated at zero (kPa). */
function pressureProfile(
  load: Load,
  widthM: number,
  lengthM: number,
): { at: (t: number) => number; mean: number; contact: number; eccentricity: number } {
  const eccentricity = load.moment / load.normal;
  const area = widthM * lengthM;
  if (eccentricity <= widthM / 6) {
    const mean = load.normal / area;
    const maximum = mean * (1 + (6 * eccentricity) / widthM);
    const gradient = (12 * mean * eccentricity) / widthM ** 2;
    return {
      at: (t) => Math.max(0, maximum - gradient * t),
      mean,
      contact: widthM,
      eccentricity,
    };
  }
  const contact = Math.max(3 * (widthM / 2 - eccentricity), 0.01 * widthM);
  const maximum = (2 * load.normal) / (contact * lengthM);
  return {
    at: (t) => Math.max(0, maximum * (1 - t / contact)),
    mean: load.normal / area,
    contact,
    eccentricity,
  };
}

function integrate(from: number, to: number, f: (t: number) => number): number {
  if (to <= from) return 0;
  const step = (to - from) / INTEGRATION_STEPS;
  let sum = 0;
  for (let index = 0; index < INTEGRATION_STEPS; index++) {
    sum += f(from + (index + 0.5) * step) * step;
  }
  return sum;
}

function envelope(geometry: Geometry, loads: ReadonlyArray<Load>, effectiveMm: number): Envelope {
  const [widthM, lengthM, faceX, faceY, depthM] = [
    geometry.widthMm,
    geometry.lengthMm,
    geometry.faceXmm,
    geometry.faceYmm,
    effectiveMm,
  ].map((value) => value / 1000) as [number, number, number, number, number];
  const armX = Math.max(0, (widthM - faceX) / 2);
  const armY = Math.max(0, (lengthM - faceY) / 2);
  const initial: Envelope = {
    momentX: 0,
    momentY: 0,
    shearX: 0,
    shearY: 0,
    punching: Array.from({ length: PUNCHING_STEPS }, () => 0),
    faceStress: 0,
    combination: '-',
  };
  let result = initial;
  let governingScore = -1;
  for (const load of loads) {
    const profile = pressureProfile(load, widthM, lengthM);
    const momentX = integrate(0, armX, (t) => profile.at(t) * (armX - t));
    const shearX = integrate(0, armX - depthM, profile.at);
    const meanY = load.normal / (Math.min(widthM, profile.contact) * lengthM);
    const momentY = (meanY * armY ** 2) / 2;
    const shearY = meanY * Math.max(0, armY - depthM);
    const [columnX, columnY] = [faceX, faceY];
    const beta = 1 + (1.8 * profile.eccentricity) / (columnX + 4 * depthM);
    const stresses = Array.from({ length: PUNCHING_STEPS }, (_, index) => {
      const distance = (2 * depthM * (index + 1)) / PUNCHING_STEPS;
      const inside = Math.min(
        columnX * columnY + 2 * distance * (columnX + columnY) + Math.PI * distance ** 2,
        widthM * lengthM,
      );
      const reduced = Math.max(0, load.normal - profile.mean * inside);
      const perimeter = 2 * (faceX + faceY) * 1000 + 2 * Math.PI * distance * 1000;
      return (beta * reduced * 1000) / (perimeter * effectiveMm);
    });
    const u0 = 2 * (faceX + faceY) * 1000;
    const faceStress = (beta * load.normal * 1000) / (u0 * effectiveMm);
    result = {
      momentX: Math.max(result.momentX, momentX),
      momentY: Math.max(result.momentY, momentY),
      shearX: Math.max(result.shearX, shearX),
      shearY: Math.max(result.shearY, shearY),
      punching: result.punching.map((value, index) => Math.max(value, stresses[index] ?? 0)),
      faceStress: Math.max(result.faceStress, faceStress),
      combination: momentX + momentY >= governingScore ? load.combination : result.combination,
    };
    governingScore = Math.max(governingScore, momentX + momentY);
  }
  return result;
}

const barArea = (diameterMm: number): number => (Math.PI * diameterMm ** 2) / 4;
const providedArea = (diameterMm: number, spacingMm: number): number =>
  (barArea(diameterMm) * 1000) / spacingMm;

/** Bending reinforcement per metre for a moment in kN·m/m; null when K exceeds the singly-reinforced limit. */
function flexuralArea(moment: number, effectiveMm: number): number | null {
  const design = moment * 1e6;
  const k = design / (1000 * effectiveMm ** 2 * FCK);
  if (k > MAX_K) return null;
  const lever = Math.min(0.95, 0.5 + Math.sqrt(0.25 - k / 1.134)) * effectiveMm;
  return design / (FYD * lever);
}

/** VRd,c (kN per metre width) and vRd,c (N/mm²) from EN 1992-1-1 §6.2.2. */
function concreteShear(
  areaPerMetre: number,
  effectiveMm: number,
): { vRd: number; stress: number; k: number; rho: number } {
  const k = Math.min(2, 1 + Math.sqrt(200 / effectiveMm));
  const rho = Math.min(areaPerMetre / (1000 * effectiveMm), MAX_RHO);
  const minimum = 0.035 * k ** 1.5 * Math.sqrt(FCK);
  const stress = Math.max(C_RD_C * k * (100 * rho * FCK) ** (1 / 3), minimum);
  return { vRd: (stress * 1000 * effectiveMm) / 1000, stress, k, rho };
}

export interface Attempt {
  readonly diameter: number;
  readonly spacing: number;
  readonly asRequired: number;
  readonly asProvided: number;
  readonly shear: number;
  readonly punching: number;
  readonly punchingDistance: number;
  readonly combination: string;
}

const CANDIDATES = BAR_DIAMETERS_MM.flatMap((diameter) =>
  SPACINGS_MM.map((spacing) => ({ diameter, spacing, mass: providedArea(diameter, spacing) })),
).sort((a, b) => a.mass - b.mass || b.spacing - a.spacing);

/** Lightest standard mat that satisfies flexure, minimum steel, shear and punching; else the closest attempt. */
export function designMat(
  geometry: Geometry,
  loads: ReadonlyArray<Load>,
): { chosen: Attempt | null; closest: Attempt | null; bendingLimited: boolean } {
  let closest: Attempt | null = null;
  let bendingLimited = false;
  for (const candidate of CANDIDATES) {
    const effective = geometry.thicknessMm - COVER_MM - candidate.diameter;
    if (effective <= 0) continue;
    const demand = envelope(geometry, loads, effective);
    const requiredX = flexuralArea(demand.momentX, effective);
    const requiredY = flexuralArea(demand.momentY, effective);
    const minimum = ((0.26 * FCTM) / FYK) * 1000 * effective;
    const flexure =
      requiredX === null || requiredY === null ? null : Math.max(requiredX, requiredY, minimum);
    const { vRd, stress } = concreteShear(candidate.mass, effective);
    const shear = Math.max(demand.shearX, demand.shearY) / vRd;
    let punching = demand.faceStress / V_RD_MAX;
    let punchingDistance = 0;
    demand.punching.forEach((demandStress, index) => {
      const distance = (2 * effective * (index + 1)) / PUNCHING_STEPS;
      const utilisation = demandStress / (stress * ((2 * effective) / distance));
      if (utilisation > punching) {
        punching = utilisation;
        punchingDistance = distance;
      }
    });
    const attempt: Attempt = {
      diameter: candidate.diameter,
      spacing: candidate.spacing,
      asRequired: flexure ?? Number.POSITIVE_INFINITY,
      asProvided: candidate.mass,
      shear,
      punching,
      punchingDistance,
      combination: demand.combination,
    };
    if (closest === null || Math.max(shear, punching) < Math.max(closest.shear, closest.punching)) {
      closest = attempt;
    }
    if (flexure !== null && shear <= 1 && punching <= 1) {
      if (candidate.mass >= flexure) return { chosen: attempt, closest, bendingLimited };
      bendingLimited = true;
    }
  }
  return { chosen: null, closest, bendingLimited };
}

function geometryOf(
  doc: CadDocument,
  footing: FootingElement,
  face: { x: number; y: number },
): Geometry {
  const toMm = (value: number): number => toMetres(doc, value) * 1000;
  return {
    widthMm: toMm(footing.width),
    lengthMm: toMm(footing.length),
    thicknessMm: toMm(footing.thickness),
    faceXmm: Math.min(face.x, toMm(footing.width)),
    faceYmm: Math.min(face.y, toMm(footing.length)),
    leverM: toMetres(doc, footing.thickness) + Math.max(0, -toMetres(doc, footing.topOffset)),
  };
}

/** Net ULS loads (no footing / backfill weight) of the compression combinations. */
function netLoads(
  reaction: BaseReaction,
  combinations: ReadonlyArray<Combination>,
  leverM: number,
): Load[] {
  return combinations.flatMap((combination) => {
    const { v, h } = combine(reaction, combination.factors);
    return v > 0
      ? [{ combination: combination.name, normal: v, moment: Math.abs(h) * leverM }]
      : [];
  });
}

const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * @command design_footings
 * @pure
 * @affects sets / replaces `reinforcement` on every analysed footing that passes; removes it from
 *          footings that fail shear or punching
 * @failure bad loads / unknown level / no footing under an analysed frame column -> no-op
 */
export const designFootings: CommandDefinition<FrameLoadParams> = {
  name: 'design_footings',
  description:
    'Design the reinforced-concrete pad footings under the portal-frame columns of a level to ' +
    'EN 1992-1-1 (C25/30, B500) and store the bottom reinforcement on each footing, using the same ' +
    'base reactions and loads as check_foundations (deadLoad / snowLoad / windPressure / ' +
    'craneCapacity). Per footing: ULS net soil pressure (no self-weight) from 1.35G + 1.5S / ' +
    'wind / crane combinations with load eccentricity (trapezoidal or triangular pressure); ' +
    'bending at the face of the base plate (else the column profile), d = h − 50 mm cover − φ, ' +
    'z ≤ 0.95d with K ≤ 0.167, As,min = 0.26 fctm/fyk b d; the lightest bar φ12/16/20/25 at ' +
    '100–250 mm spacing (same both ways) satisfying As, shear VRd,c at d from the face ' +
    '(§6.2.2, CRd,c 0.12) and punching at every control perimeter a ≤ 2d from the face (§6.4.4, vRd,c·2d/a) with the ' +
    'soil pressure inside it deducted (§6.4). If shear or punching fails with every standard mat the footing is reported ' +
    'as "increase thickness" and its reinforcement is not set (an old one is removed). The takeoff ' +
    'then reports `footing.rebar.kg` and the footing schedule a Reinforcement column. ' +
    'Simplifications: pinned bases, bending in the frame plane (x) from the horizontal reaction, ' +
    'uniform pressure across the other side, no uplift (tension) design, bar anchorage not checked. ' +
    'Preliminary design, not a substitute for a structural engineer.',
  paramsSchema: {
    type: 'object',
    properties: { ...FRAME_LOAD_PROPERTIES },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved) return noChange(doc, `design_footings failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const building = getBuilding(doc);
    const wind = loads.windPressure > 0;
    const reactions = baseReactions(doc, building, levelId, loads);
    const rows: FootingDesignRow[] = [];
    const seen = new Set<string>();
    let next = building;
    const changes: string[] = [];
    const changed: string[] = [];
    for (const reaction of reactions) {
      const column = building.elements[reaction.columnId];
      if (column?.category !== 'member') continue;
      const footing = findFooting(doc, building, levelId, column);
      if (!footing || seen.has(footing.id)) continue;
      seen.add(footing.id);
      const plate = findPlate(building, column.id);
      const profile = findProfile(column.profile);
      const toMm = (value: number): number => toMetres(doc, value) * 1000;
      const face = plate
        ? { x: toMm(plate.length), y: toMm(plate.width) }
        : { x: profile?.h ?? FALLBACK_COLUMN_MM, y: profile?.b ?? FALLBACK_COLUMN_MM };
      const geometry = geometryOf(doc, footing, face);
      const crane = hasCase(reaction, 'CL') || hasCase(reaction, 'CR');
      const net = netLoads(reaction, ultimateCombinations(wind, crane, false), geometry.leverM);
      const base = { id: footing.id, mark: footing.mark, column: column.mark };
      if (net.length === 0) {
        rows.push({
          ...base,
          status: 'unloaded',
          barDiameter: null,
          spacing: null,
          asRequired: 0,
          asProvided: null,
          shearUtilisation: 0,
          punchingUtilisation: 0,
          punchingDistance: 0,
          combination: '-',
          note: 'no ULS combination with net compression; reinforcement not set',
        });
        continue;
      }
      const { chosen, closest, bendingLimited } = designMat(geometry, net);
      const { reinforcement: previous, ...bare } = footing;
      if (chosen) {
        const reinforcement = {
          barDiameter: fromMm(doc, chosen.diameter),
          spacing: fromMm(doc, chosen.spacing),
          cover: fromMm(doc, COVER_MM),
        };
        if (
          previous?.barDiameter !== reinforcement.barDiameter ||
          previous.spacing !== reinforcement.spacing ||
          previous.cover !== reinforcement.cover
        ) {
          next = withElement(next, { ...bare, reinforcement });
          changed.push(footing.id);
          changes.push(`${footing.mark} H${chosen.diameter} @ ${chosen.spacing}`);
        }
        rows.push({
          ...base,
          status: 'designed',
          barDiameter: chosen.diameter,
          spacing: chosen.spacing,
          asRequired: chosen.asRequired,
          asProvided: chosen.asProvided,
          shearUtilisation: chosen.shear,
          punchingUtilisation: chosen.punching,
          punchingDistance: chosen.punchingDistance,
          combination: chosen.combination,
          note: '',
        });
        continue;
      }
      if (previous) {
        next = withElement(next, bare);
        changed.push(footing.id);
        changes.push(`${footing.mark} reinforcement removed`);
      }
      rows.push({
        ...base,
        status: 'failed',
        barDiameter: null,
        spacing: null,
        asRequired: closest?.asRequired ?? 0,
        asProvided: null,
        shearUtilisation: closest?.shear ?? 0,
        punchingUtilisation: closest?.punching ?? 0,
        punchingDistance: closest?.punchingDistance ?? 0,
        combination: closest?.combination ?? '-',
        note: bendingLimited
          ? 'bending needs more than H25 @ 100 — increase thickness or size'
          : closest === null || !Number.isFinite(closest.asRequired)
            ? 'bending exceeds the singly-reinforced limit (K > 0.167)'
            : 'shear or punching fails with every standard mat',
      });
    }
    if (rows.length === 0) {
      return noChange(
        doc,
        `design_footings failed: no portal frame column with a footing on level '${levelId}'.`,
      );
    }
    const designed = rows.filter((row) => row.status === 'designed');
    const failed = rows.filter((row) => row.status !== 'designed');
    const maxOf = (pick: (row: FootingDesignRow) => number): number =>
      Math.max(0, ...designed.map(pick));
    const maxShear = maxOf((row) => row.shearUtilisation);
    const maxPunching = maxOf((row) => row.punchingUtilisation);
    const format = (row: FootingDesignRow): string =>
      `${row.mark} H${row.barDiameter} @ ${row.spacing} (As ${round(row.asRequired, 0)} ≤ ${round(row.asProvided ?? 0, 0)} mm²/m, shear ${round(row.shearUtilisation)}, punching ${round(row.punchingUtilisation)}${row.punchingDistance > 0 ? ` at a=${round(row.punchingDistance, 0)} mm` : ''})`;
    const document = changed.length > 0 ? { ...doc, building: next } : doc;
    return {
      document,
      summary:
        `Designed ${designed.length} of ${rows.length} footing(s) on level '${levelId}' (${describeLoads(loads)}, C25/30 B500, cover ${COVER_MM} mm): ` +
        `${designed.length > 0 ? designed.slice(0, 8).map(format).join('; ') + (designed.length > 8 ? '; …' : '') : 'none'}. ` +
        (failed.length > 0
          ? `${failed.length} not reinforced — increase thickness: ${failed
              .slice(0, 8)
              .map(
                (row) =>
                  `${row.mark} (${row.note}; shear ${round(row.shearUtilisation)}, punching ${round(row.punchingUtilisation)})`,
              )
              .join('; ')}. `
          : '') +
        `Max shear ${round(maxShear)}, max punching ${round(maxPunching)}; ` +
        `${changed.length > 0 ? `${changed.length} footing(s) changed` : 'no change'}. Pinned bases, bending in the frame plane.`,
      affected: elementAffected(document, changed),
      data: { footings: rows, changes },
    };
  },
};
