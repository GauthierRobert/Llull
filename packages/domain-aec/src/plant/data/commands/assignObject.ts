/**
 * The logic of `assign_plant_object` (plant 08 DAT §4, §5.2, §5.3): class, hierarchy and target resolution, typed properties with model seeds,
 * the tag (generated from the fields, typed and parsed back, or the next free sequence), uniqueness in the scope, write-back into the model.
 */

import { nextId } from '@lib/id';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { concreteDescendants, resolveClass, type ResolvedClass } from '../classes';
import { resolveNode, scopeKey } from '../hierarchy';
import { isProcessLine } from '../lines';
import {
  getPlantData,
  withPlantData,
  type PlantDataModel,
  type PlantObject,
  type PlantObjectTarget,
  type PlantValue,
  type PropertyDefinition,
  type ValueProvenance,
} from '../model';
import { envOf, fieldValue, formatParts, generateFor, matchTag, nextSequence, type TagEnv } from '../objectTag';
import { coerceValue, type PlantValueInput } from '../properties';
import { allProviders, foreignTagHolders, resolveTarget, targetKey, type PlantObjectProvider, type ProviderElement } from '../providers';
import { holdersOf, idsWithTag, objectRegistry, tagsInScope } from '../registry';
import { fieldNames, normaliseTag, sequenceField, type TagPart } from '../tagFormat';
import { failure, type Outcome } from './params';

export interface AssignInput {
  readonly target: string | { readonly provider: string; readonly id: string };
  readonly className: string;
  readonly hierarchy: string;
  readonly tagFields?: Readonly<Record<string, PlantValue>> | undefined;
  readonly tag?: string | undefined;
  readonly nextSequence?: boolean | undefined;
  readonly properties?: Readonly<Record<string, PlantValueInput>> | undefined;
  readonly provenance?: Readonly<Record<string, ValueProvenance>> | undefined;
  readonly line?: string | undefined;
}

export interface Assigned {
  readonly document: CadDocument;
  readonly object: PlantObject;
  readonly scope: string;
  readonly seeded: readonly string[];
  readonly tagWritten: boolean;
  readonly affected: readonly string[];
}

const definitionOf = (resolved: ResolvedClass, name: string): PropertyDefinition | undefined =>
  resolved.properties.find((candidate) => candidate.name === name);

/** The process line object `reference` (id or tag) names, or a refusal. */
export function lineObjectOf(data: PlantDataModel, reference: string): Outcome<{ readonly line: PlantObject }> {
  const byId = data.objects[reference];
  const candidates = byId === undefined ? idsWithTag(objectRegistry(data), reference).flatMap((id) => data.objects[id] ?? []) : [byId];
  const lines = candidates.filter((object) => isProcessLine(data, object));
  if (lines.length === 1) return { ok: true, line: lines[0] as PlantObject };
  return failure(
    'DAT_OBJECT_UNKNOWN',
    lines.length === 0
      ? `no process line object "${reference}"`
      : `"${reference}" names ${lines.length} line objects (${lines.map((line) => line.id).join(', ')}): pass the id`,
    ['line'],
    lines.map((line) => line.id),
  );
}

interface Values {
  readonly properties: Record<string, PlantValue>;
  readonly tagFields: Record<string, PlantValue>;
  readonly provenance: Record<string, ValueProvenance>;
  readonly seeded: string[];
}

/** Typed properties and tag fields from the caller, with the model object's facts as defaults for what the class or format knows. */
function collectValues(
  input: AssignInput,
  resolved: ResolvedClass,
  parts: readonly TagPart[] | null,
  seeds: Readonly<Record<string, PlantValueInput>>,
  seedRef: string,
): Outcome<{ readonly values: Values }> {
  const values: Values = { properties: {}, tagFields: {}, provenance: {}, seeded: [] };
  const formatFields = parts === null ? [] : fieldNames(parts);
  const given = new Set<string>();
  const store = (name: string, value: PlantValueInput, path: string): Outcome<never> | null => {
    const definition = definitionOf(resolved, name);
    if (definition === undefined) return failure('DAT_PROPERTY_UNKNOWN', `${resolved.name} has no property "${name}"`, [path]);
    if (definition.readOnly === true) return failure('DAT_PROPERTY_READONLY', `${name} is read-only`, [path]);
    const coerced = coerceValue(definition, value);
    if (!coerced.ok) return failure(coerced.code, coerced.message, [path]);
    values.properties[name] = coerced.value;
    return null;
  };
  for (const [name, value] of Object.entries(input.properties ?? {})) {
    const refused = store(name, value, `properties.${name}`);
    if (refused !== null) return refused;
    given.add(name);
  }
  for (const [name, value] of Object.entries(input.tagFields ?? {})) {
    if (given.has(name)) continue;
    if (definitionOf(resolved, name) === undefined) values.tagFields[name] = value;
    else {
      const refused = store(name, value, `tagFields.${name}`);
      if (refused !== null) return refused;
    }
    given.add(name);
  }
  for (const [name, value] of Object.entries(seeds)) {
    if (given.has(name) || (input.tag !== undefined && formatFields.includes(name))) continue;
    if (definitionOf(resolved, name) !== undefined) {
      if (store(name, value, name) !== null) continue;
    } else if (formatFields.includes(name) && typeof value !== 'object') values.tagFields[name] = value;
    else continue;
    values.seeded.push(name);
    values.provenance[name] = { source: 'default', ref: seedRef };
  }
  for (const [name, provenance] of Object.entries(input.provenance ?? {})) {
    if (definitionOf(resolved, name) === undefined)
      return failure('DAT_PROPERTY_UNKNOWN', `provenance names "${name}", which ${resolved.name} does not define`, [`provenance.${name}`]);
    values.provenance[name] = provenance;
  }
  return { ok: true, values };
}

/** Tags a new tag must differ from in `scope`: the objects' and the unique tag fields of model objects no plant object stands for. */
function tagsInUse(doc: CadDocument, data: PlantDataModel, scope: string): string[] {
  const claimed = new Set(Object.values(data.objects).flatMap((object) => targetKey(object.target) ?? []));
  const model = allProviders().flatMap((provider) =>
    provider
      .elements(doc)
      .flatMap((element) =>
        element.tagUnique && element.tag !== undefined && !claimed.has(`${provider.id}:${element.id}`) ? [normaliseTag(element.tag)] : [],
      ),
  );
  return [...tagsInScope(objectRegistry(data), scope), ...model];
}

/** The tag and the fields it added to the caller's: a field of the class is a property, any other a tag field. */
interface Tagged {
  readonly tag: string;
  readonly added: Readonly<Record<string, PlantValue>>;
}

/** The value a text captured from a typed tag stands for. */
function capturedValue(definition: PropertyDefinition | undefined, parts: readonly TagPart[], name: string, text: string): PlantValue {
  if (definition === undefined)
    return parts.some((part) => part.kind === 'field' && part.name === name && part.width !== undefined) ? Number(text) : text;
  if (definition.type === 'text' || definition.type === 'enum') return text;
  return definition.type === 'boolean' ? text === 'true' : Number(text);
}

function typedTag(env: TagEnv, parts: readonly TagPart[], explicit: string): Outcome<{ readonly tagged: Tagged }> {
  const matched = matchTag(env, explicit);
  if (!matched.ok) return failure('DAT_TAG_FORMAT', matched.message, ['tag']);
  const added: Record<string, PlantValue> = {};
  for (const [name, text] of Object.entries(matched.fields)) {
    if (fieldValue(env, name) !== undefined) continue;
    const definition = definitionOf(env.resolved, name);
    const value = capturedValue(definition, parts, name, text);
    const coerced = definition === undefined ? { ok: true as const, value } : coerceValue(definition, value);
    if (!coerced.ok) return failure('DAT_TAG_FORMAT', `"${explicit}": ${coerced.message}`, ['tag']);
    added[name] = coerced.value;
  }
  const again = generateFor({ ...env, values: { ...env.values, ...added } }, parts);
  if (!again.ok || again.tag !== explicit)
    return failure('DAT_TAG_FORMAT', `"${explicit}" is not the canonical form of its fields (${again.ok ? again.tag : again.message})`, [
      'tag',
    ]);
  return { ok: true, tagged: { tag: explicit, added } };
}

function resolveTag(
  doc: CadDocument,
  data: PlantDataModel,
  input: AssignInput,
  parts: readonly TagPart[] | null,
  env: TagEnv,
  scope: string,
  explicit: string | undefined,
): Outcome<{ readonly tagged: Tagged }> {
  if (parts === null) {
    if (explicit === undefined) return failure('DAT_TAG_FORMAT', `class ${env.resolved.name} has no tag format: pass tag`, ['tag']);
    return { ok: true, tagged: { tag: explicit, added: {} } };
  }
  if (explicit !== undefined) return typedTag(env, parts, explicit);
  const added: Record<string, PlantValue> = {};
  if (input.nextSequence === true) {
    const counter = sequenceField(parts);
    if (counter !== undefined && env.values[counter.name] !== undefined)
      return failure('DAT_PARAM_INVALID', `nextSequence: true and ${counter.name} both given: send one`, ['nextSequence']);
    const next = nextSequence(env, tagsInUse(doc, data, scope));
    if (!next.ok) return failure(next.code, next.message, ['nextSequence']);
    added[next.field] = next.sequence;
  }
  const generated = generateFor({ ...env, values: { ...env.values, ...added } }, parts);
  if (!generated.ok) return failure(generated.code, generated.message, [`tagFields.${generated.field}`]);
  return { ok: true, tagged: { tag: generated.tag, added } };
}

/** The tag a new object with these fields would get at the next free sequence number, or undefined (no sequence in the format). */
function freeTagNear(
  doc: CadDocument,
  data: PlantDataModel,
  env: TagEnv,
  parts: readonly TagPart[] | null,
  scope: string,
): string | undefined {
  const next = parts === null ? null : nextSequence(env, tagsInUse(doc, data, scope));
  if (parts === null || next === null || !next.ok) return undefined;
  const generated = generateFor({ ...env, values: { ...env.values, [next.field]: next.sequence } }, parts);
  return generated.ok ? generated.tag : undefined;
}

export function assignObject(
  doc: CadDocument,
  input: AssignInput,
  ctx: ExecutionContext | undefined,
): Outcome<{ readonly assigned: Assigned }> {
  const data = getPlantData(doc);
  const resolution = resolveClass(data, input.className);
  if (!resolution.ok) return failure(resolution.code, resolution.message, ['className']);
  const resolved = resolution.resolved;
  if (resolved.abstract)
    return failure('DAT_CLASS_ABSTRACT', `class ${resolved.name} is abstract`, ['className'], [], {
      concreteSubclasses: concreteDescendants(data, resolved.name).map((cls) => cls.name),
    });
  const node = resolveNode(data, input.hierarchy);
  if (node === null || node === 'ambiguous')
    return failure(
      'DAT_HIERARCHY_UNKNOWN',
      node === null
        ? `no hierarchy node "${input.hierarchy}"`
        : `the code "${input.hierarchy}" names several nodes: pass the path (S1/P1/U10)`,
      ['hierarchy'],
    );
  let target: PlantObjectTarget = { kind: 'reserved' };
  let provider: PlantObjectProvider | undefined;
  let element: ProviderElement | undefined;
  if (input.target !== 'reserved') {
    const found = resolveTarget(doc, input.target);
    if (!found.ok) return failure('DAT_TARGET_UNKNOWN', found.message, ['target']);
    ({ target, provider, element } = found);
    const key = targetKey(target);
    const twin = Object.values(data.objects).find((object) => targetKey(object.target) === key);
    if (twin !== undefined)
      return failure('DAT_TARGET_ALREADY_TAGGED', `${element.label} already is ${twin.tag} (${twin.id})`, ['target'], [twin.id]);
  }
  let lineId: string | undefined;
  if (input.line !== undefined) {
    const found = lineObjectOf(data, input.line);
    if (!found.ok) return found;
    lineId = found.line.id;
  }
  const parts = formatParts(resolved);
  const seeds = provider !== undefined && element !== undefined ? (provider.seeds?.(doc, element.id) ?? {}) : {};
  const collected = collectValues(input, resolved, parts, seeds, `model:${provider?.id ?? ''}:${element?.id ?? ''}`);
  if (!collected.ok) return collected;
  const { values } = collected;
  const scope = scopeKey(data, node.id, resolved.tagScope);
  let explicit = input.tag === undefined ? undefined : normaliseTag(input.tag);
  if (explicit === '') return failure('DAT_TAG_FORMAT', 'tag is empty', ['tag']);
  if (provider !== undefined && element !== undefined && provider.writeTags === undefined) {
    if (explicit !== undefined && element.tag !== explicit)
      return failure(
        'DAT_TARGET_TAG_READONLY',
        `${element.label} carries the tag ${element.tag ?? '(none)'} and its provider cannot rename it`,
        ['tag'],
      );
    if (explicit === undefined && element.tag === undefined)
      return failure('DAT_TARGET_TAG_READONLY', `${element.label} has no tag to adopt and its provider cannot rename it`, ['target']);
    explicit ??= element.tag === undefined ? undefined : normaliseTag(element.tag);
  }
  const env = envOf(data, resolved, { hierarchyId: node.id, tagFields: values.tagFields, properties: values.properties });
  const tagged = resolveTag(doc, data, input, parts, env, scope, explicit);
  if (!tagged.ok) return tagged;
  const { tag, added } = tagged.tagged;
  const withAdded: TagEnv = { ...env, values: { ...env.values, ...added } };
  const holders = holdersOf(objectRegistry(data), scope, tag);
  const modelHolders = foreignTagHolders(doc, tag).filter(
    (holder) => !(element !== undefined && holder.element.id === element.id && holder.provider === provider?.id),
  );
  if (holders.length > 0 || modelHolders.length > 0) {
    const free = freeTagNear(doc, data, withAdded, parts, scope);
    const ids = [...holders, ...modelHolders.map((holder) => holder.element.id)];
    return failure(
      'DAT_TAG_DUPLICATE',
      `tag ${tag} is already held by ${ids.join(', ')}${free === undefined ? '' : `; the next free tag is ${free}`}`,
      ['tag'],
      ids,
      free === undefined ? undefined : { nextFreeTag: free },
    );
  }
  const id = nextId('plantobj');
  const properties: Record<string, PlantValue> = { ...values.properties };
  const tagFields: Record<string, PlantValue> = { ...values.tagFields };
  for (const [name, value] of Object.entries(added)) (definitionOf(resolved, name) === undefined ? tagFields : properties)[name] = value;
  const object: PlantObject = {
    id,
    className: resolved.name,
    hierarchyId: node.id,
    target,
    tagFields,
    tag,
    properties,
    ...(Object.keys(values.provenance).length === 0 ? {} : { provenance: values.provenance }),
    ...(lineId === undefined ? {} : { lineId }),
  };
  const next = withPlantData(doc, { ...data, objects: { ...data.objects, [id]: object }, objectOrder: [...data.objectOrder, id] });
  if (provider?.writeTags === undefined || element === undefined || element.tag === tag)
    return { ok: true, assigned: { document: next, object, scope, seeded: values.seeded, tagWritten: false, affected: [id] } };
  const written = provider.writeTags(next, [{ id: element.id, tag }], ctx);
  if (typeof written === 'string') return failure('DAT_TARGET_TAG_READONLY', `${element.label}: ${written}`, ['target']);
  return { ok: true, assigned: { document: written, object, scope, seeded: values.seeded, tagWritten: true, affected: [id, element.id] } };
}
