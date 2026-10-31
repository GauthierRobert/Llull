/**
 * Checks an IFC file (records of `@lib/stepRead`) against an IDS (`idsParse.ts`): per specification, the entities its applicability selects, how many break a requirement
 * and their GlobalIds. Read-only and linear in specifications x entities; relationship indexes are built once and only when a facet needs them.
 * Not modelled (documented limits): properties and classifications reached through a type object (IfcRelDefinesByType), property kinds other than single values, material facets.
 */

import { stepString, type StepEntity, type StepFile } from '@lib/stepRead';
import { enumOf, plainText, predefinedIndex, refsOf, typeNameOf, NAME_INDEX, OBJECT_TYPE_INDEX, TAG_INDEX, isProduct } from './ifcAccess';
import { typeChain } from './ifcNames';
import type { Cardinality, EntityFacet, Facet, Ids, Specification, ValueRule } from './idsTypes';

export interface SpecificationResult {
  readonly name: string;
  readonly status: 'pass' | 'fail';
  readonly applicable: number;
  readonly failed: number;
  readonly failedGlobalIds: readonly string[];
  readonly skipped?: string;
}

const MAX_LISTED = 100;
const MAX_VALUE = 1000;

interface PropertyValue {
  readonly text: string | null;
  readonly dataType: string;
}
interface ClassificationRef {
  readonly system: string;
  readonly identification: string;
}
interface Parent {
  readonly relation: string;
  readonly parent: number;
}

class Index {
  private psets: Map<number, Map<string, Map<string, PropertyValue>>> | null = null;
  private classifications: Map<number, ClassificationRef[]> | null = null;
  private parents: Map<number, Parent[]> | null = null;
  constructor(private readonly file: StepFile) {}

  properties(id: number): ReadonlyMap<string, ReadonlyMap<string, PropertyValue>> | undefined {
    if (this.psets === null) {
      const psets = new Map<number, Map<string, Map<string, PropertyValue>>>();
      for (const rel of this.file.entities.values()) {
        if (rel.type !== 'IFCRELDEFINESBYPROPERTIES') continue;
        const set = this.file.entities.get(refsOf(rel.args[5])[0] ?? -1);
        if (set?.type !== 'IFCPROPERTYSET') continue;
        const values = new Map<string, PropertyValue>();
        for (const propertyId of refsOf(set.args[4])) {
          const property = this.file.entities.get(propertyId);
          if (property?.type !== 'IFCPROPERTYSINGLEVALUE') continue;
          values.set(stepString(property.args[0]), { text: plainText(property.args[2]), dataType: typeNameOf(property.args[2]) });
        }
        for (const owner of refsOf(rel.args[4])) {
          const byName = psets.get(owner) ?? new Map<string, Map<string, PropertyValue>>();
          byName.set(stepString(set.args[2]), values);
          psets.set(owner, byName);
        }
      }
      this.psets = psets;
    }
    return this.psets.get(id);
  }

  classificationsOf(id: number): readonly ClassificationRef[] {
    if (this.classifications === null) {
      const map = new Map<number, ClassificationRef[]>();
      for (const rel of this.file.entities.values()) {
        if (rel.type !== 'IFCRELASSOCIATESCLASSIFICATION') continue;
        const reference = this.file.entities.get(refsOf(rel.args[5])[0] ?? -1);
        if (reference?.type !== 'IFCCLASSIFICATIONREFERENCE') continue;
        const source = this.file.entities.get(refsOf(reference.args[3])[0] ?? -1);
        const entry = {
          identification: stepString(reference.args[1]),
          system: source?.type === 'IFCCLASSIFICATION' ? stepString(source.args[3]) : '',
        };
        for (const owner of refsOf(rel.args[4])) map.set(owner, [...(map.get(owner) ?? []), entry]);
      }
      this.classifications = map;
    }
    return this.classifications.get(id) ?? [];
  }

  parentsOf(id: number): readonly Parent[] {
    if (this.parents === null) {
      const map = new Map<number, Parent[]>();
      const link = (relation: string, parent: number | undefined, children: readonly number[]): void => {
        if (parent === undefined) return;
        for (const child of children) map.set(child, [...(map.get(child) ?? []), { relation, parent }]);
      };
      for (const rel of this.file.entities.values()) {
        if (rel.type === 'IFCRELAGGREGATES' || rel.type === 'IFCRELNESTS') link(rel.type, refsOf(rel.args[4])[0], refsOf(rel.args[5]));
        else if (rel.type === 'IFCRELASSIGNSTOGROUP') link(rel.type, refsOf(rel.args[6])[0], refsOf(rel.args[4]));
        else if (rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') link(rel.type, refsOf(rel.args[5])[0], refsOf(rel.args[4]));
      }
      this.parents = map;
    }
    return this.parents.get(id) ?? [];
  }
}

function matches(rule: ValueRule, text: string | null, upper = false): boolean {
  if (text === null || text.length > MAX_VALUE) return false;
  const value = upper ? text.toUpperCase() : text;
  if (rule.simple !== undefined) {
    const wanted = upper ? rule.simple.toUpperCase() : rule.simple;
    if (value === wanted) return true;
    const a = Number(value);
    const b = Number(rule.simple);
    return value.trim() !== '' && rule.simple.trim() !== '' && Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  if (rule.enumeration !== undefined && !rule.enumeration.some((entry) => (upper ? entry.toUpperCase() === value : entry === value)))
    return false;
  if (rule.patterns !== undefined && !rule.patterns.some((regex) => regex.test(value))) return false;
  if (rule.bounds !== undefined) {
    const number = Number(value);
    const { minInclusive, maxInclusive, minExclusive, maxExclusive } = rule.bounds;
    if (value.trim() === '' || !Number.isFinite(number)) return false;
    if (
      (minInclusive !== undefined && number < minInclusive) ||
      (maxInclusive !== undefined && number > maxInclusive) ||
      (minExclusive !== undefined && number <= minExclusive) ||
      (maxExclusive !== undefined && number >= maxExclusive)
    )
      return false;
  }
  return true;
}

/** PredefinedType of the entity; for USERDEFINED the ObjectType (IDS reads the user defined text). */
function effectivePredefined(entity: StepEntity): string | null {
  const index = predefinedIndex(entity);
  if (index < 0) return null;
  const value = enumOf(entity.args[index]);
  return value === 'USERDEFINED' ? stepString(entity.args[OBJECT_TYPE_INDEX]) || value : value;
}

function entityMatches(entity: StepEntity, facet: EntityFacet): boolean {
  if (!typeChain(entity.type).some((name) => matches(facet.name, name, true))) return false;
  return facet.predefinedType === undefined || matches(facet.predefinedType, effectivePredefined(entity), true);
}

/** Attribute name -> text of the attributes this reader knows how to find. */
function attributes(entity: StepEntity): Array<[string, string | null]> {
  const text = (index: number): string | null => {
    const value = plainText(entity.args[index]);
    return value === null || value === '' ? null : value;
  };
  const found: Array<[string, string | null]> = [
    ['GlobalId', text(0)],
    ['Name', text(NAME_INDEX)],
    ['Description', text(3)],
    ['ObjectType', text(OBJECT_TYPE_INDEX)],
  ];
  if (isProduct(entity)) found.push(['Tag', text(TAG_INDEX)]);
  const predefined = predefinedIndex(entity);
  if (predefined >= 0) found.push(['PredefinedType', text(predefined)]);
  if (entity.type === 'IFCDISTRIBUTIONSYSTEM') found.push(['LongName', text(5)]);
  return found;
}

type Verdict = 'absent' | 'match' | 'mismatch';

function verdict(file: StepFile, index: Index, entity: StepEntity, facet: Facet): Verdict {
  switch (facet.type) {
    case 'entity':
      return entityMatches(entity, facet) ? 'match' : 'mismatch';
    case 'attribute': {
      const named = attributes(entity).filter(([name]) => matches(facet.name, name));
      const present = named.filter(([, text]) => text !== null);
      if (present.length === 0) return 'absent';
      return facet.value === undefined || present.some(([, text]) => matches(facet.value as ValueRule, text)) ? 'match' : 'mismatch';
    }
    case 'property': {
      const sets = index.properties(entity.id);
      let found = false;
      for (const [setName, props] of sets ?? []) {
        if (!matches(facet.propertySet, setName)) continue;
        for (const [name, property] of props) {
          if (!matches(facet.baseName, name) || property.text === null) continue;
          found = true;
          if (
            (facet.dataType === undefined || facet.dataType === property.dataType) &&
            (facet.value === undefined || matches(facet.value, property.text))
          )
            return 'match';
        }
      }
      return found ? 'mismatch' : 'absent';
    }
    case 'classification': {
      const refs = index.classificationsOf(entity.id);
      if (refs.length === 0) return 'absent';
      const ok = refs.some(
        (ref) =>
          (facet.system === undefined || matches(facet.system, ref.system)) &&
          (facet.value === undefined || matches(facet.value, ref.identification)),
      );
      return ok ? 'match' : 'mismatch';
    }
    case 'partOf': {
      const parents = index.parentsOf(entity.id).filter((link) => facet.relation === undefined || link.relation === facet.relation);
      if (parents.length === 0) return 'absent';
      return parents.some((link) => {
        const parent = file.entities.get(link.parent);
        return parent !== undefined && entityMatches(parent, facet.entity);
      })
        ? 'match'
        : 'mismatch';
    }
  }
}

const cardinalityOf = (facet: Facet): Cardinality => (facet.type === 'entity' ? 'required' : facet.cardinality);

const holds = (result: Verdict, cardinality: Cardinality): boolean =>
  cardinality === 'required' ? result === 'match' : cardinality === 'optional' ? result !== 'mismatch' : result !== 'match';

function checkSpecification(file: StepFile, index: Index, spec: Specification): SpecificationResult {
  const versions = spec.ifcVersions.map((version) => version.toUpperCase());
  const schema = file.schema.toUpperCase();
  if (versions.length > 0 && !versions.some((version) => schema === version || schema.startsWith(version) || version.startsWith(schema)))
    return {
      name: spec.name,
      status: 'pass',
      applicable: 0,
      failed: 0,
      failedGlobalIds: [],
      skipped: `the specification is for ${spec.ifcVersions.join(' ')}, the file is ${file.schema}`,
    };
  let applicable = 0;
  let failed = 0;
  const failedGlobalIds: string[] = [];
  for (const entity of file.entities.values()) {
    if (!spec.applicability.every((facet) => verdict(file, index, entity, facet) === 'match')) continue;
    applicable++;
    if (spec.requirements.every((facet) => holds(verdict(file, index, entity, facet), cardinalityOf(facet)))) continue;
    failed++;
    if (failedGlobalIds.length < MAX_LISTED) failedGlobalIds.push(stepString(entity.args[0]) || `#${entity.id}`);
  }
  const unmet = applicable === 0 && spec.minOccurs >= 1;
  return { name: spec.name, status: failed === 0 && !unmet ? 'pass' : 'fail', applicable, failed, failedGlobalIds };
}

/** One result per specification, in file order. */
export function checkIds(file: StepFile, ids: Ids): SpecificationResult[] {
  const index = new Index(file);
  return ids.specifications.map((spec) => checkSpecification(file, index, spec));
}
