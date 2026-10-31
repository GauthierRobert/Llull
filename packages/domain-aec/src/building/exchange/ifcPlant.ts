/**
 * Plant data in the IFC export (plant 08 DAT §5.5, §5.8, TR-DAT-20/21/24): the schema and options of one export run, the product class of a classified
 * equipment (entity and PredefinedType from the class mapping, `USERDEFINED` always with an ObjectType), the property sets `Pset_llullPlant` and the
 * template set of the class, the distribution systems of the process lines, and the entity counts reported in `data.counts`.
 * @invariant pure over the document; an unmapped class becomes an IfcBuildingElementProxy listed in `proxies` with a DAT_IFC_MAPPING_MISSING warning
 */

import type { EquipmentElement } from '@aec/building/types';
import { IFC_PREDEFINED_TYPES } from '../../plant/data/ifcMapping';
import {
  type IfcPlantProperty,
  type PlantIfcObject,
  type PlantIfcView,
  ifcProperties,
  templatePset,
  unverifiedProperties,
} from '../../plant/data/view';
import { type Context, ifcReal, ifcString } from './ifcStep';

export type IfcSchema = 'IFC4' | 'IFC4X3_ADD2';

export interface PlantIfcOptions {
  /** Ports, nests, connections and inferred nozzles (IFC4X3_ADD2). */
  readonly ports: boolean;
  /** `line`: one IfcDistributionSystem per process line. */
  readonly systems: 'line' | 'none';
  /** Plant hierarchy as IfcSite / IfcFacility / IfcFacilityPartCommon. */
  readonly hierarchy: boolean;
}

export interface ExportProxy {
  readonly id: string;
  readonly reason: string;
}

export interface ExportWarning {
  readonly code: 'DAT_IFC_MAPPING_MISSING';
  readonly id: string;
  readonly message: string;
}

export interface LineSystem {
  readonly object: PlantIfcObject;
  readonly members: string[];
}

/** Mutable state of one export run. */
export interface PlantIfcRun {
  readonly schema: IfcSchema;
  /** True for IFC4X3_ADD2. */
  readonly x3: boolean;
  readonly options: PlantIfcOptions;
  readonly view: PlantIfcView;
  readonly proxies: ExportProxy[];
  readonly warnings: ExportWarning[];
  /** `IfcValve.ISOLATING` -> count of products written with that class and type. */
  readonly predefined: Map<string, number>;
  /** Process line object id -> its system (members are product refs). */
  readonly systems: Map<string, LineSystem>;
}

export function newRun(schema: IfcSchema, options: PlantIfcOptions, view: PlantIfcView): PlantIfcRun {
  return { schema, x3: schema === 'IFC4X3_ADD2', options, view, proxies: [], warnings: [], predefined: new Map(), systems: new Map() };
}

const PASCAL: ReadonlyMap<string, string> = new Map(Object.keys(IFC_PREDEFINED_TYPES).map((name) => [name.toUpperCase(), name]));

/** `IFCTANK` -> `IfcTank` for the entities a plant class may map to. */
export const pascalEntity = (upper: string): string => PASCAL.get(upper) ?? upper;

export function countPredefined(run: PlantIfcRun, entity: string, predefined: string): void {
  const key = `${pascalEntity(entity)}.${predefined}`;
  run.predefined.set(key, (run.predefined.get(key) ?? 0) + 1);
}

/** `{ IfcValve: { ISOLATING: 1 } }` from the run counts. */
export function predefinedTypeCounts(run: PlantIfcRun): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const [key, count] of [...run.predefined].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [entity = '', type = ''] = key.split('.');
    result[entity] = { ...result[entity], [type]: count };
  }
  return result;
}

// prettier-ignore
const COUNTED = [
  'IfcSite', 'IfcFacility', 'IfcFacilityPartCommon', 'IfcBuilding', 'IfcBuildingStorey', 'IfcPipeSegment', 'IfcPipeFitting', 'IfcValve', 'IfcTank',
  'IfcPump', 'IfcCompressor', 'IfcHeatExchanger', 'IfcBuildingElementProxy', 'IfcCableCarrierSegment', 'IfcDistributionPort', 'IfcRelConnectsPorts',
  'IfcRelNests', 'IfcDistributionSystem', 'IfcRelAssignsToGroup', 'IfcPropertySet', 'IfcRelDefinesByProperties', 'IfcRelContainedInSpatialStructure',
  'IfcRelAggregates',
];

/** Entity counts of the classes the plant data touches (zeros included). */
export function entityCounts(context: Context): Record<string, number> {
  return Object.fromEntries(COUNTED.map((name) => [name, context.writer.countOf(name.toUpperCase())]));
}

export interface ProductClass {
  /** Upper-case IFC entity (`IFCTANK`). */
  readonly entity: string;
  /** Bare enumeration value (`STORAGE`). */
  readonly predefined: string;
  readonly objectType: string | null;
  readonly name: string;
  readonly description: string;
}

const descriptionOf = (plant: PlantIfcObject): string => {
  const text = plant.object.properties['Description'];
  return typeof text === 'string' && text !== '' ? `${plant.className} - ${text}` : plant.className;
};

/** Tag attribute of an element: the plant tag when classified, else the element id. */
export const elementTag = (run: PlantIfcRun, elementId: string): string => run.view.forElement(elementId)?.tag ?? elementId;

/**
 * Product class of equipment in IFC4X3_ADD2: the mapped class of its plant object, or null (an IfcBuildingElementProxy ELEMENT, listed in `proxies`).
 * Unclassified equipment and classes without a product mapping are proxies; the second is a DAT_IFC_MAPPING_MISSING warning.
 */
export function equipmentProduct(run: PlantIfcRun, element: EquipmentElement): ProductClass | null {
  const plant = run.view.forElement(element.id);
  const proxy = (reason: string): null => {
    run.proxies.push({ id: element.id, reason });
    countPredefined(run, 'IFCBUILDINGELEMENTPROXY', 'ELEMENT');
    return null;
  };
  if (!run.x3) return null;
  if (plant === undefined) return proxy('no plant object (assign_plant_object)');
  const mapping = plant.mapping;
  if (mapping === undefined || mapping.entity === 'IfcDistributionSystem') {
    const message = `class ${plant.className} of ${plant.tag} has no IFC product mapping: exported as IfcBuildingElementProxy (define_plant_class ifc)`;
    run.warnings.push({ code: 'DAT_IFC_MAPPING_MISSING', id: plant.object.id, message });
    return proxy(`DAT_IFC_MAPPING_MISSING: class ${plant.className}`);
  }
  const predefined = mapping.predefinedType ?? 'NOTDEFINED';
  countPredefined(run, mapping.entity.toUpperCase(), predefined);
  return {
    entity: mapping.entity.toUpperCase(),
    predefined,
    objectType: predefined === 'USERDEFINED' ? (mapping.objectType ?? null) : null,
    name: plant.tag,
    description: descriptionOf(plant),
  };
}

function singleValue(property: IfcPlantProperty): string {
  const { measure, value } = property;
  const written =
    measure === 'IFCBOOLEAN'
      ? value === true
        ? '.T.'
        : '.F.'
      : measure === 'IFCLABEL' || measure === 'IFCTEXT'
        ? ifcString(String(value))
        : measure === 'IFCINTEGER'
          ? String(value)
          : ifcReal(Number(value));
  return `IFCPROPERTYSINGLEVALUE(${ifcString(property.name)},${ifcString(property.description)},${measure}(${written}),$)`;
}

/** A property set with its own GlobalId seed on `owner` (several sets may share an owner). */
export function addNamedPset(
  context: Context,
  owner: { readonly seed: string; readonly ref: string },
  name: string,
  properties: ReadonlyArray<string>,
): void {
  if (properties.length === 0) return;
  const { writer } = context;
  const refs = properties.map((property) => writer.add(property));
  const set = writer.add(`IFCPROPERTYSET('${context.guid(`${owner.seed}:pset:${name}`)}',$,${ifcString(name)},$,(${refs.join(',')}))`);
  writer.add(`IFCRELDEFINESBYPROPERTIES('${context.guid(`${owner.seed}:rel-pset:${name}`)}',$,$,$,(${owner.ref}),${set})`);
}

const label = (name: string, description: string, text: string): string =>
  `IFCPROPERTYSINGLEVALUE(${ifcString(name)},${ifcString(description)},IFCLABEL(${ifcString(text)}),$)`;

/** `Pset_llullPlant` (class, hierarchy path, line number, every typed property in SI units, `Unverified`) and the template set of the class mapping. */
export function addPlantPsets(
  context: Context,
  owner: { readonly seed: string; readonly ref: string },
  plant: PlantIfcObject,
  level?: { readonly name: string; readonly elevation: number },
): void {
  const unverified = unverifiedProperties(plant.object);
  addNamedPset(context, owner, 'Pset_llullPlant', [
    label('ClassName', 'Plant class', plant.className),
    label('HierarchyPath', 'Plant hierarchy codes', plant.path),
    ...(plant.isLine ? [label('LineNumber', 'Process line tag', plant.tag)] : []),
    ...(level === undefined
      ? []
      : [
          label('Level', 'Building level', level.name),
          `IFCPROPERTYSINGLEVALUE('LevelElevation','Level elevation, mm',IFCLENGTHMEASURE(${ifcReal(level.elevation)}),$)`,
        ]),
    ...ifcProperties(plant).map(singleValue),
    ...(unverified.length === 0
      ? []
      : [
          `IFCPROPERTYSINGLEVALUE('Unverified','A value is unverified (computed by llull, not approved)',IFCBOOLEAN(.T.),$)`,
          label('UnverifiedProperties', 'Properties with unverified provenance', unverified.join(', ')),
        ]),
  ]);
  const template = templatePset(plant);
  if (template !== null) addNamedPset(context, owner, template.name, template.properties.map(singleValue));
}

/** One IfcDistributionSystem per process line with its member products (IfcRelAssignsToGroup); returns the number written. */
export function writeSystems(context: Context, run: PlantIfcRun): number {
  const { writer } = context;
  let count = 0;
  for (const [id, system] of run.systems) {
    if (system.members.length === 0) continue;
    const plant = system.object;
    const type = plant.object.properties['ifcSystemType'];
    const known = IFC_PREDEFINED_TYPES['IfcDistributionSystem'] ?? [];
    const predefined =
      typeof type === 'string' && known.includes(type.toUpperCase())
        ? type.toUpperCase()
        : (plant.mapping?.predefinedType ?? 'USERDEFINED');
    const objectType = predefined === 'USERDEFINED' ? (plant.mapping?.objectType ?? 'PIPELINE') : null;
    const ref = writer.add(
      `IFCDISTRIBUTIONSYSTEM('${context.guid(`${id}:system`)}',$,${ifcString(plant.tag)},${ifcString(descriptionOf(plant))},${objectType === null ? '$' : ifcString(objectType)},$,.${predefined}.)`,
    );
    writer.add(`IFCRELASSIGNSTOGROUP('${context.guid(`${id}:system-members`)}',$,$,$,(${system.members.join(',')}),$,${ref})`);
    addPlantPsets(context, { seed: `${id}:system`, ref }, plant);
    count += 1;
  }
  return count;
}

/**
 * Units IFC4X3_ADD2 adds to the unit assignment (§5.8): mass kg, pressure Pa, thermodynamic temperature K, time s, and the derived volumetric and mass
 * flow rates (m3/s, kg/s). Returns the unit references to append to the four building units.
 */
export function plantUnits(context: Context, cubicMetre: string): string[] {
  const { writer } = context;
  const mass = writer.add('IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.)');
  const pressure = writer.add('IFCSIUNIT(*,.PRESSUREUNIT.,$,.PASCAL.)');
  const temperature = writer.add('IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.)');
  const second = writer.add('IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.)');
  const perSecond = writer.add('IFCDERIVEDUNITELEMENT(' + second + ',-1)');
  const volumeFlow = writer.add(
    `IFCDERIVEDUNIT((${writer.add(`IFCDERIVEDUNITELEMENT(${cubicMetre},1)`)},${perSecond}),.VOLUMETRICFLOWRATEUNIT.,$)`,
  );
  const massFlow = writer.add(`IFCDERIVEDUNIT((${writer.add(`IFCDERIVEDUNITELEMENT(${mass},1)`)},${perSecond}),.MASSFLOWRATEUNIT.,$)`);
  return [mass, pressure, temperature, second, volumeFlow, massFlow];
}
