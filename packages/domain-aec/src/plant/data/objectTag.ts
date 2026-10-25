/**
 * Tags of plant objects (plant 08 DAT §5.2): where a format field takes its value (tag fields, properties, class code, hierarchy), the expected
 * tag of an object, matching a typed tag back to its fields, and the next free sequence number.
 * @invariant field order of precedence: tagFields, properties, classCode, hierarchy (`{area}` = unit.areaNumber, then area.areaNumber)
 */

import { concreteDescendants, resolvedOrNull, type ResolvedClass } from './classes';
import { ancestry } from './hierarchy';
import type { HierarchyKind, PlantDataModel, PlantObject, PlantValue } from './model';
import {
  buildMatcher,
  captureFields,
  escapeRegex,
  generateTag,
  hierarchyField,
  parseTagFormat,
  renderField,
  sequenceField,
  type FieldPart,
  type Generated,
  type TagPart,
} from './tagFormat';

export interface TagEnv {
  readonly data: PlantDataModel;
  readonly resolved: ResolvedClass;
  readonly hierarchyId: string;
  /** Tag fields over properties. */
  readonly values: Readonly<Record<string, PlantValue>>;
}

export function hierarchyValue(data: PlantDataModel, hierarchyId: string, kind: HierarchyKind, property: string): PlantValue | undefined {
  const node = [...ancestry(data, hierarchyId)].reverse().find((candidate) => candidate.kind === kind);
  if (node === undefined) return undefined;
  if (property === 'code') return node.code;
  if (property === 'name') return node.name;
  return node.properties[property];
}

export function fieldValue(env: TagEnv, name: string): PlantValue | undefined {
  const own = env.values[name];
  if (own !== undefined && own !== null) return own;
  if (name === 'classCode') return env.resolved.classCode;
  const qualified = hierarchyField(name);
  if (qualified !== null) return hierarchyValue(env.data, env.hierarchyId, qualified.kind, qualified.property);
  if (name === 'area')
    return (
      hierarchyValue(env.data, env.hierarchyId, 'unit', 'areaNumber') ?? hierarchyValue(env.data, env.hierarchyId, 'area', 'areaNumber')
    );
  return undefined;
}

export const envOf = (
  data: PlantDataModel,
  resolved: ResolvedClass,
  object: Pick<PlantObject, 'hierarchyId' | 'tagFields' | 'properties'>,
): TagEnv => ({ data, resolved, hierarchyId: object.hierarchyId, values: { ...object.properties, ...object.tagFields } });

/** Parts of the resolved format, or null when the class has none (or it does not parse: validated at definition). */
export function formatParts(resolved: ResolvedClass): readonly TagPart[] | null {
  if (resolved.tagFormat === undefined) return null;
  const parsed = parseTagFormat(resolved.tagFormat);
  return parsed.ok ? parsed.parts : null;
}

export const generateFor = (env: TagEnv, parts: readonly TagPart[]): Generated => generateTag(parts, (name) => fieldValue(env, name));

/** The tag `object` must carry: generated from its class format, or its stored tag when the class has no format; a failure names the code. */
export function expectedTag(data: PlantDataModel, object: PlantObject): Generated {
  const resolved = resolvedOrNull(data, object.className);
  if (resolved === null) return { ok: false, code: 'DAT_TAG_FORMAT', message: `class "${object.className}" does not resolve`, field: '' };
  const parts = formatParts(resolved);
  if (parts === null) return { ok: true, tag: object.tag };
  return generateFor(envOf(data, resolved, object), parts);
}

function freeSource(env: TagEnv, part: FieldPart, next: string | undefined): string {
  if (part.width !== undefined) return `[0-9]{${part.width}}`;
  const definition = env.resolved.properties.find((candidate) => candidate.name === part.name);
  if (definition?.type === 'enum') return (definition.enumValues ?? []).map(escapeRegex).join('|');
  if (definition?.pattern !== undefined) return `(?:${definition.pattern})`;
  if (definition?.type === 'integer') return '[0-9]+';
  if (part.name === 'classCode') {
    const codes = [
      ...new Set(concreteDescendants(env.data, env.resolved.name).flatMap((cls) => resolvedOrNull(env.data, cls.name)?.classCode ?? [])),
    ];
    return codes.length > 0 ? codes.map(escapeRegex).join('|') : '[A-Za-z0-9]+';
  }
  return next === undefined ? '.+' : '.+?';
}

function matcherSource(env: TagEnv, part: FieldPart, next: string | undefined): string {
  const value = fieldValue(env, part.name);
  const fixed = value === undefined ? null : renderField(part, value);
  return fixed === null ? freeSource(env, part, next) : escapeRegex(fixed);
}

export type Matched =
  | { readonly ok: true; readonly fields: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string };

/**
 * Does `tag` have the shape of the class format, given what is already known (class code, hierarchy, the values in `env`)? Fields that are not
 * known are read from the tag: a padded integer by its width, an enum / pattern / integer property by its definition, other text up to the next literal.
 */
export function matchTag(env: TagEnv, tag: string): Matched {
  const parts = formatParts(env.resolved);
  if (parts === null) return { ok: true, fields: {} };
  const captured = captureFields(
    buildMatcher(parts, (part, next) => matcherSource(env, part, next)),
    tag,
  );
  return captured === null
    ? { ok: false, message: `"${tag}" does not match the format ${env.resolved.tagFormat} of ${env.resolved.name}` }
    : { ok: true, fields: captured };
}

export type NextSequence =
  | { readonly ok: true; readonly sequence: number; readonly field: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The number after the highest sequence among `existing` tags that share every other field of the tag being made (max + 1, never reusing gaps). */
export function nextSequence(env: TagEnv, existing: Iterable<string>): NextSequence {
  const parts = formatParts(env.resolved);
  const counter = parts === null ? undefined : sequenceField(parts);
  if (parts === null || counter === undefined)
    return {
      ok: false,
      code: 'DAT_TAG_FORMAT',
      message: `the format of ${env.resolved.name} has no sequence field ({seq} or a padded integer): give the tag`,
    };
  const probe = generateTag(parts, (name) => (name === counter.name ? 1 : fieldValue(env, name)));
  if (!probe.ok) return { ok: false, code: probe.code, message: probe.message };
  const matcher = buildMatcher(parts, (part) =>
    part.name === counter.name
      ? part.width === undefined
        ? '[0-9]+'
        : `[0-9]{${part.width}}`
      : escapeRegex(renderField(part, fieldValue(env, part.name) as PlantValue) ?? ''),
  );
  let highest = 0;
  for (const tag of existing) {
    const fields = captureFields(matcher, tag);
    if (fields !== null) highest = Math.max(highest, Number(fields[counter.name]));
  }
  const sequence = highest + 1;
  if (counter.width !== undefined && String(sequence).length > counter.width)
    return {
      ok: false,
      code: 'DAT_TAG_FORMAT',
      message: `{${counter.name}:${counter.width}} is full (${highest} is the highest): widen the format`,
    };
  return { ok: true, sequence, field: counter.name };
}
