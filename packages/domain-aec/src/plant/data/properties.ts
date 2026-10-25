/**
 * Typed property values (plant 08 DAT §3): a definition is valid or not (`definitionProblem`), a value fits a definition or not (`coerceValue`).
 * Physical values are stored in the unit of their definition; a caller may send `{ value, unit }` and gets the converted number.
 * @invariant coerceValue never throws; the stored value equals the input for a value already in the property unit
 */

import { isFiniteNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { isPhysicalType, PROPERTY_TYPES, type PlantValue, type PropertyDefinition } from './model';
import { convertUnit, isKnownUnit, lowestValue, unitsOf } from './units';

export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Value as a caller sends it: a plain value, or a physical number with its unit. */
export type PlantValueInput = PlantValue | { readonly value: number; readonly unit: string };

export type Coerced =
  | { readonly ok: true; readonly value: PlantValue }
  | { readonly ok: false; readonly code: 'DAT_PROPERTY_TYPE' | 'DAT_PROPERTY_UNIT'; readonly message: string };

const fail = (code: 'DAT_PROPERTY_TYPE' | 'DAT_PROPERTY_UNIT', message: string): Coerced => ({ ok: false, code, message });

/** Anchored test of a property pattern; false for a pattern that is not a regular expression. */
export function matchesPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(text);
  } catch {
    return false;
  }
}

/** Why `definition` cannot be stored, or null. */
export function definitionProblem(definition: PropertyDefinition): string | null {
  const { name, type } = definition;
  if (!IDENTIFIER.test(name))
    return `property name "${name}" must be an identifier without spaces (letters, digits, _; starts with a letter)`;
  if (!(PROPERTY_TYPES as readonly string[]).includes(type)) return `${name}: unknown type "${type}"`;
  if (isPhysicalType(type)) {
    if (definition.unit === undefined) return `${name}: the physical type ${type} needs a unit (${unitsOf(type).join(', ')})`;
    if (!isKnownUnit(type, definition.unit))
      return `${name}: unit "${definition.unit}" is not a ${type} unit (${unitsOf(type).join(', ')})`;
  } else if (definition.unit !== undefined) return `${name}: the type ${type} has no unit`;
  if (type === 'enum' && (definition.enumValues === undefined || definition.enumValues.length === 0))
    return `${name}: an enum needs enumValues`;
  if (type !== 'enum' && definition.enumValues !== undefined) return `${name}: enumValues only belong to the type enum`;
  if (definition.pattern !== undefined) {
    if (type !== 'text') return `${name}: pattern only belongs to the type text`;
    try {
      new RegExp(`^(?:${definition.pattern})$`);
    } catch {
      return `${name}: pattern "${definition.pattern}" is not a regular expression`;
    }
  }
  if (definition.default !== undefined && definition.default !== null) {
    const check = coerceValue(definition, definition.default);
    if (!check.ok) return `${name}: default ${check.message}`;
  }
  return null;
}

/** Fits `input` to `definition`: the value to store, or the DAT_PROPERTY_* code and why not. `null` always fits (it clears the value). */
export function coerceValue(definition: PropertyDefinition, input: PlantValueInput): Coerced {
  const { name, type } = definition;
  if (input === null) return { ok: true, value: null };
  if (isRecord(input)) return coerceWithUnit(definition, input);
  switch (type) {
    case 'text':
      if (typeof input !== 'string') return fail('DAT_PROPERTY_TYPE', `${name} is text, got ${typeof input}`);
      if (definition.pattern !== undefined && !matchesPattern(definition.pattern, input))
        return fail('DAT_PROPERTY_TYPE', `${name} "${input}" does not match the pattern ${definition.pattern}`);
      return { ok: true, value: input };
    case 'boolean':
      return typeof input === 'boolean' ? { ok: true, value: input } : fail('DAT_PROPERTY_TYPE', `${name} is boolean, got ${typeof input}`);
    case 'enum':
      return typeof input === 'string' && (definition.enumValues ?? []).includes(input)
        ? { ok: true, value: input }
        : fail('DAT_PROPERTY_TYPE', `${name} must be one of ${(definition.enumValues ?? []).join(', ')}, got ${JSON.stringify(input)}`);
    case 'integer':
      return typeof input === 'number' && Number.isInteger(input)
        ? { ok: true, value: input }
        : fail('DAT_PROPERTY_TYPE', `${name} is an integer, got ${JSON.stringify(input)}`);
    default:
      return coercePhysical(definition, input);
  }
}

function coercePhysical(definition: PropertyDefinition, input: PlantValue): Coerced {
  const { name, type } = definition;
  if (!isFiniteNumber(input))
    return fail('DAT_PROPERTY_TYPE', `${name} is a number${definition.unit ? ` in ${definition.unit}` : ''}, got ${JSON.stringify(input)}`);
  const lowest = definition.unit === undefined ? null : lowestValue(type, definition.unit);
  if (lowest !== null && input < lowest - 1e-9)
    return fail('DAT_PROPERTY_TYPE', `${name} ${input} ${definition.unit} is below the lowest possible value ${lowest}`);
  return { ok: true, value: input };
}

function coerceWithUnit(definition: PropertyDefinition, input: Record<string, unknown>): Coerced {
  const { name, type } = definition;
  if (!isPhysicalType(type)) return fail('DAT_PROPERTY_TYPE', `${name} is ${type}: send a plain value, not { value, unit }`);
  const { value, unit } = input;
  if (!isFiniteNumber(value) || typeof unit !== 'string')
    return fail('DAT_PROPERTY_TYPE', `${name}: a value with a unit is { value: number, unit: string }`);
  const converted = convertUnit(type, value, unit, definition.unit as string);
  if (converted === null)
    return fail(
      'DAT_PROPERTY_UNIT',
      `${name}: unit "${unit}" does not convert to ${definition.unit} (${unitsOf(type).join(', ')}; gauge and absolute pressure never mix)`,
    );
  return coercePhysical(definition, converted);
}
