/**
 * @layer domain-aec
 */

import type { SteelMemberElement } from '@core/model/building';
import type { SteelProfile } from '../steel/profiles';
import type { RoofCoefficients, RoofZone, ZoneCpe } from './windCoefficients';

/** Internal pressure coefficient: +0.2 maximises uplift / suction, -0.3 maximises wall pressure. */
export const CPI_SUCTION = 0.2;

export const CPI_PRESSURE = 0.3;

const NO_COEFFICIENT: ZoneCpe = { suction: 0, pressure: 0 };

/** Most negative cpe,10 of a zone over both load-case sets (suction governs uplift). */
export const suctionOf = (zone: ZoneCpe | undefined): number =>
  Math.min((zone ?? NO_COEFFICIENT).suction, (zone ?? NO_COEFFICIENT).pressure);

/** Largest positive cpe,10 of a zone over both sets, 0 when the zone has no pressure. */
export const pressureOf = (zone: ZoneCpe | undefined): number =>
  Math.max((zone ?? NO_COEFFICIENT).suction, (zone ?? NO_COEFFICIENT).pressure, 0);

/** Wind zone candidate of a purlin: label, governing suction and the positive pressure of the same zone. */
export interface WindOption {
  readonly zone: string;
  readonly cpe: number;
  readonly pressure: number;
  readonly direction: string;
}

/** F of the monopitch θ = 90° table is split in F_up / F_low (equal values). */
export const zoneOf = (coefficients: RoofCoefficients, zone: RoofZone): ZoneCpe | undefined =>
  zone === 'F' && coefficients.F === undefined
    ? { suction: suctionOf(coefficients.Fup), pressure: suctionOf(coefficients.Flow) }
    : coefficients[zone];

/** cpe,10 of the wall zones. */
export const CPE_WALL = { A: -1.2, B: -0.8, C: -0.5, D: 0.8 } as const;

export const PURLIN_DEFLECTION_RATIO = 200;

export const RAIL_DEFLECTION_RATIO = 150;

/** Fallback tributary width when a purlin row has no neighbour, mm. */
export const DEFAULT_TRIBUTARY = 1800;

export const TOLERANCE = 1;

export const GRAVITY = 9.81;

export type WallZone = keyof typeof CPE_WALL;

/** One verification of a member. */
export interface Verdict {
  /** Check name with its parameters (a row's governing check adds the member and its tributary). */
  readonly check: string;
  /** Design effect in `unit` (kNm, kN or mm). */
  readonly value: number;
  /** Resistance or limit in `unit`. */
  readonly limit: number;
  readonly unit: 'kNm' | 'kN' | 'mm';
  readonly utilisation: number;
  readonly combination: string;
}

/** Governing verdict of a purlin or rail. */
export interface PurlinRow extends Verdict {
  readonly elementId: string;
  readonly mark: string;
  readonly kind: 'purlin' | 'rail';
  /** Governing wind zone: F / G / H/I (roof) or A / B / C / D (wall). */
  readonly zone: string;
  /** Member span between frames, m. */
  readonly span: number;
  /** Purlins only: utilisation of the wind-uplift bending check alone (the zone-dependent one). */
  readonly upliftUtilisation?: number;
}

export interface ZoneSummary {
  readonly surface: 'roof' | 'wall';
  readonly zone: string;
  readonly cpe: number;
  readonly members: number;
  readonly maxUtilisation: number;
}

export type Point = readonly [number, number, number];

export interface Located {
  readonly member: SteelMemberElement;
  readonly profile: SteelProfile;
  readonly start: Point;
  readonly end: Point;
  /** Span, mm. */
  readonly length: number;
  readonly yMin: number;
  readonly yMax: number;
}
