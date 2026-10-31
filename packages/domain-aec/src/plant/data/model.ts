/**
 * Plant data model (plant 08 DAT, TECHNICAL_SPEC §3): the hierarchy, the class definitions, the plant objects with their tags and typed
 * properties. Stored in `doc.plant.data` (plant README D2); the tag registry is derived, never stored. Plain JSON; lengths, pressures and
 * temperatures are numbers in the unit their property definition declares.
 */

import type { CadDocument } from '@core/model/types';

export const HIERARCHY_KINDS = ['site', 'plant', 'area', 'unit', 'system'] as const;
export type HierarchyKind = (typeof HIERARCHY_KINDS)[number];

export const PROPERTY_TYPES = [
  'text',
  'integer',
  'real',
  'boolean',
  'enum',
  'length',
  'pressure',
  'temperature',
  'mass',
  'volumetricFlow',
  'massFlow',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export type PlantValue = string | number | boolean | null;

export interface HierarchyNode {
  readonly id: string;
  /** Unique among siblings (`U10`). */
  readonly code: string;
  readonly kind: HierarchyKind;
  readonly name: string;
  readonly parentId: string | null;
  readonly properties: Readonly<Record<string, PlantValue>>;
}

export interface PropertyDefinition {
  /** Identifier without spaces (Plant 3D rule, spec R7). */
  readonly name: string;
  readonly displayName: string;
  readonly type: PropertyType;
  /** Required for the physical types, absent for the others. */
  readonly unit?: string | undefined;
  readonly enumValues?: readonly string[] | undefined;
  /** Regular expression source a text value must match entirely. */
  readonly pattern?: string | undefined;
  readonly required?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly derivedFrom?: 'geometry' | 'tag' | 'hierarchy' | undefined;
  readonly default?: PlantValue | undefined;
}

export interface IfcMapping {
  /** `IfcPump`, `IfcValve`, ... (an entity of `ifcMapping.ts`). */
  readonly entity: string;
  /** A value of the entity's type enumeration, else `USERDEFINED` plus `objectType`. */
  readonly predefinedType?: string | undefined;
  readonly objectType?: string | undefined;
  /** Template property set to fill, e.g. `Pset_PumpTypeCommon`. */
  readonly pset?: string | undefined;
  /** Class property name -> property set property name. */
  readonly propertyMap?: Readonly<Record<string, string>> | undefined;
}

export type TagScope = 'plant' | 'site' | 'project';

export interface PlantClass {
  /** Unique PascalCase identifier. */
  readonly name: string;
  readonly parent: string | null;
  readonly abstract: boolean;
  readonly classCode?: string;
  /** Tag format (grammar of `tagFormat.ts`); inherited from the parent when absent. */
  readonly tagFormat?: string;
  /** Absent = the parent's scope, at the root the document default. */
  readonly tagScope?: TagScope;
  /** Own definitions; the inherited ones are merged by `resolveClass`. */
  readonly properties: readonly PropertyDefinition[];
  readonly ifc?: IfcMapping;
  /** `library` classes are read-only; a project extends them by subclassing. */
  readonly source: 'library' | 'project';
}

export interface ValueProvenance {
  readonly source: 'pid' | 'datasheet' | 'calculation' | 'agent' | 'import' | 'default';
  readonly ref?: string | undefined;
  readonly unverified?: boolean | undefined;
}

/**
 * What a plant object stands for: a building element (`buildingElement`: equipment, pipe, tray, support, member), an object of another
 * plugin through a registered provider (`provider`: routed line, inline component, tie-in, later nozzles / instruments) or a reserved tag.
 */
export type PlantObjectTarget =
  | { readonly kind: 'buildingElement'; readonly id: string }
  | { readonly kind: 'provider'; readonly provider: string; readonly id: string }
  | { readonly kind: 'reserved' };

export interface PlantObject {
  /** Step-scoped `plantobj-<step>.<k>`. */
  readonly id: string;
  readonly className: string;
  readonly hierarchyId: string;
  readonly target: PlantObjectTarget;
  /** Tag format fields that are not class properties (the sequence number, ...). */
  readonly tagFields: Readonly<Record<string, PlantValue>>;
  /** Cached `generate(format, fields)`; load recomputes and compares. */
  readonly tag: string;
  readonly properties: Readonly<Record<string, PlantValue>>;
  readonly provenance?: Readonly<Record<string, ValueProvenance>>;
  /** Id of the process line object a component or pipe belongs to. */
  readonly lineId?: string;
}

export interface PlantDataSettings {
  /** Regular expression source of the line end names that are battery limits (`^(BL|TI)-`). */
  readonly batteryLimitPattern: string;
  readonly defaultTagScope: TagScope;
}

/** Report kinds a definition can be saved for (the built ones of plant_report). */
export const DEFINITION_KINDS = ['line_list', 'equipment_list', 'nozzle_schedule', 'mto', 'tag_register'] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

/** A column computed from the numeric columns of a row with the parameter expression evaluator (). */
export interface ComputedColumn {
  readonly name: string;
  readonly displayName: string;
  readonly expression: string;
  readonly unit: string | null;
}

/** A saved report template (plant 08 DAT §3 ): the kind and the choices plant_report applies to it. */
export interface ReportDefinition {
  readonly id: string;
  readonly kind: DefinitionKind;
  readonly hierarchy?: string;
  readonly groupBy?: readonly string[];
  /** Column names to keep, in this order (computed columns included); absent = all. */
  readonly columns?: readonly string[];
  readonly computed?: readonly ComputedColumn[];
  /** Column name -> required value. */
  readonly filter?: Readonly<Record<string, PlantValue>>;
  /** Column names, a leading - sorts descending. */
  readonly sort?: readonly string[];
}

export interface PlantDataModel {
  readonly version: 1;
  readonly hierarchy: Readonly<Record<string, HierarchyNode>>;
  readonly hierarchyOrder: readonly string[];
  readonly classes: Readonly<Record<string, PlantClass>>;
  readonly classOrder: readonly string[];
  readonly objects: Readonly<Record<string, PlantObject>>;
  readonly objectOrder: readonly string[];
  readonly settings: PlantDataSettings;
  /** Saved report definitions by id (M4); absent until the first save_report_definition. */
  readonly reports?: Readonly<Record<string, ReportDefinition>>;
}

export const DEFAULT_BATTERY_LIMIT_PATTERN = '^(BL|TI)-';

export const EMPTY_PLANT_DATA: PlantDataModel = {
  version: 1,
  hierarchy: {},
  hierarchyOrder: [],
  classes: {},
  classOrder: [],
  objects: {},
  objectOrder: [],
  settings: { batteryLimitPattern: DEFAULT_BATTERY_LIMIT_PATTERN, defaultTagScope: 'plant' },
};

export const getPlantData = (doc: Pick<CadDocument, 'plant'>): PlantDataModel => doc.plant?.data ?? EMPTY_PLANT_DATA;

export const withPlantData = (doc: CadDocument, data: PlantDataModel): CadDocument => ({ ...doc, plant: { ...doc.plant, data } });

export const isPhysicalType = (type: PropertyType): boolean =>
  type !== 'text' && type !== 'integer' && type !== 'real' && type !== 'boolean' && type !== 'enum';

export interface ObjectChange {
  readonly properties?: Readonly<Record<string, PlantValue>>;
  /** An empty provenance is dropped. */
  readonly provenance?: Readonly<Record<string, ValueProvenance>>;
  readonly tag?: string;
  /** null removes the link to a process line object. */
  readonly lineId?: string | null;
}

/** A copy of the object with the given parts replaced. */
export function copyObject(object: PlantObject, change: ObjectChange): PlantObject {
  const provenance = change.provenance ?? object.provenance ?? {};
  const lineId = change.lineId === undefined ? object.lineId : (change.lineId ?? undefined);
  return {
    id: object.id,
    className: object.className,
    hierarchyId: object.hierarchyId,
    target: object.target,
    tagFields: object.tagFields,
    tag: change.tag ?? object.tag,
    properties: change.properties ?? object.properties,
    ...(Object.keys(provenance).length === 0 ? {} : { provenance }),
    ...(lineId === undefined ? {} : { lineId }),
  };
}

/** Provider id of a target (`buildingElement` or the provider name), null for a reserved tag. */
export const providerIdOf = (target: PlantObjectTarget): string | null =>
  target.kind === 'buildingElement' ? 'buildingElement' : target.kind === 'provider' ? target.provider : null;

/** `<provider>:<id>` of the model object a target stands for, null for a reserved tag. */
export const targetKey = (target: PlantObjectTarget): string | null =>
  target.kind === 'reserved' ? null : `${providerIdOf(target)}:${target.id}`;
