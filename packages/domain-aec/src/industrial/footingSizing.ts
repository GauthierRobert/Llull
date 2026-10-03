/**
 * footingDesign: footingSizing.
 * @layer domain-aec
 */

import type { FootingElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { fromMm, toMetres } from '../model';
import { BaseReaction } from './frameModelSolve';
import { type ClayLayer, type Combination } from './foundationModel';
import { footingRows } from './foundationRows';
import { combine, footingMoment, ultimateCombinations } from './foundationCombinations';
import {
  BAR_DIAMETERS_MM,
  COVER_MM,
  C_RD_C,
  type Envelope,
  FCK,
  FCTM,
  FYD,
  FYK,
  type Geometry,
  INTEGRATION_STEPS,
  type Load,
  MAX_K,
  MAX_PLAN_MM,
  MAX_RHO,
  MAX_THICKNESS_MM,
  MIN_THICKNESS_MM,
  PLAN_MARGIN_MM,
  PLAN_STEP_MM,
  PUNCHING_STEPS,
  type PadSize,
  SPACINGS_MM,
  THICKNESS_STEP_MM,
  V_RD_MAX,
} from './footingModel';

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

interface Attempt {
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

export function geometryOf(
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
export function netLoads(
  reaction: BaseReaction,
  combinations: ReadonlyArray<Combination>,
  leverM: number,
): Load[] {
  return combinations.flatMap((combination) => {
    const { v, h, m } = combine(reaction, combination.factors);
    return v > 0
      ? [{ combination: combination.name, normal: v, moment: footingMoment(m, h, leverM) }]
      : [];
  });
}

export const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

const roundUp = (value: number, step: number): number => Math.ceil(value / step - 1e-9) * step;

export const sizeText = (size: PadSize): string => size.map((value) => Math.round(value)).join('×');

export interface SizingContext {
  doc: CadDocument;
  footing: FootingElement;
  face: { x: number; y: number };
  reaction: BaseReaction;
  wind: boolean;
  crane: boolean;
  soilBearing: number;
  soilModulus: number;
  clayLayer: ClayLayer | undefined;
  slidingHorizontal: (factors: Combination['factors']) => number;
  slabShare: number;
}

interface PadVerdict {
  /** Highest utilisation among the check_foundations footing rows (soil, uplift, overturning, sliding, settlement). */
  soilUtilisation: number;
  mat: ReturnType<typeof designMat> | null;
}

/** Soil rows (same rows as check_foundations) and, when they pass, the reinforced mat of a trial size. */
export function evaluatePad(
  context: SizingContext,
  size: PadSize,
): PadVerdict & { passes: boolean } {
  const [widthMm, lengthMm, thicknessMm] = size;
  const { doc, footing } = context;
  const trial: FootingElement = {
    ...footing,
    width: fromMm(doc, widthMm),
    length: fromMm(doc, lengthMm),
    thickness: fromMm(doc, thicknessMm),
  };
  const rows = footingRows(
    doc,
    context.reaction,
    '',
    trial,
    context.soilBearing,
    context.wind,
    context.slidingHorizontal,
    context.slabShare,
    context.soilModulus,
    context.clayLayer,
  );
  const soilUtilisation = Math.max(0, ...rows.map((row) => row.utilisation));
  if (soilUtilisation > 1) return { soilUtilisation, mat: null, passes: false };
  const geometry = geometryOf(doc, trial, context.face);
  const net = netLoads(
    context.reaction,
    ultimateCombinations(context.wind, context.crane, false),
    geometry.leverM,
  );
  const mat = designMat(geometry, net);
  return { soilUtilisation, mat, passes: mat.chosen !== null };
}

/** Trial sizes at the current aspect ratio, ascending concrete volume (wider plan first on ties). */
export function trialSizes(
  current: PadSize,
  face: { x: number; y: number },
  grow: boolean,
): PadSize[] {
  const [currentWidth, currentLength, currentThickness] = current;
  const ratio = currentLength / currentWidth;
  const footprintWidth = Math.max(
    face.x + 2 * PLAN_MARGIN_MM,
    (face.y + 2 * PLAN_MARGIN_MM) / ratio,
  );
  const firstWidth = roundUp(
    grow ? Math.max(footprintWidth, currentWidth) : footprintWidth,
    PLAN_STEP_MM,
  );
  const firstThickness = grow
    ? Math.max(MIN_THICKNESS_MM, roundUp(currentThickness, THICKNESS_STEP_MM))
    : MIN_THICKNESS_MM;
  const sizes: PadSize[] = [];
  for (let width = firstWidth; width <= MAX_PLAN_MM; width += PLAN_STEP_MM) {
    const length = roundUp(width * ratio, PLAN_STEP_MM);
    if (length > MAX_PLAN_MM) break;
    if (grow && length < currentLength) continue;
    for (
      let thickness = firstThickness;
      thickness <= MAX_THICKNESS_MM;
      thickness += THICKNESS_STEP_MM
    ) {
      sizes.push([width, length, thickness]);
    }
  }
  const volume = (size: PadSize): number => size[0] * size[1] * size[2];
  return sizes.sort((a, b) => volume(a) - volume(b) || b[0] - a[0]);
}
