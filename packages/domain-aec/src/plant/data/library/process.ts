/**
 * The default process class library `llull-default-process` (plant 08 DAT §5.5, TR-DAT-04): equipment and line classes with a tag format, the
 * properties a line list / equipment list needs, and the IFC4X3_ADD2 mapping of each class (entities and enumeration values checked against the
 * schema facts of the validation pack). Tag formats are examples modelled on the Size-Spec-Service-Line Number default of AutoCAD P&ID and
 * area-type-number equipment tags, not an industry standard (pack sources S8): a project overrides them by subclassing. Data, no logic.
 */

import type { IfcMapping, PlantClass, PropertyDefinition } from '../model';

const text = (name: string, displayName: string, extra: Partial<PropertyDefinition> = {}): PropertyDefinition => ({
  name,
  displayName,
  type: 'text',
  ...extra,
});

const physical = (
  name: string,
  displayName: string,
  type: PropertyDefinition['type'],
  unit: string,
  extra: Partial<PropertyDefinition> = {},
): PropertyDefinition => ({ name, displayName, type, unit, ...extra });

const cls = (
  name: string,
  parent: string | null,
  extra: Partial<Omit<PlantClass, 'name' | 'parent' | 'source'>> & { readonly ifc?: IfcMapping } = {},
): PlantClass => ({ name, parent, abstract: false, properties: [], source: 'library', ...extra });

const valve = (name: string, predefinedType: string): PlantClass =>
  cls(name, 'Valve', { ifc: { entity: 'IfcValve', predefinedType, pset: 'Pset_ValveTypeCommon' } });

export const DEFAULT_PROCESS_LIBRARY = 'llull-default-process';

export const DEFAULT_PROCESS_CLASSES: readonly PlantClass[] = [
  cls('Equipment', null, {
    abstract: true,
    tagFormat: '{classCode}-{area}{seq:2}',
    properties: [
      text('Description', 'Description', { required: true }),
      physical('DesignPressure', 'Design pressure', 'pressure', 'barg', { required: true }),
      physical('DesignTemperature', 'Design temperature', 'temperature', 'degC'),
      physical('OperatingWeight', 'Operating weight', 'mass', 'kg'),
      text('Service', 'Service'),
      text('Manufacturer', 'Manufacturer'),
      text('Model', 'Model'),
    ],
  }),
  cls('Tank', 'Equipment', { classCode: 'T', ifc: { entity: 'IfcTank', predefinedType: 'STORAGE', pset: 'Pset_TankTypeCommon' } }),
  cls('PressureVessel', 'Equipment', {
    classCode: 'V',
    ifc: { entity: 'IfcTank', predefinedType: 'PRESSUREVESSEL', pset: 'Pset_TankTypeCommon' },
  }),
  cls('Column', 'Equipment', { classCode: 'C', ifc: { entity: 'IfcTank', predefinedType: 'USERDEFINED', objectType: 'COLUMN' } }),
  cls('CentrifugalPump', 'Equipment', {
    classCode: 'P',
    properties: [physical('FlowRate', 'Flow rate', 'volumetricFlow', 'm3/h')],
    ifc: { entity: 'IfcPump', predefinedType: 'ENDSUCTION', pset: 'Pset_PumpTypeCommon' },
  }),
  cls('Compressor', 'Equipment', { classCode: 'K', ifc: { entity: 'IfcCompressor', predefinedType: 'DYNAMIC' } }),
  cls('HeatExchanger', 'Equipment', { classCode: 'E', ifc: { entity: 'IfcHeatExchanger', predefinedType: 'SHELLANDTUBE' } }),
  cls('ProcessLine', null, {
    tagFormat: '{nominalSize}-{fluidCode}-{seq:4}-{spec}',
    properties: [
      { name: 'nominalSize', displayName: 'Nominal size DN', type: 'integer', required: true },
      text('fluidCode', 'Fluid code', { required: true, pattern: '[A-Z]{1,3}' }),
      text('spec', 'Piping spec', { required: true, pattern: '[A-Z0-9]{2,6}' }),
      physical('DesignPressure', 'Design pressure', 'pressure', 'barg'),
      physical('DesignTemperature', 'Design temperature', 'temperature', 'degC'),
      text('from', 'From'),
      text('to', 'To'),
      text('Insulation', 'Insulation'),
    ],
    ifc: { entity: 'IfcDistributionSystem', predefinedType: 'USERDEFINED', objectType: 'PIPELINE' },
  }),
  cls('Valve', null, {
    abstract: true,
    tagFormat: '{valveCode}-{seq:4}',
    properties: [
      text('valveCode', 'Valve code', { required: true, pattern: '[A-Z]{1,4}' }),
      { name: 'nominalSize', displayName: 'Nominal size DN', type: 'integer' },
      text('Description', 'Description'),
    ],
  }),
  valve('IsolationValve', 'ISOLATING'),
  valve('CheckValve', 'CHECK'),
  valve('ControlValve', 'REGULATING'),
  valve('ReliefValve', 'PRESSURERELIEF'),
];
