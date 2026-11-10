/** 14 FLL-M3: printed-part (FDM) idealization of a part of an analysis case, and the coupon records the infill exponent is fitted from. */

import type { Vec3 } from './vectors';

export const PRINT_PATTERNS = ['gyroid', 'grid', 'lightning', 'honeycomb'] as const;
export type PrintPattern = (typeof PRINT_PATTERNS)[number];

/** Where a measured or quoted value comes from (a coupon test report, a data sheet, a paper). */
export interface PrintSource {
  readonly citation: string;
  readonly locator?: string;
  readonly url?: string;
  readonly accessed?: string;
  readonly note?: string;
}

/** Measured modulus (and optionally strength) of a printed coupon pulled along the build plane (`xy`) or along the build direction (`z`). */
export interface PrintCoupon {
  readonly id: string;
  readonly pattern: PrintPattern;
  /** Infill volume fraction of the coupon, in (0, 1]; 1 = solid. */
  readonly infillDensity: number;
  readonly direction: 'xy' | 'z';
  /** Skin fraction of the coupon in [0, 1): the volume share of its walls and top / bottom layers (the coupon modulus includes them). */
  readonly skinFraction: number;
  readonly modulusMpa: number;
  readonly utsMpa?: number;
  readonly source: PrintSource;
}

/** The exponent m of E_core = E_solid * density^m and where it comes from. */
export interface PrintExponent {
  readonly value: number;
  readonly basis: 'given' | 'fit';
  /** `given`: the caller's source. `fit`: the coupons (and direction) the value was least-squares fitted from. */
  readonly source: PrintSource;
}

/** Solid (infill 100 %) coupon values of the printer / material / settings: all moduli and strengths in MPa. */
interface PrintSolidCoupon {
  readonly E_xyMpa: number;
  readonly E_zMpa: number;
  readonly uts_xyMpa: number;
  readonly uts_zMpa: number;
  readonly source: PrintSource;
}

export interface PrintIdealization {
  /** Perimeter walls and their line width (mm): skin thickness = walls x lineWidthMm laterally. */
  readonly walls: number;
  readonly lineWidthMm: number;
  readonly layerHeightMm: number;
  /** Solid top and bottom layers (along `layerAxis`): thickness = topBottomLayers x layerHeightMm. */
  readonly topBottomLayers: number;
  readonly infill: { readonly pattern: PrintPattern; readonly density: number };
  /** Build direction (unit vector, document frame): material direction 3 of the orthotropic model. */
  readonly layerAxis: Vec3;
  readonly coupon: PrintSolidCoupon;
  readonly exponent: PrintExponent;
}
