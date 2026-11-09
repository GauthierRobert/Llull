/** Load validation of the 14 FLL-M3 printed-part data of a raw `analysis` slice (untrusted file data): `printed` of each case and the coupon bag. */

import { PRINT_PATTERNS } from '@core/model/printIdealization';
import { isRecord } from '@lib/isRecord';

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
/** Case types the printed idealization is written for (a linear elastic deck). */
export const PRINT_CASE_TYPES: readonly string[] = ['static', 'modal', 'buckling'];

const positive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;
const count = (value: unknown, minimum: number): boolean => typeof value === 'number' && Number.isInteger(value) && value >= minimum;
const density = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
const text = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

function sourceErrors(source: unknown, where: string): string[] {
  if (!isRecord(source) || !text(source['citation'])) return [`${where}.source.citation must be non-empty text`];
  return ['locator', 'url', 'accessed', 'note']
    .filter((key) => source[key] !== undefined && typeof source[key] !== 'string')
    .map((key) => `${where}.source.${key} must be text`);
}

function couponErrors(id: string, coupon: unknown): string[] {
  const where = `analysis.printCoupons.${id}`;
  if (!isRecord(coupon)) return [`${where}: must be a record`];
  return [
    ...(coupon['id'] === id ? [] : [`${where}.id must equal its key`]),
    ...(PRINT_PATTERNS.includes(coupon['pattern'] as never) ? [] : [`${where}.pattern must be one of ${PRINT_PATTERNS.join(', ')}`]),
    ...(density(coupon['infillDensity']) ? [] : [`${where}.infillDensity must be a number in (0, 1]`]),
    ...(coupon['direction'] === 'xy' || coupon['direction'] === 'z' ? [] : [`${where}.direction must be xy or z`]),
    ...(typeof coupon['skinFraction'] === 'number' && coupon['skinFraction'] >= 0 && coupon['skinFraction'] < 1
      ? []
      : [`${where}.skinFraction must be a number in [0, 1)`]),
    ...(positive(coupon['modulusMpa']) ? [] : [`${where}.modulusMpa must be a number > 0`]),
    ...(coupon['utsMpa'] === undefined || positive(coupon['utsMpa']) ? [] : [`${where}.utsMpa must be a number > 0`]),
    ...sourceErrors(coupon['source'], where),
  ];
}

function printErrorsOf(entityId: string, print: unknown, where: string): string[] {
  const at = `${where}.printed.${entityId}`;
  if (!isRecord(print)) return [`${at}: must be a record`];
  const errors: string[] = [];
  if (!count(print['walls'], 0)) errors.push(`${at}.walls must be an integer >= 0`);
  if (!positive(print['lineWidthMm'])) errors.push(`${at}.lineWidthMm must be a number > 0`);
  if (!positive(print['layerHeightMm'])) errors.push(`${at}.layerHeightMm must be a number > 0`);
  if (!count(print['topBottomLayers'], 0)) errors.push(`${at}.topBottomLayers must be an integer >= 0`);
  const infill = print['infill'];
  if (!isRecord(infill) || !PRINT_PATTERNS.includes(infill['pattern'] as never) || !density(infill['density']))
    errors.push(`${at}.infill must be { pattern: ${PRINT_PATTERNS.join(' | ')}, density in (0, 1] }`);
  const axis = print['layerAxis'];
  if (
    !Array.isArray(axis) ||
    axis.length !== 3 ||
    !axis.every((c) => typeof c === 'number' && Number.isFinite(c)) ||
    Math.abs(Math.hypot(...(axis as number[])) - 1) > 1e-9
  )
    errors.push(`${at}.layerAxis must be a unit vector of three finite numbers`);
  const coupon = print['coupon'];
  if (!isRecord(coupon) || !['E_xyMpa', 'E_zMpa', 'uts_xyMpa', 'uts_zMpa'].every((key) => positive(coupon[key])))
    errors.push(`${at}.coupon needs E_xyMpa, E_zMpa, uts_xyMpa and uts_zMpa as numbers > 0`);
  else errors.push(...sourceErrors(coupon['source'], `${at}.coupon`));
  const exponent = print['exponent'];
  if (!isRecord(exponent) || !positive(exponent['value']) || (exponent['basis'] !== 'given' && exponent['basis'] !== 'fit'))
    errors.push(`${at}.exponent needs value > 0 and basis given | fit`);
  else errors.push(...sourceErrors(exponent['source'], `${at}.exponent`));
  return errors;
}

/** Errors of the printed-part data of a raw document (persistence refuses the file when non-empty). */
export function printErrors(raw: Record<string, unknown>): string[] {
  const analysis = raw['analysis'];
  if (!isRecord(analysis)) return [];
  const errors: string[] = [];
  const coupons = analysis['printCoupons'];
  const order = analysis['printCouponOrder'];
  if (coupons !== undefined || order !== undefined) {
    if (!isRecord(coupons) || !Array.isArray(order) || !order.every((id) => typeof id === 'string'))
      errors.push('analysis.printCoupons: expected a record with a printCouponOrder list of ids');
    else {
      const keys = Object.keys(coupons);
      for (const id of keys) if (RESERVED.has(id)) errors.push(`analysis.printCoupons: reserved id '${id}'`);
      for (const id of new Set(order as string[]))
        if (!keys.includes(id)) errors.push(`analysis.printCouponOrder lists '${id}', which has no coupon`);
      if (new Set(order).size !== order.length) errors.push('analysis.printCouponOrder lists an id twice');
      for (const id of keys) {
        if (!order.includes(id)) errors.push(`analysis.printCoupons.${id} is missing from printCouponOrder`);
        errors.push(...couponErrors(id, coupons[id]));
      }
    }
  }
  const cases = analysis['cases'];
  if (!isRecord(cases)) return errors;
  for (const [caseId, analysisCase] of Object.entries(cases)) {
    if (!isRecord(analysisCase) || analysisCase['printed'] === undefined) continue;
    const where = `analysis case '${caseId}'`;
    const printed = analysisCase['printed'];
    if (!isRecord(printed)) {
      errors.push(`${where}: printed must be a record`);
      continue;
    }
    if (!PRINT_CASE_TYPES.includes(String(analysisCase['type'])))
      errors.push(`${where}: printed parts are for static, modal and buckling cases`);
    const parts = isRecord(analysisCase['parts']) ? analysisCase['parts'] : {};
    for (const [entityId, print] of Object.entries(printed)) {
      if (RESERVED.has(entityId)) errors.push(`${where}: printed has the reserved id '${entityId}'`);
      const part = Object.hasOwn(parts, entityId) ? parts[entityId] : undefined;
      if (!isRecord(part) || part['kind'] !== 'solid')
        errors.push(`${where}: printed names '${entityId}', which is not a solid part of the case`);
      errors.push(...printErrorsOf(entityId, print, where));
    }
  }
  return errors;
}
