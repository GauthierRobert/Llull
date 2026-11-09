/** record_print_coupon and fit_print_infill_exponent: the printed-coupon workflow of 14 FLL-M3 (record results with their source, fit the infill exponent). */

import { changed, report } from '@core/commands/noop';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { PRINT_PATTERNS, type PrintCoupon, type PrintPattern, type PrintSource } from '@core/model/printIdealization';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { analysisOf } from '../../shared/access';
import { quantitySchema } from '../../shared/schemas';
import { refuseFll } from '../codes';
import { fitPowerLaw, type PowerFit } from './homogenize';

export const sourceSchema = z.object({
  citation: z.string().describe('Where the value comes from: a test report id, a data sheet, a paper (required, non-empty).'),
  locator: z.string().optional().describe('Table, page or test number inside the citation.'),
  url: z.string().optional().describe('Link to the source, when public.'),
  accessed: z.string().optional().describe('Date the source was read (YYYY-MM-DD).'),
  note: z.string().optional().describe('Test conditions: temperature, speed, standard, printer, filament.'),
});

/** `source` without its undefined members (exactOptionalPropertyTypes). */
export function cleanSource(source: z.infer<typeof sourceSchema>): PrintSource {
  return {
    citation: source.citation.trim(),
    ...(source.locator !== undefined ? { locator: source.locator } : {}),
    ...(source.url !== undefined ? { url: source.url } : {}),
    ...(source.accessed !== undefined ? { accessed: source.accessed } : {}),
    ...(source.note !== undefined ? { note: source.note } : {}),
  };
}

/** `quantity` in MPa, or a reason string (unknown unit or not a stress). */
export function toMpa(quantity: { readonly value: number; readonly unit: string }, what: string): number | string {
  const converted = convertValue(quantity.value, quantity.unit, 'MPa');
  if (isUnitFailure(converted)) return `${what}: ${converted.message}`;
  return converted.value > 0 && Number.isFinite(converted.value)
    ? converted.value
    : `${what} must be > 0 (got ${quantity.value} ${quantity.unit})`;
}

/** Recorded coupons of `pattern` and `direction`, in recording order. */
function couponsOf(analysis: ReturnType<typeof analysisOf>, pattern: PrintPattern, direction: 'xy' | 'z'): PrintCoupon[] {
  return (analysis.printCouponOrder ?? []).flatMap((id) => {
    const coupon = Object.hasOwn(analysis.printCoupons ?? {}, id) ? analysis.printCoupons?.[id] : undefined;
    return coupon !== undefined && coupon.pattern === pattern && coupon.direction === direction ? [coupon] : [];
  });
}

export interface CouponFit {
  readonly fit: PowerFit;
  readonly couponIds: readonly string[];
}

/**
 * Least-squares fit of E = C density^m through the recorded coupons of one pattern and direction.
 * @failure fewer than 2 coupons or 2 distinct densities -> a reason string
 */
export function fitCoupons(analysis: ReturnType<typeof analysisOf>, pattern: PrintPattern, direction: 'xy' | 'z'): CouponFit | string {
  const coupons = couponsOf(analysis, pattern, direction);
  const fit = fitPowerLaw(coupons.map((coupon) => ({ density: coupon.infillDensity, modulus: coupon.modulusMpa })));
  return typeof fit === 'string'
    ? `${fit} (pattern ${pattern}, direction ${direction}: ${coupons.length} recorded)`
    : { fit, couponIds: coupons.map((coupon) => coupon.id) };
}

/**
 * @affects doc.analysis.printCoupons[id] and printCouponOrder (one coupon added or replaced; affected: [id])
 * @invariant the modulus and strength are stored in MPa; the source citation is required; the coupon changes no analysis (it is read by fit_print_infill_exponent)
 * @failure reserved id (registry CMD_RESERVED_ID), duplicate id without replace, non-stress or non-positive modulus / strength, empty citation -> rejected (FLL_PRINT_PARAM / FLL_PRINT_COUPON_EXISTS), unchanged document
 */
export const recordPrintCoupon = defineCommand({
  name: 'record_print_coupon',
  description:
    'Record the result of a tensile test of a printed coupon (14 FLL): the infill pattern and density (volume fraction, 1 = solid), whether it was pulled in the build plane (xy) or along ' +
    'the build direction (z), the measured modulus (and optionally the ultimate strength) with their units, and the source (test report, citation; required). Coupons are shared by all ' +
    'analyses and are the only input of fit_print_infill_exponent; they change no analysis by themselves. Use replace: true to correct a recorded coupon. ' +
    'llull ships no typical printed-part values: every number here is yours.',
  params: z.object({
    id: z.string().min(1).describe('Coupon id, unique in the document, e.g. "gyroid-25-xy-1".'),
    pattern: z.enum(PRINT_PATTERNS).describe('Infill pattern of the coupon: gyroid, grid, lightning or honeycomb.'),
    infillDensity: z.number().gt(0).max(1).describe('Infill volume fraction of the coupon in (0, 1]; 1 = solid.'),
    direction: z
      .enum(['xy', 'z'])
      .describe('xy: loaded in the build plane (along the layers); z: loaded along the build direction (across the layers).'),
    modulus: quantitySchema.describe('Measured Young modulus, e.g. { value: 1900, unit: "MPa" }.'),
    uts: quantitySchema.optional().describe('Measured ultimate tensile strength, e.g. { value: 19.3, unit: "MPa" }.'),
    source: sourceSchema.describe('Provenance of the measurement (required).'),
    replace: z.boolean().optional().describe('Overwrite an existing coupon with this id (default false: refused).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseFll(doc, 'record_print_coupon', code, message, [params.id], paths);
    if (params.source.citation.trim() === '')
      return fail('FLL_PRINT_PARAM', 'source.citation is empty: a coupon without a source is not recorded', ['source.citation']);
    const modulus = toMpa(params.modulus, 'modulus');
    if (typeof modulus === 'string') return fail('FLL_PRINT_PARAM', modulus, ['modulus']);
    const uts = params.uts === undefined ? undefined : toMpa(params.uts, 'uts');
    if (typeof uts === 'string') return fail('FLL_PRINT_PARAM', uts, ['uts']);
    const model = analysisOf(doc);
    const known = Object.hasOwn(model.printCoupons ?? {}, params.id);
    if (known && params.replace !== true) return fail('FLL_PRINT_COUPON_EXISTS', `coupon '${params.id}' is already recorded`, ['id']);
    const coupon: PrintCoupon = {
      id: params.id,
      pattern: params.pattern,
      infillDensity: params.infillDensity,
      direction: params.direction,
      modulusMpa: modulus,
      ...(uts === undefined ? {} : { utsMpa: uts }),
      source: cleanSource(params.source),
    };
    const order = model.printCouponOrder ?? [];
    const next = {
      ...model,
      printCoupons: { ...model.printCoupons, [params.id]: coupon },
      printCouponOrder: known ? order : [...order, params.id],
    };
    return changed(
      { ...doc, analysis: next },
      `record_print_coupon: ${known ? 'replaced' : 'recorded'} '${params.id}' (${params.pattern}, infill ${params.infillDensity}, ${params.direction}): E = ${modulus} MPa` +
        `${uts === undefined ? '' : `, UTS = ${uts} MPa`}; ${couponsOf(next, params.pattern, params.direction).length} coupon(s) of that pattern and direction.`,
      [params.id],
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant ordinary least squares of ln E = ln C + m ln density over the recorded coupons of the pattern and direction; exact for data that follow the law
 * @failure fewer than 2 coupons, or fewer than 2 distinct densities, of that pattern and direction -> FLL_PRINT_FIT_POINTS (rejected)
 */
export const fitPrintInfillExponent = defineCommand({
  name: 'fit_print_infill_exponent',
  annotations: { readOnly: true },
  description:
    'Fit the infill exponent m of E = C density^m (Gibson-Ashby form) to the coupons recorded with record_print_coupon for one infill pattern and one direction (xy or z), by least squares on ' +
    'ln E against ln density. Needs at least 2 coupons at distinct densities (refused otherwise). Returns data { pattern, direction, couponIds, m, C (modulus extrapolated to density 1, MPa), ' +
    'points, rmsLogResidual, maxRelativeResidual, rSquared, residuals[] { couponId, density, modulusMpa, fittedMpa }, warning }. Two points determine the fit exactly (residual 0): ' +
    'a residual says nothing then, record more densities. Pass the result to set_print_idealization with infillExponent { fitDirection } (it refits from the same coupons) or give m with its source. Read-only.',
  params: z.object({
    pattern: z.enum(PRINT_PATTERNS).describe('Infill pattern whose coupons are fitted.'),
    direction: z.enum(['xy', 'z']).describe('Coupon direction to fit: xy (in the build plane) or z (along the build direction).'),
  }),
  run: (doc, { pattern, direction }): CommandResult => {
    const fitted = fitCoupons(analysisOf(doc), pattern, direction);
    if (typeof fitted === 'string') return refuseFll(doc, 'fit_print_infill_exponent', 'FLL_PRINT_FIT_POINTS', fitted, [], ['pattern']);
    const { fit, couponIds } = fitted;
    const coupons = couponsOf(analysisOf(doc), pattern, direction);
    const exactFromTwo = fit.points === 2;
    return report(
      doc,
      `fit_print_infill_exponent: ${pattern} ${direction}: m = ${fit.m.toPrecision(6)}, C = ${fit.C.toPrecision(6)} MPa from ${fit.points} coupons (${couponIds.join(', ')}); rms ln residual ${fit.rmsLogResidual.toExponential(2)}, max relative residual ${fit.maxRelativeResidual.toExponential(2)}.`,
      {
        pattern,
        direction,
        couponIds,
        m: fit.m,
        C: fit.C,
        points: fit.points,
        rmsLogResidual: fit.rmsLogResidual,
        maxRelativeResidual: fit.maxRelativeResidual,
        rSquared: fit.rSquared,
        residuals: coupons.map((coupon) => ({
          couponId: coupon.id,
          density: coupon.infillDensity,
          modulusMpa: coupon.modulusMpa,
          fittedMpa: fit.C * coupon.infillDensity ** fit.m,
        })),
        warning: exactFromTwo ? 'two coupons fix m and C exactly: the zero residual is not evidence of the power law' : null,
      },
    );
  },
});
