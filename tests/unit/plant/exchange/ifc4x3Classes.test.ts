/**
 * Plant 08 DAT-M3: class mapping, hierarchy shapes, proxies, property sets and flow directions of the IFC4X3_ADD2 export on small hand-built scenes
 * (TECHNICAL_SPEC §5.5 - §5.8). The SC-DAT-01 scene is covered by ifc4x3.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { getPlantData, withPlantData } from '@aec/plant/data/model';
import { readStep, stepReferences, stepString, type StepEntity, type StepFile } from '@lib/stepRead';
import { apply, data as queryData } from '../../../helpers/commandAssertions';
import { addEquipment, addPipe, libraryDocument } from '../data/dataFixtures';
import { stamp } from './ifcFixtures';

interface IfcData {
  ifc: string;
  counts: Record<string, number>;
  predefinedTypes: Record<string, Record<string, number>>;
  proxies: Array<{ id: string; reason: string }>;
  warnings: Array<{ code: string; id: string; message: string }>;
  ports: number;
  connections: number;
  openPorts: number;
}

const exportX3 = (doc: CadDocument, plant?: Record<string, unknown>): { out: IfcData; file: StepFile } => {
  const out = queryData<IfcData>(doc, 'export_ifc', { timestamp: stamp, schema: 'IFC4X3_ADD2', ...(plant === undefined ? {} : { plant }) });
  return { out, file: readStep(out.ifc) };
};
const ofType = (file: StepFile, type: string): StepEntity[] => [...file.entities.values()].filter((entity) => entity.type === type);
const firstRef = (value: unknown): number => stepReferences([value as string])[0] as number;
const joined = (value: unknown): string => (value as string[]).join(' ');

describe('class mapping to IFC4X3_ADD2 products', () => {
  it('maps a valve class to IfcValve ISOLATING and a column to IfcTank USERDEFINED with ObjectType COLUMN', () => {
    const valve = addEquipment(libraryDocument(), { name: 'Block valve', mark: 'XV-1' });
    const column = addEquipment(valve.doc, { name: 'Tower', mark: 'C-1', location: [4000, 0] });
    let doc = apply(column.doc, 'assign_plant_object', {
      target: valve.id,
      className: 'IsolationValve',
      hierarchy: 'U10',
      tagFields: { valveCode: 'XV', seq: 1001 },
    });
    doc = apply(doc, 'assign_plant_object', {
      target: column.id,
      className: 'Column',
      hierarchy: 'U10',
      nextSequence: true,
      properties: { Description: 'Tower', DesignPressure: 2 },
    });
    const { out, file } = exportX3(doc);
    expect(file.errors).toEqual([]);
    const [valveEntity] = ofType(file, 'IFCVALVE');
    expect(valveEntity?.args).toHaveLength(9);
    expect(valveEntity?.args[8]).toBe('.ISOLATING.');
    expect(stepString(valveEntity?.args[7])).toBe('XV-1001');
    const towers = ofType(file, 'IFCTANK');
    expect(towers).toHaveLength(1);
    expect(towers[0]?.args[8]).toBe('.USERDEFINED.');
    expect(stepString(towers[0]?.args[4])).toBe('COLUMN');
    expect(out.predefinedTypes).toEqual({ IfcTank: { USERDEFINED: 1 }, IfcValve: { ISOLATING: 1 } });
    expect(out.proxies).toEqual([]);
  });

  it('exports unclassified equipment and unmapped classes as proxies, the second with a DAT_IFC_MAPPING_MISSING warning', () => {
    const first = addEquipment(libraryDocument(), { name: 'Skid', mark: 'SK-1' });
    const second = addEquipment(first.doc, { name: 'Mixer', mark: 'M-1', location: [4000, 0] });
    let doc = apply(second.doc, 'define_plant_class', { name: 'Mixer', parent: 'Equipment', classCode: 'M' });
    doc = apply(doc, 'assign_plant_object', {
      target: second.id,
      className: 'Mixer',
      hierarchy: 'U10',
      nextSequence: true,
      properties: { Description: 'Mixer', DesignPressure: 1 },
    });
    const { out, file } = exportX3(doc);
    expect(file.errors).toEqual([]);
    expect(ofType(file, 'IFCBUILDINGELEMENTPROXY')).toHaveLength(2);
    expect(out.proxies.map((proxy) => proxy.id)).toEqual([first.id, second.id]);
    expect(out.proxies[0]?.reason).toContain('no plant object');
    expect(out.proxies[1]?.reason).toContain('DAT_IFC_MAPPING_MISSING');
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]?.code).toBe('DAT_IFC_MAPPING_MISSING');
    expect(out.warnings[0]?.message).toContain('Mixer');
    expect(out.predefinedTypes).toEqual({ IfcBuildingElementProxy: { ELEMENT: 2 } });
  });

  it('fills the template property set of the class mapping through propertyMap and flags unverified values', () => {
    const pump = addEquipment(libraryDocument(), { name: 'Pump', mark: 'P-9' });
    let doc = apply(pump.doc, 'define_plant_class', {
      name: 'MeteringPump',
      parent: 'CentrifugalPump',
      classCode: 'P',
      ifc: {
        entity: 'IfcPump',
        predefinedType: 'ENDSUCTION',
        pset: 'Pset_PumpTypeCommon',
        propertyMap: { FlowRate: 'FlowRateRange', Service: 'Service' },
      },
    });
    doc = apply(doc, 'assign_plant_object', {
      target: pump.id,
      className: 'MeteringPump',
      hierarchy: 'U10',
      nextSequence: true,
      properties: { Description: 'Dosing', DesignPressure: 10, FlowRate: 36, Service: 'acid', DesignTemperature: 80 },
      provenance: { DesignPressure: { source: 'agent', unverified: true } },
    });
    const { file } = exportX3(doc);
    const sets = new Map(ofType(file, 'IFCPROPERTYSET').map((set) => [stepString(set.args[2]), set]));
    const valuesOf = (name: string): StepEntity[] =>
      stepReferences(sets.get(name)?.args[4] as string[]).map((id) => file.entities.get(id) as StepEntity);
    const template = valuesOf('Pset_PumpTypeCommon');
    expect(template.map((value) => stepString(value.args[0])).sort()).toEqual(['FlowRateRange', 'Service']);
    expect(joined(template.find((value) => stepString(value.args[0]) === 'FlowRateRange')?.args[2])).toBe(
      'IFCVOLUMETRICFLOWRATEMEASURE 0.01',
    );
    const plant = valuesOf('Pset_llullPlant');
    expect(plant.map((value) => stepString(value.args[0]))).toEqual(
      expect.arrayContaining([
        'ClassName',
        'HierarchyPath',
        'DesignTemperature',
        'Unverified',
        'UnverifiedProperties',
        'Level',
        'LevelElevation',
      ]),
    );
    expect(joined(plant.find((value) => stepString(value.args[0]) === 'DesignTemperature')?.args[2])).toBe(
      'IFCTHERMODYNAMICTEMPERATUREMEASURE 353.15',
    );
    expect(joined(plant.find((value) => stepString(value.args[0]) === 'Unverified')?.args[2])).toBe('IFCBOOLEAN .T.');
  });
});

describe('hierarchy shapes', () => {
  it('aggregates two plants under one site and the unit under its plant', () => {
    const { out, file } = exportX3(libraryDocument());
    expect(file.errors).toEqual([]);
    expect(out.counts['IfcFacility']).toBe(2);
    expect(out.counts['IfcFacilityPartCommon']).toBe(1);
    expect(out.counts['IfcSite']).toBe(1);
  });

  it('uses the default site when the hierarchy has none, and skips levels the hierarchy skips', () => {
    const full = libraryDocument();
    const data = getPlantData(full);
    const siteId = data.hierarchyOrder.find((id) => data.hierarchy[id]?.kind === 'site') as string;
    const rootless = Object.fromEntries(
      Object.entries(data.hierarchy)
        .filter(([id]) => id !== siteId)
        .map(([id, node]) => [id, { ...node, parentId: node.parentId === siteId ? null : node.parentId }]),
    );
    let doc = withPlantData(full, { ...data, hierarchy: rootless, hierarchyOrder: data.hierarchyOrder.filter((id) => id !== siteId) });
    const lonely = exportX3(doc);
    const [site] = ofType(lonely.file, 'IFCSITE');
    expect(stepString(site?.args[2])).toBe('Site');
    expect(lonely.out.counts['IfcFacility']).toBe(2);
    expect(ofType(lonely.file, 'IFCRELAGGREGATES').map((rel) => firstRef(rel.args[4]))).toContain(site?.id);
    doc = apply(doc, 'define_plant_hierarchy', {
      replace: true,
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'A1', kind: 'area', parent: 'S1' },
        { code: 'SYS', kind: 'system', parent: 'A1' },
      ],
    });
    const skipped = exportX3(doc);
    expect(skipped.file.errors).toEqual([]);
    expect(skipped.out.counts['IfcFacilityPartCommon']).toBe(1);
    expect(stepString(ofType(skipped.file, 'IFCFACILITYPARTCOMMON')[0]?.args[4])).toBe('AREA');
  });

  it('contains an object of a system node in its nearest spatial ancestor', () => {
    const pump = addEquipment(libraryDocument(), { name: 'Pump', mark: 'P-9' });
    let doc = apply(pump.doc, 'define_plant_hierarchy', {
      replace: true,
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'P1', kind: 'plant', parent: 'S1' },
        { code: 'U10', kind: 'unit', parent: 'P1', properties: { areaNumber: '1' } },
        { code: 'SYS1', kind: 'system', parent: 'U10' },
      ],
    });
    doc = apply(doc, 'assign_plant_object', {
      target: pump.id,
      className: 'CentrifugalPump',
      hierarchy: 'SYS1',
      nextSequence: true,
      properties: { Description: 'Pump', DesignPressure: 4 },
    });
    const { file } = exportX3(doc);
    const [unit] = ofType(file, 'IFCFACILITYPARTCOMMON');
    const contained = ofType(file, 'IFCRELCONTAINEDINSPATIALSTRUCTURE').find((rel) => firstRef(rel.args[5]) === unit?.id);
    expect(stepReferences(contained?.args[4] as string[])).toHaveLength(1);
  });
});

describe('pipes and flow directions', () => {
  it('decomposes a pipe without a plant object (no system) and skips duplicate points', () => {
    const pipe = addPipe(libraryDocument(), { dn: 50, line: 'L-1' });
    const building = pipe.doc.building as NonNullable<CadDocument['building']>;
    const element = building.elements[pipe.id];
    if (element?.category !== 'pipe') throw new Error('no pipe');
    const doubled = {
      ...pipe.doc,
      building: {
        ...building,
        elements: { ...building.elements, [pipe.id]: { ...element, points: [element.points[0], ...element.points] } },
      },
    } as CadDocument;
    const { out, file } = exportX3(doubled);
    expect(file.errors).toEqual([]);
    expect(out.counts['IfcPipeSegment']).toBe(1);
    expect(out.counts['IfcPipeFitting']).toBe(0);
    expect(out.counts['IfcDistributionSystem']).toBe(0);
    expect(out.ports).toBe(2);
    expect(out.openPorts).toBe(2);
    expect(stepString(ofType(file, 'IFCPIPESEGMENT')[0]?.args[2])).toMatch(/-S1$/);
  });

  it('writes SOURCEANDSINK ports for a bidirectional line and keeps the route order of the connections', () => {
    let doc = apply(libraryDocument(), 'define_plant_class', {
      name: 'TwoWayLine',
      parent: 'ProcessLine',
      properties: [{ name: 'bidirectional', type: 'boolean' }],
    });
    const pipe = addPipe(doc, {
      points: [
        [0, 0, 400],
        [1000, 0, 400],
        [1000, 1000, 400],
      ],
      dn: 100,
    });
    doc = apply(pipe.doc, 'assign_plant_object', {
      target: pipe.id,
      className: 'TwoWayLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 100, fluidCode: 'P', seq: 7, spec: 'A1A' },
      properties: { bidirectional: true },
    });
    const { out, file } = exportX3(doc);
    expect(out.connections).toBe(2);
    expect(new Set(ofType(file, 'IFCDISTRIBUTIONPORT').map((port) => port.args[7]))).toEqual(new Set(['.SOURCEANDSINK.']));
    const first = ofType(file, 'IFCRELCONNECTSPORTS')[0];
    expect(stepString(file.entities.get(firstRef(first?.args[4]))?.args[2])).toBe('Out');
  });

  it('picks the system type from the ifcSystemType property of the line', () => {
    let doc = apply(libraryDocument(), 'define_plant_class', {
      name: 'AirLine',
      parent: 'ProcessLine',
      properties: [{ name: 'ifcSystemType', type: 'text' }],
    });
    const pipe = addPipe(doc, { dn: 50 });
    doc = apply(pipe.doc, 'assign_plant_object', {
      target: pipe.id,
      className: 'AirLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 50, fluidCode: 'A', seq: 1, spec: 'A1A' },
      properties: { ifcSystemType: 'compressedair' },
    });
    const [system] = ofType(exportX3(doc).file, 'IFCDISTRIBUTIONSYSTEM');
    expect(system?.args[6]).toBe('.COMPRESSEDAIR.');
    expect(system?.args[4]).toBe('$');
  });

  it('puts the pipe of a member object in the system of the line it belongs to', () => {
    const base = apply(libraryDocument(), 'define_plant_class', { name: 'Branch' });
    const main = addPipe(base, { dn: 100, line: '100-P-1-A1A' });
    const branch = addPipe(main.doc, {
      dn: 50,
      points: [
        [0, 500, 400],
        [1000, 500, 400],
      ],
      line: '100-P-1-A1A',
    });
    let doc = apply(branch.doc, 'assign_plant_object', {
      target: main.id,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 100, fluidCode: 'P', seq: 1, spec: 'A1A' },
    });
    const lineId = getPlantData(doc).objectOrder[0] as string;
    doc = apply(doc, 'assign_plant_object', { target: branch.id, className: 'Branch', hierarchy: 'U10', tag: 'BR-2' });
    const data = getPlantData(doc);
    const branchId = data.objectOrder.at(-1) as string;
    const branchObject = data.objects[branchId] as NonNullable<(typeof data.objects)[string]>;
    const linked = withPlantData(doc, { ...data, objects: { ...data.objects, [branchId]: { ...branchObject, lineId } } });
    const { out, file } = exportX3(linked);
    expect(file.errors).toEqual([]);
    expect(out.counts['IfcPipeSegment']).toBe(2);
    expect(out.counts['IfcDistributionSystem']).toBe(1);
    expect(ofType(file, 'IFCRELASSIGNSTOGROUP').map((rel) => stepReferences(rel.args[4] as string[]).length)).toEqual([2]);
  });
});

describe('typed property values in the plant property set', () => {
  it('writes every property type in the IFC unit of its measure (Pa gauge / absolute, K, kg, mm, kg/s, m3/s)', () => {
    const equipment = addEquipment(libraryDocument(), { name: 'Skid', mark: 'SK-1' });
    let doc = apply(equipment.doc, 'define_plant_class', {
      name: 'Skid',
      parent: 'Equipment',
      classCode: 'S',
      ifc: { entity: 'IfcTank', predefinedType: 'VESSEL' },
      properties: [
        { name: 'Count', type: 'integer' },
        { name: 'Ratio', type: 'real' },
        { name: 'Armed', type: 'boolean' },
        { name: 'Mode', type: 'enum', enumValues: ['AUTO', 'MANUAL'] },
        { name: 'Span', type: 'length', unit: 'm' },
        { name: 'Feed', type: 'massFlow', unit: 'kg/h' },
        { name: 'Intake', type: 'volumetricFlow', unit: 'm3/h' },
        { name: 'Vacuum', type: 'pressure', unit: 'bara' },
        { name: 'Empty', type: 'real' },
      ],
    });
    doc = apply(doc, 'assign_plant_object', {
      target: equipment.id,
      className: 'Skid',
      hierarchy: 'U10',
      nextSequence: true,
      properties: {
        Description: 'Skid',
        DesignPressure: 1,
        Count: 3,
        Ratio: 0.5,
        Armed: true,
        Mode: 'AUTO',
        Span: 2,
        Feed: 3600,
        Intake: 36,
        Vacuum: 1.5,
        Empty: null,
      },
    });
    const { file } = exportX3(doc);
    const written = new Map(
      ofType(file, 'IFCPROPERTYSINGLEVALUE').map((value) => [
        stepString(value.args[0]),
        [stepString(value.args[1]), joined(value.args[2])],
      ]),
    );
    expect(written.get('Count')).toEqual(['Count', 'IFCINTEGER 3']);
    expect(written.get('Ratio')).toEqual(['Ratio', 'IFCREAL 0.5']);
    expect(written.get('Armed')).toEqual(['Armed', 'IFCBOOLEAN .T.']);
    expect(written.get('Mode')).toEqual(['Mode', "IFCLABEL 'AUTO'"]);
    expect(written.get('Span')).toEqual(['Span (mm)', 'IFCLENGTHMEASURE 2000.']);
    expect(written.get('Feed')).toEqual(['Feed (kg/s)', 'IFCMASSFLOWRATEMEASURE 1.']);
    expect(written.get('Intake')).toEqual(['Intake (m3/s)', 'IFCVOLUMETRICFLOWRATEMEASURE 0.01']);
    expect(written.get('Vacuum')).toEqual(['Vacuum (Pa, absolute)', 'IFCPRESSUREMEASURE 150000.']);
    expect(written.get('DesignPressure')).toEqual(['Design pressure (Pa, gauge)', 'IFCPRESSUREMEASURE 100000.']);
    expect(written.has('Empty')).toBe(false);
  });
});
