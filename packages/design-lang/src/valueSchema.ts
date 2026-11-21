/**
 * A `.lld` value bound to the zod JSON schema of the param it is written for, element by element: the plain JSON the command receives, or
 * an error with the path (`sections[3].span`).
 * @invariant alias references become ids: one id for a single alias, the whole list for a group on a list slot; objects may not carry
 *   fields the schema does not list (unless it is a free-form record), and must carry its required ones
 * @failure wrong type / enum member / unknown or missing field -> DESIGN_VALUE_SCHEMA with the path; a group alias in a one-id slot -> DESIGN_ALIAS_ARITY
 */

import type { ParamItemSpec } from '@core/commands/types';
import { DesignError } from './errors';
import { MAX_EVAL_STEPS, RefValue, type Value } from './valueEval';

interface Site {
  readonly param: string;
  readonly line: number;
  /** Elements still allowed in this coercion (a list shared by many places is copied into each). */
  budget: number;
}

function spend(site: Site, count: number): void {
  site.budget -= count;
  if (site.budget < 0)
    throw new DesignError(
      'DESIGN_EVAL_LIMIT',
      site.line,
      `${site.param} expands to more than ${MAX_EVAL_STEPS} elements`,
      'A value that repeats a long list is too large: share it by alias or shorten it.',
    );
}

const kind = (value: Value): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'a list'
      : value instanceof RefValue
        ? 'an alias'
        : typeof value === 'object'
          ? 'an object'
          : `a ${typeof value}`;

function mismatch(site: Site, path: string, expected: string, value: Value): DesignError {
  return new DesignError(
    'DESIGN_VALUE_SCHEMA',
    site.line,
    `${site.param}${path}: expected ${expected}, got ${kind(value)}${typeof value === 'string' ? ` "${value}"` : typeof value === 'number' ? ` ${value}` : ''}`,
    `See \`llull describe\` for the shape of ${site.param}.`,
  );
}

function isUntyped(spec: ParamItemSpec): boolean {
  return spec.type === undefined && spec.anyOf === undefined && spec.enum === undefined;
}

function fromRef(ref: RefValue, spec: ParamItemSpec, site: Site, path: string): unknown {
  spend(site, ref.ids.length);
  if (spec.type === 'array') return [...ref.ids];
  if (spec.type === 'string' && spec.enum === undefined) {
    if (ref.group)
      throw new DesignError(
        'DESIGN_ALIAS_ARITY',
        site.line,
        `${site.param}${path} expects one id, got a group of ${ref.ids.length}`,
        'Pick one with alias[0], alias[i] or alias[-1].',
      );
    return ref.ids[0];
  }
  if (isUntyped(spec)) return ref.group ? [...ref.ids] : ref.ids[0];
  throw mismatch(site, path, spec.type ?? 'a value of another type', ref);
}

function fromObject(value: { readonly [key: string]: Value }, spec: ParamItemSpec, site: Site, path: string): unknown {
  const properties = spec.properties ?? {};
  const closed = Object.keys(properties).length > 0 && spec.additionalProperties === undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const child = properties[key] ?? spec.additionalProperties ?? (closed ? undefined : {});
    if (child === undefined)
      throw new DesignError(
        'DESIGN_VALUE_SCHEMA',
        site.line,
        `${site.param}${path}.${key}: no such field`,
        `Fields: ${Object.keys(properties).join(', ')}.`,
      );
    out[key] = coerce(item, child, site, `${path}.${key}`);
  }
  for (const key of spec.required ?? [])
    if (!Object.hasOwn(value, key))
      throw new DesignError(
        'DESIGN_VALUE_SCHEMA',
        site.line,
        `${site.param}${path}.${key}: required field is missing`,
        `Add ${key}: <value>.`,
      );
  return out;
}

function coerce(value: Value, spec: ParamItemSpec, site: Site, path: string): unknown {
  spend(site, 1);
  if (spec.anyOf !== undefined) {
    let first: DesignError | null = null;
    for (const branch of spec.anyOf) {
      try {
        return coerce(value, branch, site, path);
      } catch (error) {
        if (!(error instanceof DesignError)) throw error;
        first ??= error;
      }
    }
    throw first ?? mismatch(site, path, 'one of the alternatives', value);
  }
  if (value instanceof RefValue) return fromRef(value, spec, site, path);
  if (spec.enum !== undefined) {
    if ((typeof value === 'string' || typeof value === 'number') && spec.enum.includes(value)) return value;
    throw mismatch(site, path, `one of ${spec.enum.join(', ')}`, value);
  }
  switch (spec.type) {
    case 'number':
    case 'integer':
      if (typeof value === 'number' && (spec.type === 'number' || Number.isInteger(value))) return value;
      throw mismatch(site, path, spec.type, value);
    case 'string':
    case 'boolean':
      if (typeof value === spec.type) return value;
      throw mismatch(site, path, spec.type, value);
    case 'array':
      if (!Array.isArray(value)) throw mismatch(site, path, 'a list', value);
      return (value as readonly Value[]).map((item, k) => coerce(item, spec.items ?? {}, site, `${path}[${k}]`));
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw mismatch(site, path, 'an object', value);
      return fromObject(value as { readonly [key: string]: Value }, spec, site, path);
    default:
      return untyped(value, site, path);
  }
}

function untyped(value: Value, site: Site, path: string): unknown {
  spend(site, 1);
  if (Array.isArray(value)) return (value as readonly Value[]).map((item, k) => untyped(item, site, `${path}[${k}]`));
  if (value instanceof RefValue) return value.group ? [...value.ids] : value.ids[0];
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as { readonly [key: string]: Value }).map(([k, v]) => [k, untyped(v, site, `${path}.${k}`)]),
    );
  return value;
}

/** `value` as the JSON the param `param` (named in errors) takes under `spec`. */
export function coerceValue(value: Value, spec: ParamItemSpec, param: string, line: number): unknown {
  return coerce(value, spec, { param, line, budget: MAX_EVAL_STEPS }, '');
}
