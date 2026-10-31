/**
 * Read-only view of the plant data for the IFC writer (plant 08 DAT §2, §5.5, §5.8): which plant object stands for a building element, its resolved class
 * and IFC mapping, the SI values of its typed properties. The IFC exporter imports this file only (the plant data never imports the exchange code).
 * @invariant pure; no document is built; values are converted to the IFC unit system (Pa, K, kg, mm, m3/s, kg/s)
 */

import type { CadDocument } from '@core/model/types';
import { resolvedOrNull, type ResolvedClass } from './classes';
import { ancestry, pathOf } from './hierarchy';
import { isProcessLine } from './lines';
import {
  getPlantData,
  type HierarchyNode,
  type IfcMapping,
  type PlantDataModel,
  type PlantObject,
  type PlantValue,
  type PropertyDefinition,
  type PropertyType,
} from './model';
import { objectRegistry } from './registry';
import { convertUnit } from './units';

export interface PlantIfcObject {
  readonly object: PlantObject;
  readonly tag: string;
  readonly className: string;
  readonly resolved: ResolvedClass | null;
  /** The IFC mapping of the class (inherited), when it has one. */
  readonly mapping: IfcMapping | undefined;
  readonly isLine: boolean;
  /** `S1/P1/U10` path of the hierarchy node. */
  readonly path: string;
}

/** IFC measure type of a property value, in the units of the exported file. */
export type IfcMeasure =
  | 'IFCLABEL'
  | 'IFCTEXT'
  | 'IFCINTEGER'
  | 'IFCREAL'
  | 'IFCBOOLEAN'
  | 'IFCLENGTHMEASURE'
  | 'IFCPRESSUREMEASURE'
  | 'IFCTHERMODYNAMICTEMPERATUREMEASURE'
  | 'IFCMASSMEASURE'
  | 'IFCVOLUMETRICFLOWRATEMEASURE'
  | 'IFCMASSFLOWRATEMEASURE';

export interface IfcPlantProperty {
  readonly name: string;
  readonly description: string;
  readonly measure: IfcMeasure;
  readonly value: string | number | boolean;
}

export interface PlantIfcView {
  readonly data: PlantDataModel;
  /** Hierarchy nodes in definition order. */
  readonly nodes: readonly HierarchyNode[];
  /** Plant object that stands for the building element `id`, when classified. */
  forElement(id: string): PlantIfcObject | undefined;
  /** Plant object by id. */
  forObject(id: string): PlantIfcObject | undefined;
  /** True when the document carries plant objects or a hierarchy. */
  readonly active: boolean;
}

function describe(data: PlantDataModel, object: PlantObject): PlantIfcObject {
  const resolved = resolvedOrNull(data, object.className);
  return {
    object,
    tag: object.tag,
    className: object.className,
    resolved,
    mapping: resolved?.ifc,
    isLine: isProcessLine(data, object),
    path: pathOf(data, object.hierarchyId),
  };
}

export function plantIfcView(doc: CadDocument): PlantIfcView {
  const data = getPlantData(doc);
  const byTarget = objectRegistry(data).byTarget;
  const cache = new Map<string, PlantIfcObject>();
  const forObject = (id: string): PlantIfcObject | undefined => {
    const object = data.objects[id];
    if (object === undefined) return undefined;
    let described = cache.get(id);
    if (described === undefined) cache.set(id, (described = describe(data, object)));
    return described;
  };
  return {
    data,
    nodes: data.hierarchyOrder.flatMap((id) => data.hierarchy[id] ?? []),
    forElement: (id) => {
      const objectId = byTarget.get(`buildingElement:${id}`);
      return objectId === undefined ? undefined : forObject(objectId);
    },
    forObject,
    active: data.objectOrder.length > 0 || data.hierarchyOrder.length > 0,
  };
}

/** Nearest hierarchy node of kind site / plant / area / unit at or above `hierarchyId` (system nodes are not spatial). */
export function spatialNode(data: PlantDataModel, hierarchyId: string): HierarchyNode | undefined {
  return ancestry(data, hierarchyId)
    .reverse()
    .find((node) => node.kind !== 'system');
}

const TARGET_UNIT: Readonly<Partial<Record<PropertyType, { unit: string; measure: IfcMeasure; label: string }>>> = {
  length: { unit: 'mm', measure: 'IFCLENGTHMEASURE', label: 'mm' },
  pressure: { unit: 'kPag', measure: 'IFCPRESSUREMEASURE', label: 'Pa' },
  temperature: { unit: 'K', measure: 'IFCTHERMODYNAMICTEMPERATUREMEASURE', label: 'K' },
  mass: { unit: 'kg', measure: 'IFCMASSMEASURE', label: 'kg' },
  volumetricFlow: { unit: 'm3/s', measure: 'IFCVOLUMETRICFLOWRATEMEASURE', label: 'm3/s' },
  massFlow: { unit: 'kg/s', measure: 'IFCMASSFLOWRATEMEASURE', label: 'kg/s' },
};

const GAUGE_UNITS: ReadonlySet<string> = new Set(['barg', 'kPag', 'MPag', 'psig']);

/** SI measure of one property value, or null when it is empty or not convertible. */
export function ifcProperty(definition: PropertyDefinition, value: PlantValue | undefined): IfcPlantProperty | null {
  if (value === null || value === undefined) return null;
  const label = definition.displayName === '' ? definition.name : definition.displayName;
  const base = { name: definition.name, description: label };
  switch (definition.type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ...base, measure: 'IFCBOOLEAN', value } : null;
    case 'integer':
      return typeof value === 'number' ? { ...base, measure: 'IFCINTEGER', value: Math.round(value) } : null;
    case 'real':
      return typeof value === 'number' ? { ...base, measure: 'IFCREAL', value } : null;
    case 'text':
    case 'enum':
      return { ...base, measure: definition.type === 'text' ? 'IFCTEXT' : 'IFCLABEL', value: String(value) };
    default: {
      const target = TARGET_UNIT[definition.type];
      if (target === undefined || typeof value !== 'number' || definition.unit === undefined) return null;
      const gauge = definition.type === 'pressure' && GAUGE_UNITS.has(definition.unit);
      const converted = convertUnit(
        definition.type,
        value,
        definition.unit,
        definition.type === 'pressure' && !gauge ? 'kPaa' : target.unit,
      );
      if (converted === null) return null;
      const scaled = definition.type === 'pressure' ? converted * 1000 : converted;
      const suffix = definition.type === 'pressure' ? `${target.label}${gauge ? ', gauge' : ', absolute'}` : target.label;
      return { ...base, description: `${label} (${suffix})`, measure: target.measure, value: scaled };
    }
  }
}

/** Typed properties of an object as IFC measures, in class definition order (empty values are left out). */
export function ifcProperties(view: PlantIfcObject): IfcPlantProperty[] {
  return (view.resolved?.properties ?? []).flatMap((definition) => ifcProperty(definition, view.object.properties[definition.name]) ?? []);
}

/** Template property set of the class mapping (`mapping.pset`) filled through `propertyMap`; null without both. */
export function templatePset(view: PlantIfcObject): { name: string; properties: IfcPlantProperty[] } | null {
  const mapping = view.mapping;
  if (mapping?.pset === undefined || mapping.propertyMap === undefined) return null;
  const map = mapping.propertyMap;
  const properties = ifcProperties(view).flatMap((property) => {
    const target = map[property.name];
    return target === undefined ? [] : [{ ...property, name: target }];
  });
  return properties.length === 0 ? null : { name: mapping.pset, properties };
}

/** Names of the properties whose value carries `unverified` provenance (AF-32). */
export const unverifiedProperties = (object: PlantObject): string[] =>
  Object.entries(object.provenance ?? {}).flatMap(([name, provenance]) => (provenance.unverified === true ? [name] : []));
