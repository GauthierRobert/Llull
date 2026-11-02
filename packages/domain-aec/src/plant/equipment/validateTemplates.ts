/** Load-time checks of the exchanger, tank and pump templates and of the supports (persistence boundary, see `validatePlant`). */

import { isFiniteNumber, isPositiveNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';

const SUPPORT_NUMBERS: Readonly<Record<string, readonly string[]>> = {
  skirt: ['height', 'thickness', 'baseRingWidth'],
  legs: ['count', 'height', 'pitchDiameter', 'legWidth'],
  saddles: ['width', 'axisElevation'],
  none: ['baseElevation'],
};

export function supportErrors(support: unknown, at: string): string[] {
  if (!isRecord(support) || typeof support['type'] !== 'string' || SUPPORT_NUMBERS[support['type']] === undefined)
    return [`${at}.support.type must be skirt, legs, saddles or none`];
  const errors = (SUPPORT_NUMBERS[support['type']] as readonly string[])
    .filter((name) => !isFiniteNumber(support[name]) || (support[name] as number) < 0)
    .map((name) => `${at}.support.${name} must be a number >= 0`);
  if (support['type'] === 'saddles' && !(Array.isArray(support['stations']) && support['stations'].every(isFiniteNumber)))
    errors.push(`${at}.support.stations must be an array of numbers`);
  return errors;
}

const positive = (record: Record<string, unknown>, names: readonly string[], at: string): string[] =>
  names.filter((name) => !isPositiveNumber(record[name])).map((name) => `${at}.${name} must be a number > 0`);

export function exchangerErrors(template: Record<string, unknown>, at: string): string[] {
  const errors = positive(template, ['shellInsideDiameter', 'shellThickness', 'tubesheetThickness'], at);
  if (typeof template['temaType'] !== 'string') errors.push(`${at}.temaType must be a string`);
  const tema = template['tema'];
  const fixed = isRecord(tema) && tema['fixedTubesheet'] === true;
  if (!isRecord(tema) || typeof tema['fixedTubesheet'] !== 'boolean') errors.push(`${at}.tema must carry fixedTubesheet`);
  if (!isFiniteNumber(template['corrosionAllowance']) || (template['corrosionAllowance'] as number) < 0)
    errors.push(`${at}.corrosionAllowance must be a number >= 0`);
  const tubes = template['tubes'];
  if (!isRecord(tubes)) errors.push(`${at}.tubes must be an object`);
  else {
    errors.push(...positive(tubes, ['outsideDiameter', 'wallThickness', 'count', 'length', 'pitch', 'passes'], `${at}.tubes`));
    if (
      isPositiveNumber(tubes['outsideDiameter']) &&
      isPositiveNumber(tubes['wallThickness']) &&
      2 * tubes['wallThickness'] >= tubes['outsideDiameter']
    )
      errors.push(`${at}.tubes.wallThickness leaves no bore`);
    if (
      isPositiveNumber(tubes['length']) &&
      isPositiveNumber(template['tubesheetThickness']) &&
      tubes['length'] - (fixed ? 2 : 1) * template['tubesheetThickness'] <= 0
    )
      errors.push(`${at}.tubes.length leaves no shell between the tubesheets`);
  }
  for (const [name, required] of [
    ['frontChannel', true],
    ['rearChannel', fixed],
  ] as const) {
    const channel = template[name];
    if (channel === undefined && !required) continue;
    if (!isRecord(channel)) errors.push(`${at}.${name} must be an object${required ? '' : ' or absent'}`);
    else errors.push(...positive(channel, ['length', 'thickness'], `${at}.${name}`));
  }
  const support = template['support'];
  if (isRecord(support) && support['type'] !== 'saddles' && support['type'] !== 'none')
    errors.push(`${at}.support.type must be saddles or none`);
  return [...errors, ...supportErrors(support, at)];
}

export function tankErrors(template: Record<string, unknown>, at: string): string[] {
  const errors = positive(template, ['diameter', 'shellHeight'], at);
  const { courses, courseThicknesses } = template;
  const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.every(isPositiveNumber);
  if (!numbers(courses)) errors.push(`${at}.courses must be a non-empty array of numbers > 0`);
  else if (
    isPositiveNumber(template['shellHeight']) &&
    Math.abs(courses.reduce((sum, height) => sum + height, 0) - template['shellHeight']) > 1e-6 * template['shellHeight']
  )
    errors.push(`${at}.courses must add up to shellHeight`);
  if (!numbers(courseThicknesses) || (numbers(courses) && courseThicknesses.length !== courses.length))
    errors.push(`${at}.courseThicknesses must hold one number > 0 per course`);
  const roof = template['roof'];
  if (!isRecord(roof) || !['cone', 'dome', 'flat'].includes(roof['type'] as string) || !isPositiveNumber(roof['thickness']))
    errors.push(`${at}.roof needs type cone, dome or flat and a thickness > 0`);
  else if ((roof['type'] === 'cone' && !isPositiveNumber(roof['slope'])) || (roof['type'] === 'dome' && !isPositiveNumber(roof['radius'])))
    errors.push(`${at}.roof: a cone needs slope > 0, a dome radius > 0`);
  const bottom = template['bottom'];
  if (!isRecord(bottom) || !isPositiveNumber(bottom['thickness'])) errors.push(`${at}.bottom.thickness must be a number > 0`);
  const design = template['design'];
  if (
    !isRecord(design) ||
    !isPositiveNumber(design['specificGravity']) ||
    !isPositiveNumber(design['designLiquidLevel']) ||
    typeof design['material'] !== 'string'
  )
    errors.push(`${at}.design needs specificGravity, designLiquidLevel and material`);
  return errors;
}

export function pumpErrors(template: Record<string, unknown>, at: string): string[] {
  const envelope = template['envelope'];
  const errors = isRecord(envelope)
    ? positive(envelope, ['a', 'f', 'h1', 'h2', 'suctionDn', 'dischargeDn'], `${at}.envelope`)
    : [`${at}.envelope must be an object`];
  const baseplate = template['baseplate'];
  errors.push(
    ...(isRecord(baseplate)
      ? positive(baseplate, ['length', 'width', 'height'], `${at}.baseplate`)
      : [`${at}.baseplate must be an object`]),
  );
  const driver = template['driver'];
  if (driver !== undefined && isRecord(driver) && !(isFiniteNumber(driver['gap']) && (driver['gap'] as number) >= 0))
    errors.push(`${at}.driver.gap must be a number >= 0`);
  if (driver !== undefined)
    errors.push(
      ...(isRecord(driver) ? positive(driver, ['length', 'width', 'height'], `${at}.driver`) : [`${at}.driver must be an object`]),
    );
  return errors;
}
