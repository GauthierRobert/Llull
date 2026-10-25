/**
 * Class resolution (plant 08 DAT §5.1, TR-DAT-03): the chain from the root, the merged property definitions (a subclass may tighten an inherited
 * property, never change its type or unit), the inherited tag format, class code, scope and IFC mapping. Results are memoised per classes record.
 * @invariant a cycle or an unknown parent is reported, never followed
 */

import { definitionProblem } from './properties';
import type { IfcMapping, PlantClass, PlantDataModel, PropertyDefinition, TagScope } from './model';

export interface ResolvedClass {
  readonly name: string;
  /** Own `abstract` flag. */
  readonly abstract: boolean;
  /** Class names from the root down to this class. */
  readonly chain: readonly string[];
  readonly classCode?: string;
  readonly tagFormat?: string;
  readonly tagScope: TagScope;
  readonly ifc?: IfcMapping;
  /** Inherited definitions first, in declaration order; an overriding definition keeps the inherited position. */
  readonly properties: readonly PropertyDefinition[];
}

export type Resolution =
  | { readonly ok: true; readonly resolved: ResolvedClass }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Why `child` cannot override `parent` (type / unit change, relaxed required / readOnly, wider enum, another pattern), or null. */
export function overrideProblem(parent: PropertyDefinition, child: PropertyDefinition): string | null {
  const name = child.name;
  if (child.type !== parent.type) return `${name}: a subclass cannot change the type ${parent.type} to ${child.type}`;
  if (child.unit !== parent.unit)
    return `${name}: a subclass cannot change the unit ${parent.unit ?? '(none)'} to ${child.unit ?? '(none)'}`;
  if (parent.required === true && child.required === false) return `${name}: a subclass cannot make a required property optional`;
  if (parent.readOnly === true && child.readOnly === false) return `${name}: a subclass cannot make a read-only property editable`;
  if (parent.pattern !== undefined && child.pattern !== undefined && child.pattern !== parent.pattern)
    return `${name}: a subclass cannot replace the pattern ${parent.pattern}`;
  if (parent.pattern !== undefined && child.pattern === undefined) return `${name}: a subclass cannot drop the pattern ${parent.pattern}`;
  if (
    parent.enumValues !== undefined &&
    child.enumValues !== undefined &&
    !child.enumValues.every((value) => parent.enumValues?.includes(value))
  )
    return `${name}: a subclass may only narrow the enumValues ${parent.enumValues.join(', ')}`;
  return null;
}

function merge(inherited: readonly PropertyDefinition[], own: readonly PropertyDefinition[]): PropertyDefinition[] | string {
  const merged = [...inherited];
  for (const definition of own) {
    const index = merged.findIndex((existing) => existing.name === definition.name);
    if (index < 0) merged.push(definition);
    else {
      const problem = overrideProblem(merged[index] as PropertyDefinition, definition);
      if (problem !== null) return problem;
      const combined = { ...(merged[index] as PropertyDefinition), ...definition };
      const invalid = definitionProblem(combined);
      if (invalid !== null) return invalid;
      merged[index] = combined;
    }
  }
  return merged;
}

const cache = new WeakMap<object, Map<string, Resolution>>();

function resolveUncached(data: PlantDataModel, name: string): Resolution {
  const own: PlantClass[] = [];
  let current: PlantClass | undefined = data.classes[name];
  if (current === undefined) return { ok: false, code: 'DAT_CLASS_UNKNOWN', message: `no class "${name}"` };
  const seen = new Set<string>();
  while (current !== undefined) {
    if (seen.has(current.name))
      return { ok: false, code: 'DAT_CLASS_CYCLE', message: `class "${name}" inherits from itself through "${current.name}"` };
    seen.add(current.name);
    own.unshift(current);
    if (current.parent === null) break;
    const parent: PlantClass | undefined = data.classes[current.parent];
    if (parent === undefined)
      return { ok: false, code: 'DAT_CLASS_PARENT_UNKNOWN', message: `class "${current.name}" has the unknown parent "${current.parent}"` };
    current = parent;
  }
  let properties: PropertyDefinition[] = [];
  for (const cls of own) {
    const next = merge(properties, cls.properties);
    if (typeof next === 'string') return { ok: false, code: 'DAT_PROPERTY_DEFINITION_INVALID', message: next };
    properties = next;
  }
  const last = (pick: (cls: PlantClass) => string | undefined): string | undefined =>
    own
      .map(pick)
      .reverse()
      .find((value) => value !== undefined);
  const classCode = last((cls) => cls.classCode);
  const tagFormat = last((cls) => cls.tagFormat);
  const tagScope = last((cls) => cls.tagScope) as TagScope | undefined;
  const ifc = [...own].reverse().find((cls) => cls.ifc !== undefined)?.ifc;
  const target = data.classes[name] as PlantClass;
  return {
    ok: true,
    resolved: {
      name,
      abstract: target.abstract,
      chain: own.map((cls) => cls.name),
      ...(classCode === undefined ? {} : { classCode }),
      ...(tagFormat === undefined ? {} : { tagFormat }),
      tagScope: tagScope ?? data.settings.defaultTagScope,
      ...(ifc === undefined ? {} : { ifc }),
      properties,
    },
  };
}

export function resolveClass(data: PlantDataModel, name: string): Resolution {
  let perClass = cache.get(data.classes);
  if (perClass === undefined) {
    perClass = new Map();
    cache.set(data.classes, perClass);
  }
  let resolution = perClass.get(name);
  if (resolution === undefined) {
    resolution = resolveUncached(data, name);
    perClass.set(name, resolution);
  }
  return resolution;
}

/** Resolved class or null. */
export const resolvedOrNull = (data: PlantDataModel, name: string): ResolvedClass | null => {
  const resolution = resolveClass(data, name);
  return resolution.ok ? resolution.resolved : null;
};

/** Does `name` equal `ancestor` or inherit from it? */
export const isKindOf = (data: PlantDataModel, name: string, ancestor: string): boolean =>
  resolvedOrNull(data, name)?.chain.includes(ancestor) ?? false;

/** Concrete classes that are `name` or inherit from it, in definition order. */
export const concreteDescendants = (data: PlantDataModel, name: string): PlantClass[] =>
  data.classOrder.flatMap((className) => {
    const cls = data.classes[className];
    return cls !== undefined && !cls.abstract && isKindOf(data, className, name) ? [cls] : [];
  });
