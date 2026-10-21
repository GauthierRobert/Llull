/**
 * Fuselage cross-sections as one closed rational quadratic NURBS (nine poles, four conic arcs, Liming rho): the right and left halves, upper
 * and lower, meet at the max-breadth points with vertical tangents and at crown and keel with horizontal ones, so every section of every
 * type shares one pole / knot layout and the skin through them stays exact.
 */

import type { FuselageSection } from '@aero/surfacing/types';
import type { Vec3 } from '@core/model/types';
import { conicWeight } from '@lib/nurbs/conic';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import type { NurbsCurveData } from '@lib/nurbs/types';

/** Largest allowed superellipse exponent (the arcs flatten into a rectangle as it grows; rho -> 1). */
const MAX_EXPONENT = 50;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

interface RingSpec {
  readonly bl: number;
  readonly halfBreadth: number;
  readonly wlMax: number;
  readonly wlUpper: number;
  readonly wlLower: number;
  readonly rhoUpper: number;
  readonly rhoLower: number;
}

/** The nine-pole section at station `fs`; `path` names the parameter in a refusal. */
function ring(fs: number, spec: RingSpec): NurbsCurveData {
  const { bl, halfBreadth: a, wlMax, wlUpper, wlLower } = spec;
  const at = (y: number, z: number): Vec3 => [fs, y, z];
  const [wu, wl] = [conicWeight(spec.rhoUpper), conicWeight(spec.rhoLower)];
  return {
    degree: 2,
    poles: [
      at(bl + a, wlMax),
      at(bl + a, wlUpper),
      at(bl, wlUpper),
      at(bl - a, wlUpper),
      at(bl - a, wlMax),
      at(bl - a, wlLower),
      at(bl, wlLower),
      at(bl + a, wlLower),
      at(bl + a, wlMax),
    ],
    weights: [1, wu, 1, wu, 1, wl, 1, wl, 1],
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
  };
}

/**
 * Largest radial distance (document units) between the four-conic ring and the true superellipse |y/a|^n + |z/b|^n = 1: the conic arcs
 * meet the curve at the axes and the 45 degree point only, so the ring is exact for n = 2 and an approximation otherwise (about 0.4 % of
 * the radius at n = 2.5, 1 % at n = 6).
 */
function superellipseDeviation(curve: NurbsCurveData, bl: number, wl: number, a: number, b: number, n: number): number {
  let worst = 0;
  for (let k = 0; k <= 160; k++) {
    const [, y, z] = evaluateCurve(curve, k / 160);
    const [dy, dz] = [y - bl, z - wl];
    const implicit = Math.abs(dy / a) ** n + Math.abs(dz / b) ** n;
    if (implicit > 0) worst = Math.max(worst, Math.abs(1 - implicit ** (-1 / n)) * Math.hypot(dy, dz));
  }
  return worst;
}

export type SectionResult =
  | { readonly curve: NurbsCurveData; readonly deviation?: number }
  | { readonly code: 'AERO_PARAM_INVALID' | 'SRF_CONIC_RHO_RANGE'; readonly message: string };

const bad = (message: string): SectionResult => ({ code: 'AERO_PARAM_INVALID', message });
const badRho = (message: string): SectionResult => ({ code: 'SRF_CONIC_RHO_RANGE', message });

/**
 * The closed section curve of a station.
 * @failure missing or non-finite fields, non-positive breadth / height, crown not above the max-breadth point or keel not below, rho outside (0, 1) -> code + message
 */
export function sectionCurve(fs: number, section: FuselageSection): SectionResult {
  const bl = section.bl ?? 0;
  if (!isNumber(bl)) return bad('bl must be a finite number');
  switch (section.type) {
    case 'point': {
      if (!isNumber(section.wl)) return bad('a point station needs wl');
      const apex: Vec3 = [fs, bl, section.wl];
      return {
        curve: {
          degree: 2,
          poles: Array.from({ length: 9 }, () => apex),
          weights: new Array<number>(9).fill(1),
          knots: [0, 0.25, 0.5, 0.75, 1],
          multiplicities: [3, 2, 2, 2, 3],
        },
      };
    }
    case 'circle': {
      if (!isNumber(section.wl) || !isNumber(section.radius) || !(section.radius > 0))
        return bad('a circle station needs wl and radius > 0');
      const r = section.radius;
      return {
        curve: ring(fs, {
          bl,
          halfBreadth: r,
          wlMax: section.wl,
          wlUpper: section.wl + r,
          wlLower: section.wl - r,
          rhoUpper: Math.SQRT2 - 1,
          rhoLower: Math.SQRT2 - 1,
        }),
      };
    }
    case 'superellipse': {
      const { halfBreadth, halfHeight, exponent, wl } = section;
      if (!isNumber(wl) || !isNumber(halfBreadth) || !isNumber(halfHeight) || !(halfBreadth > 0) || !(halfHeight > 0))
        return bad('a superellipse station needs wl, halfBreadth > 0 and halfHeight > 0');
      if (!isNumber(exponent) || !(exponent > 1) || exponent > MAX_EXPONENT)
        return bad(`exponent must be within (1, ${MAX_EXPONENT}] (2 = ellipse)`);
      const rho = 2 ** (1 - 1 / exponent) - 1;
      const curve = ring(fs, {
        bl,
        halfBreadth,
        wlMax: wl,
        wlUpper: wl + halfHeight,
        wlLower: wl - halfHeight,
        rhoUpper: rho,
        rhoLower: rho,
      });
      return { curve, deviation: superellipseDeviation(curve, bl, wl, halfBreadth, halfHeight, exponent) };
    }
    case 'conic': {
      const { halfBreadth, wlMaxBreadth, upper, lower } = section;
      if (!isNumber(halfBreadth) || !(halfBreadth > 0) || !isNumber(wlMaxBreadth) || upper === undefined || lower === undefined)
        return bad('a conic station needs halfBreadth > 0, wlMaxBreadth, upper and lower { wlExtreme, rho }');
      if (![upper.wlExtreme, upper.rho, lower.wlExtreme, lower.rho].every(isNumber))
        return bad('upper and lower need finite wlExtreme and rho');
      if (!(upper.rho > 0 && upper.rho < 1 && lower.rho > 0 && lower.rho < 1))
        return badRho(`rho must lie in (0, 1) (got upper ${upper.rho}, lower ${lower.rho})`);
      if (!(upper.wlExtreme > wlMaxBreadth && lower.wlExtreme < wlMaxBreadth))
        return bad('the crown (upper.wlExtreme) must be above wlMaxBreadth and the keel (lower.wlExtreme) below it');
      return {
        curve: ring(fs, {
          bl,
          halfBreadth,
          wlMax: wlMaxBreadth,
          wlUpper: upper.wlExtreme,
          wlLower: lower.wlExtreme,
          rhoUpper: upper.rho,
          rhoLower: lower.rho,
        }),
      };
    }
  }
}
