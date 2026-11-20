/** Load-time checks of `dimensionStyles`, `activeDimensionStyleId` and every dimension's `styleId` (renderers read them unguarded). */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isHexColor } from '../../lib/isHexColor';
import { DECIMAL_SEPARATORS, DIMENSION_ARROW_STYLES, MAX_DIMENSION_AFFIX_LENGTH } from '../../model/dimensionStyle';
import { MAX_DISPLAY_PRECISION } from '../limits';

const ARROWS: ReadonlySet<unknown> = new Set(DIMENSION_ARROW_STYLES);
const SEPARATORS: ReadonlySet<unknown> = new Set(DECIMAL_SEPARATORS);

const positive = (value: unknown): boolean => isFiniteNumber(value) && value > 0;
const nonNegative = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
const decimals = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DISPLAY_PRECISION;
const affix = (value: unknown): boolean => typeof value === 'string' && value.length <= MAX_DIMENSION_AFFIX_LENGTH;

const FIELD_CHECKS: ReadonlyArray<readonly [string, (value: unknown) => boolean, string]> = [
  ['textHeight', positive, 'a finite number > 0'],
  ['arrowSize', positive, 'a finite number > 0'],
  ['arrowStyle', (value) => ARROWS.has(value), DIMENSION_ARROW_STYLES.join(' | ')],
  ['extensionGap', nonNegative, 'a finite number >= 0'],
  ['extensionBeyond', nonNegative, 'a finite number >= 0'],
  ['precision', decimals, `an integer 0..${MAX_DISPLAY_PRECISION}`],
  ['angularPrecision', decimals, `an integer 0..${MAX_DISPLAY_PRECISION}`],
  ['decimalSeparator', (value) => SEPARATORS.has(value), "'.' | ','"],
  ['prefix', affix, `a string of at most ${MAX_DIMENSION_AFFIX_LENGTH} characters`],
  ['suffix', affix, `a string of at most ${MAX_DIMENSION_AFFIX_LENGTH} characters`],
  ['color', (value) => typeof value === 'string' && isHexColor(value), 'a #rrggbb hex string'],
];

function styleProblems(id: string, style: unknown): string[] {
  if (!isRecord(style) || style['id'] !== id || typeof style['name'] !== 'string')
    return [`dimensionStyle '${id}': needs id (matching its key) and a string name`];
  return FIELD_CHECKS.filter(([key, valid]) => style[key] !== undefined && !valid(style[key])).map(
    ([key, , expected]) => `dimensionStyle '${id}': ${key} must be ${expected}`,
  );
}

/** Errors of the dimension-style slice of a raw document record. */
export function dimensionStyleProblems(doc: Record<string, unknown>): string[] {
  const styles = doc['dimensionStyles'];
  if (styles !== undefined && !isRecord(styles)) return ['dimensionStyles must be an object keyed by style id'];
  const known = isRecord(styles) ? styles : {};
  const errors = Object.entries(known).flatMap(([id, style]) => styleProblems(id, style));
  const active = doc['activeDimensionStyleId'];
  if (active !== undefined && !(typeof active === 'string' && Object.hasOwn(known, active)))
    errors.push(`activeDimensionStyleId '${String(active)}' does not name a dimension style`);
  const entities = doc['entities'];
  for (const [id, entity] of Object.entries(isRecord(entities) ? entities : {})) {
    if (!isRecord(entity) || entity['kind'] !== 'dimension' || entity['styleId'] === undefined) continue;
    const styleId = entity['styleId'];
    if (!(typeof styleId === 'string' && Object.hasOwn(known, styleId)))
      errors.push(`entity ${id}: styleId '${String(styleId)}' does not name a dimension style`);
  }
  return errors;
}
