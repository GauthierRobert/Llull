/** Load-time checks of the exchanger, tank and pump templates and of the supports (persistence boundary, see `validatePlant`). */

import { isFiniteNumber, isPositiveNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';

const SUPPORT_NUMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['skirt', ['height', 'thickness', 'baseRingWidth']],
  ['legs', ['count', 'height', 'pitchDiameter', 'legWidth']],
  ['saddles', ['width', 'axisElevation']],
  ['none', ['baseElevation']],
]);

export function supportErrors(support: unknown, at: string): string[] {
  if (!isRecord(support) || typeof support['type'] !== 'string' || !SUPPORT_NUMBERS.has(support['type']))
    return [`${at}.support.type must be skirt, legs, saddles or none`];
  const errors = (SUPPORT_NUMBERS.get(support['type']) as readonly string[])
    .filter((name) => !isFiniteNumber(support[name]) || (support[name] as number) < 0)
    .map((name) => `${at}.support.${name} must be a number >= 0`);
  if (support['type'] === 'saddles' && !(Array.isArray(support['stations']) && support['stations'].every(isFiniteNumber)))
    errors.push(`${at}.support.stations must be an array of numbers`);
  return errors;
}

const positive = (record: Record<string, unknown>, names: readonly string[], at: string): string[] =>
  names.filter((name) => !isPositiveNumber(record[name])).map((name) => `${at}.${name} must be a number > 0`);

const isString = (value: unknown): value is string => typeof value === 'string';
const oneOf = (value: unknown, allowed: readonly unknown[]): boolean => allowed.includes(value);

/** `defaulted`: the names of the defaults a command applied (read by the checks). */
const defaultedErrors = (template: Record<string, unknown>, at: string): string[] =>
  Array.isArray(template['defaulted']) && template['defaulted'].every(isString) ? [] : [`${at}.defaulted must be an array of strings`];

const quantityErrors = (value: unknown, units: readonly string[], at: string): string[] => {
  if (value === undefined) return [];
  if (!isRecord(value) || !isPositiveNumber(value['value']) || !oneOf(value['unit'], units))
    return [`${at} needs value > 0 and unit ${units.join(' | ')}`];
  return value['source'] === undefined || isString(value['source']) ? [] : [`${at}.source must be a string`];
};

/** Design data of one exchanger side (every field the checks and masses read). */
function sideErrors(side: unknown, at: string): string[] {
  if (side === undefined) return [];
  if (!isRecord(side)) return [`${at} must be an object`];
  const errors = [
    ...quantityErrors(side['pressure'], ['MPa', 'kPa', 'bar', 'psi'], `${at}.pressure`),
    ...quantityErrors(side['allowableStress'], ['MPa', 'psi'], `${at}.allowableStress`),
    ...quantityErrors(side['allowableStressAtTest'], ['MPa', 'psi'], `${at}.allowableStressAtTest`),
  ];
  if (side['temperatureC'] !== undefined && !isFiniteNumber(side['temperatureC'])) errors.push(`${at}.temperatureC must be a number`);
  if (side['material'] !== undefined && !isString(side['material'])) errors.push(`${at}.material must be a string`);
  if (side['specificGravity'] !== undefined && !isPositiveNumber(side['specificGravity']))
    errors.push(`${at}.specificGravity must be a number > 0`);
  const efficiency = side['jointEfficiency'];
  if (efficiency !== undefined) {
    const sound = (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value <= 1;
    if (!isRecord(efficiency) || !sound(efficiency['shell']) || !sound(efficiency['heads']))
      errors.push(`${at}.jointEfficiency needs shell and heads in (0, 1]`);
  }
  return errors;
}

function exchangerDesignErrors(design: unknown, at: string): string[] {
  if (design === undefined) return [];
  if (!isRecord(design)) return [`${at}.design must be an object`];
  const errors = [...sideErrors(design['shellSide'], `${at}.design.shellSide`), ...sideErrors(design['tubeSide'], `${at}.design.tubeSide`)];
  if (design['materialDensityKgM3'] !== undefined && !isPositiveNumber(design['materialDensityKgM3']))
    errors.push(`${at}.design.materialDensityKgM3 must be a number > 0`);
  return errors;
}

export function exchangerErrors(template: Record<string, unknown>, at: string): string[] {
  const errors = positive(template, ['shellInsideDiameter', 'shellThickness', 'tubesheetThickness'], at);
  if (typeof template['temaType'] !== 'string') errors.push(`${at}.temaType must be a string`);
  errors.push(...defaultedErrors(template, at), ...exchangerDesignErrors(template['design'], at));
  const tema = template['tema'];
  const fixed = isRecord(tema) && tema['fixedTubesheet'] === true;
  if (
    !isRecord(tema) ||
    typeof tema['fixedTubesheet'] !== 'boolean' ||
    typeof tema['removableBundle'] !== 'boolean' ||
    ![tema['front'], tema['shell'], tema['rear']].every((letter) => isString(letter) && /^[A-Z]$/.test(letter))
  )
    errors.push(`${at}.tema needs front, shell, rear (one letter each), fixedTubesheet and removableBundle`);
  if (!isFiniteNumber(template['corrosionAllowance']) || (template['corrosionAllowance'] as number) < 0)
    errors.push(`${at}.corrosionAllowance must be a number >= 0`);
  const tubes = template['tubes'];
  if (!isRecord(tubes)) errors.push(`${at}.tubes must be an object`);
  else {
    errors.push(...positive(tubes, ['outsideDiameter', 'wallThickness', 'count', 'length', 'pitch', 'passes'], `${at}.tubes`));
    if (!oneOf(tubes['layoutAngleDeg'], [30, 45, 60, 90])) errors.push(`${at}.tubes.layoutAngleDeg must be 30, 45, 60 or 90`);
    if (!isString(tubes['wallSource']) || typeof tubes['wallUnverified'] !== 'boolean')
      errors.push(`${at}.tubes needs wallSource (string) and wallUnverified (boolean)`);
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
  const errors = [...positive(template, ['diameter', 'shellHeight'], at), ...defaultedErrors(template, at)];
  if (!oneOf(template['thicknessSource'], ['user', 'one_foot', 'minimum']))
    errors.push(`${at}.thicknessSource must be user, one_foot or minimum`);
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
    !isString(design['material']) ||
    !isFiniteNumber(design['corrosionAllowance']) ||
    (design['corrosionAllowance'] as number) < 0
  )
    errors.push(`${at}.design needs specificGravity, designLiquidLevel, material and corrosionAllowance >= 0`);
  else {
    const stress = design['allowableStress'];
    if (
      stress !== undefined &&
      (!isRecord(stress) ||
        !isPositiveNumber(stress['design']) ||
        !isPositiveNumber(stress['test']) ||
        !(stress['source'] === undefined || isString(stress['source'])))
    )
      errors.push(`${at}.design.allowableStress needs design > 0, test > 0 and an optional source string`);
    if (design['materialDensityKgM3'] !== undefined && !isPositiveNumber(design['materialDensityKgM3']))
      errors.push(`${at}.design.materialDensityKgM3 must be a number > 0`);
  }
  return errors;
}

export function pumpErrors(template: Record<string, unknown>, at: string): string[] {
  const envelope = template['envelope'];
  const errors = isRecord(envelope)
    ? positive(envelope, ['a', 'f', 'h1', 'h2', 'suctionDn', 'dischargeDn'], `${at}.envelope`)
    : [`${at}.envelope must be an object`];
  errors.push(...defaultedErrors(template, at));
  if (isRecord(envelope)) {
    if (!isString(envelope['rating'])) errors.push(`${at}.envelope.rating must be a string`);
    if (!oneOf(envelope['grade'], ['A', 'B', 'C'])) errors.push(`${at}.envelope.grade must be A, B or C`);
    if (!isString(envelope['source'])) errors.push(`${at}.envelope.source must be a string`);
  }
  if (template['weightKg'] !== undefined && !isPositiveNumber(template['weightKg'])) errors.push(`${at}.weightKg must be a number > 0`);
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
