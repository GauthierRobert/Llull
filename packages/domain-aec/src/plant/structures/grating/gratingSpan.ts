/** Closed forms for a simply supported grating span (06 STA §5.4): bars of one panel per metre of width, all loads per metre of width. */

import { ALLOWABLE_STRESS_MPA, ELASTIC_MODULUS_MPA, sectionPerMetre, type GratingType } from './gratingTypes';

const GRAVITY = 9.80665;

/** Allowable uniform load U = 8 F S / L² (self weight excluded, as in the NAAMM tables), kPa. L in mm. */
export const allowableUniformKPa = (type: GratingType, spanMm: number): number =>
  (8 * ALLOWABLE_STRESS_MPA * sectionPerMetre(type).modulus) / spanMm ** 2;

/** Allowable midspan line load across the width C = 4 F S / L, kN per metre of width. */
export const allowableConcentratedKNPerM = (type: GratingType, spanMm: number): number =>
  (4 * ALLOWABLE_STRESS_MPA * sectionPerMetre(type).modulus) / spanMm / 1000;

/** Midspan deflection under a uniform load: 5 w L⁴ / (384 E I), mm. */
export const uniformDeflectionMm = (type: GratingType, spanMm: number, loadKPa: number): number =>
  (5 * loadKPa * spanMm ** 4) / (384 * ELASTIC_MODULUS_MPA * sectionPerMetre(type).inertia);

/** Midspan deflection under a midspan line load: C L³ / (48 E I), mm. */
export const concentratedDeflectionMm = (type: GratingType, spanMm: number, loadKNPerM: number): number =>
  (loadKNPerM * 1000 * spanMm ** 3) / (48 * ELASTIC_MODULUS_MPA * sectionPerMetre(type).inertia);

/** Self weight of the grating, kPa. */
export const selfWeightKPa = (type: GratingType): number => (type.massKgM2 * GRAVITY) / 1000;
