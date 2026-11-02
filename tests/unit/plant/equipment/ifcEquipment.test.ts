/**
 * Plant 03 EQP M5 (VC-EQP-20, FR-EQP-18): `export_ifc` of parametric equipment read back with `@lib/stepRead`: one IfcTank (PRESSUREVESSEL) with
 * the revolved body, one IfcDistributionPort per nozzle (names, FlowDirection from the service, placement = the port frame at the 3D position), nested in the
 * product; the pipes routed to the nozzles meet their ports (IfcRelConnectsPorts); IFC4 and IFC4X3_ADD2; determinism.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { readStep, stepReferences, stepString, type StepEntity, type StepFile } from '@lib/stepRead';
import { StepWriter, ifcGuid, type Context } from '@aec/building/exchange/ifcStep';
import { bodyOfEntities, nozzleFlow } from '@aec/building/exchange/ifcEquipmentExport';
import { apply, data } from '../../../helpers/commandAssertions';
import { globalIdProblems } from '../../../production/oracle/ifc';
import { routedPumpToVessel } from '../piping/rteFixtures';
import { drumDocument, separatorDocument, tankDocument } from './equipmentFixtures';

interface IfcData {
  ifc: string;
  ports: number;
  openPorts: number;
  predefinedTypes: Record<string, Record<string, number>>;
  warnings: Array<{ code: string; id: string }>;
  piping: { connectionCount: number };
}

const stamp = '2026-11-02T00:00:00';
const exportIfc = (doc: CadDocument, params: Record<string, unknown> = {}): IfcData =>
  data<IfcData>(doc, 'export_ifc', { timestamp: stamp, ...params });
const ofType = (file: StepFile, type: string): StepEntity[] => [...file.entities.values()].filter((entity) => entity.type === type);
const refOf = (value: unknown): number => stepReferences([value as string])[0] as number;
const numbers = (text: string): number[] => [...text.matchAll(/-?\d+\.?\d*(?:E-?\d+)?/g)].map((match) => Number(match[0]));

/** SC-EQP-01 with V-101 classified PressureVessel (IfcTank PRESSUREVESSEL in the default process library). */
function classified(): CadDocument {
  let doc = apply(separatorDocument(), 'define_plant_hierarchy', {
    nodes: [
      { code: 'S1', kind: 'site' },
      { code: 'P1', kind: 'plant', parent: 'S1' },
      { code: 'U10', kind: 'unit', parent: 'P1', properties: { areaNumber: '1' } },
    ],
  });
  doc = apply(doc, 'load_plant_class_library', { library: 'llull-default-process' });
  const target = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment')?.id;
  return apply(doc, 'assign_plant_object', {
    target,
    className: 'PressureVessel',
    hierarchy: 'U10',
    tag: 'V-101',
    properties: { Description: 'HP separator', DesignPressure: 10 },
  });
}

/** Volume (mm3) of the solid of revolution of the polygon of an IfcIndexedPolyCurve profile (line segments), by Pappus. */
function pappusVolume(file: StepFile, solid: StepEntity): number {
  const profile = file.entities.get(refOf(solid.args[0]));
  const curve = file.entities.get(refOf(profile?.args[2]));
  const list = file.entities.get(refOf(curve?.args[0]));
  const points = (list?.args[0] as string[][]).map((pair) => pair.map(Number) as [number, number]);
  const polygon: Array<[number, number]> = [];
  for (const segment of curve?.args[1] as string[][]) {
    const indices = (segment[1] as unknown as string[]).map((index) => Number(index) - 1);
    expect(segment[0], 'only line segments in this profile').toBe('IFCLINEINDEX');
    for (const index of indices) polygon.push(points[index] as [number, number]);
  }
  let [area, moment] = [0, 0];
  polygon.forEach(([x1, y1], index) => {
    const [x2, y2] = polygon[(index + 1) % polygon.length] as [number, number];
    const cross = x1 * y2 - x2 * y1;
    area += cross / 2;
    moment += ((x1 + x2) * cross) / 6;
  });
  return Math.abs(2 * Math.PI * moment);
}

describe('export_ifc IFC4X3_ADD2 of SC-EQP-01 (VC-EQP-20)', () => {
  const doc = classified();
  const out = exportIfc(doc, { schema: 'IFC4X3_ADD2' });
  const file = readStep(out.ifc);

  it('writes one IfcTank PRESSUREVESSEL and the four distribution ports N1, N2, N3, M1', () => {
    expect(file.errors).toEqual([]);
    expect(ofType(file, 'IFCTANK')).toHaveLength(1);
    expect(ofType(file, 'IFCTANK')[0]?.args[8]).toBe('.PRESSUREVESSEL.');
    expect(out.predefinedTypes['IfcTank']).toEqual({ PRESSUREVESSEL: 1 });
    const ports = ofType(file, 'IFCDISTRIBUTIONPORT');
    expect(ports.map((port) => stepString(port.args[2]))).toEqual(['N1', 'N2', 'N3', 'M1']);
    expect(out.ports).toBe(4);
    expect(out.openPorts).toBe(4);
    expect(globalIdProblems(file)).toEqual({ malformed: [], duplicated: [] });
  });

  it('nests the ports in the tank and takes FlowDirection from the service (inlet SINK, outlets SOURCE, manway both ways)', () => {
    const [tank] = ofType(file, 'IFCTANK');
    const nests = ofType(file, 'IFCRELNESTS').find((rel) => refOf(rel.args[4]) === tank?.id);
    const ports = new Map(ofType(file, 'IFCDISTRIBUTIONPORT').map((port) => [port.id, port]));
    expect(stepReferences(nests?.args[5] as string[]).sort()).toEqual([...ports.keys()].sort());
    const flow = Object.fromEntries([...ports.values()].map((port) => [stepString(port.args[2]), port.args[7]]));
    expect(flow).toEqual({ N1: '.SINK.', N2: '.SOURCE.', N3: '.SOURCE.', M1: '.SOURCEANDSINK.' });
    expect(stepString(ports.get(stepReferences(nests?.args[5] as string[])[0] as number)?.args[3])).toBe('V-101:N1 DN150 CL150 RF inlet');
  });

  it('places each port at the flange face of the 3D model with Z along the outward direction (N1 at [5000, 6000, 5200] facing +Y, N2 below the skirt-supported bottom head)', () => {
    const port = (name: string): StepEntity =>
      ofType(file, 'IFCDISTRIBUTIONPORT').find((entry) => stepString(entry.args[2]) === name) as StepEntity;
    const frame = (name: string): { origin: number[]; axis: number[] } => {
      const placement = file.entities.get(refOf(port(name).args[5]));
      const axes = file.entities.get(refOf(placement?.args[1]));
      const point = file.entities.get(refOf(axes?.args[0]));
      const axis = file.entities.get(refOf(axes?.args[1]));
      return { origin: (point?.args[0] as string[]).map(Number), axis: (axis?.args[0] as string[]).map(Number) };
    };
    expect(frame('N1')).toEqual({ origin: [5000, 6000, 5200], axis: [0, 1, 0] });
    expect(frame('N2')).toEqual({ origin: [5000, 5000, 1400], axis: [0, 0, -1] });
    expect(frame('N3')).toEqual({ origin: [5000, 5000, 6700], axis: [0, 0, 1] });
    expect(frame('M1')).toEqual({ origin: [5000, 4000, 3000], axis: [0, -1, 0] });
  });

  it('draws the body as IfcRevolvedAreaSolid (shell + heads, skirt, 4 nozzles) instead of an extruded circle, with the metal volume of the 3D model', () => {
    const solids = ofType(file, 'IFCREVOLVEDAREASOLID');
    expect(solids).toHaveLength(6);
    expect(ofType(file, 'IFCEXTRUDEDAREASOLID')).toHaveLength(0);
    expect(solids.every((solid) => Math.abs(Number(solid.args[3]) - 2 * Math.PI) < 1e-5)).toBe(true);
    const metalKg = (execute(doc, 'equipment_weights', { equipment: 'V-101' }).data as { breakdown: Array<{ part: string; kg: number }> })
      .breakdown;
    const wallKg = metalKg.filter((line) => ['shell', 'headBottom', 'headTop'].includes(line.part)).reduce((sum, line) => sum + line.kg, 0);
    const expectedMm3 = (wallKg / 7850) * 1e9;
    expect(Math.abs(pappusVolume(file, solids[0] as StepEntity) / expectedMm3 - 1)).toBeLessThan(1e-3);
  });

  it('adds template, design and weights to Pset_llullEquipment and states how the body is represented', () => {
    const properties = ofType(file, 'IFCPROPERTYSINGLEVALUE').map((property) => stepString(property.args[0]));
    for (const name of [
      'Template',
      'Orientation',
      'DesignPressure',
      'DesignTemperature',
      'Material',
      'EmptyWeight',
      'TestWeight',
      'BodyRepresentation',
    ])
      expect(properties, name).toContain(name);
    const pressure = ofType(file, 'IFCPROPERTYSINGLEVALUE').find((property) => stepString(property.args[0]) === 'DesignPressure');
    expect(numbers(String((pressure?.args[2] as string[])[1]))[0]).toBe(1_000_000);
    const note = ofType(file, 'IFCPROPERTYSINGLEVALUE').find((property) => stepString(property.args[0]) === 'BodyRepresentation');
    expect(stepString((note?.args[2] as string[])[1])).toMatch(/sampled as polylines/);
  });

  it('is byte-identical for the same document and honours plant.ports false (body kept, no ports)', () => {
    expect(exportIfc(doc, { schema: 'IFC4X3_ADD2' }).ifc).toBe(out.ifc);
    const bare = exportIfc(doc, { schema: 'IFC4X3_ADD2', plant: { ports: false, systems: 'none', hierarchy: false } });
    expect(bare.ports).toBe(0);
    expect(ofType(readStep(bare.ifc), 'IFCDISTRIBUTIONPORT')).toHaveLength(0);
    expect(ofType(readStep(bare.ifc), 'IFCREVOLVEDAREASOLID')).toHaveLength(6);
  });
});

describe('export_ifc IFC4 (default) of parametric equipment', () => {
  it('writes the revolved body and the ports as IfcBuildingElementProxy children (one point list attribute in IFC4)', () => {
    const out = exportIfc(separatorDocument());
    const file = readStep(out.ifc);
    expect(file.schema).toBe('IFC4');
    expect(file.errors).toEqual([]);
    expect(ofType(file, 'IFCBUILDINGELEMENTPROXY')).toHaveLength(1);
    expect(ofType(file, 'IFCDISTRIBUTIONPORT')).toHaveLength(4);
    const lists = ofType(file, 'IFCCARTESIANPOINTLIST2D');
    expect(lists.length).toBe(6);
    expect(lists.every((list) => list.args.length === 1)).toBe(true);
    expect(ofType(readStep(exportIfc(classified(), { schema: 'IFC4X3_ADD2' }).ifc), 'IFCCARTESIANPOINTLIST2D')[0]?.args).toHaveLength(2);
  });

  it('exports a horizontal drum on saddles: revolved body, 2 saddle blocks as extruded rectangles, 4 ports; an arc-headed vessel keeps exact IfcArcIndex segments', () => {
    const file = readStep(exportIfc(drumDocument()).ifc);
    expect(ofType(file, 'IFCEXTRUDEDAREASOLID')).toHaveLength(2);
    expect(ofType(file, 'IFCDISTRIBUTIONPORT')).toHaveLength(4);
    const torispherical = apply(drumDocument(false), 'update_equipment_parameters', {
      equipment: 'D-201',
      set: { heads: { left: { type: 'torispherical', standard: 'asme_fd' }, right: { type: 'hemispherical' } } },
    });
    const text = exportIfc(torispherical).ifc;
    expect(text).toMatch(/IFCARCINDEX\(\(\d+,\d+,\d+\)\)/);
    expect(ofType(readStep(text), 'IFCREVOLVEDAREASOLID').length).toBeGreaterThanOrEqual(1);
  });

  it('exports a tank (API 650) with its shell courses as revolved parts and no ports without nozzles', () => {
    const file = readStep(exportIfc(tankDocument()).ifc);
    expect(ofType(file, 'IFCREVOLVEDAREASOLID').length).toBeGreaterThanOrEqual(1);
    expect(ofType(file, 'IFCDISTRIBUTIONPORT')).toHaveLength(0);
  });
});

describe('export_ifc connects the pipes routed to equipment nozzles (02 RTE)', () => {
  const { doc } = routedPumpToVessel();
  const out = exportIfc(doc, { schema: 'IFC4X3_ADD2', plant: { ports: true } });
  const file = readStep(out.ifc);
  const named = (name: string): StepEntity =>
    ofType(file, 'IFCDISTRIBUTIONPORT').find((port) => stepString(port.args[2]) === name) as StepEntity;

  it('relates the nozzle port N2 of the pump block and N1 of the vessel to a port of the first and last pipe part', () => {
    const connections = ofType(file, 'IFCRELCONNECTSPORTS');
    const nozzleLinks = connections.filter((rel) => [named('N1').id, named('N2').id].includes(refOf(rel.args[4])));
    expect(nozzleLinks).toHaveLength(2);
    const owner = (portId: number): StepEntity | undefined => {
      const nest = ofType(file, 'IFCRELNESTS').find((rel) => stepReferences(rel.args[5] as string[]).includes(portId));
      return file.entities.get(refOf(nest?.args[4]));
    };
    for (const rel of nozzleLinks) expect(['IFCPIPESEGMENT', 'IFCPIPEFITTING']).toContain(owner(refOf(rel.args[5]))?.type);
    expect(out.piping.connectionCount).toBeGreaterThanOrEqual(2);
    expect(out.openPorts).toBe(0);
  });

  it('leaves a nozzle port open when no pipe is routed to it', () => {
    const open = exportIfc(separatorDocument(), { schema: 'IFC4X3_ADD2', plant: { ports: true } });
    expect(open.openPorts).toBe(4);
  });
});

describe('nozzleFlow and bodyOfEntities', () => {
  it('reads a pump by role and other nozzles by the words of the service', () => {
    expect(nozzleFlow('SUC', undefined)).toBe('SINK');
    expect(nozzleFlow('DIS', 'anything')).toBe('SOURCE');
    expect(nozzleFlow('N1', 'Feed inlet')).toBe('SINK');
    expect(nozzleFlow('N2', 'bottoms product')).toBe('SOURCE');
    expect(nozzleFlow('N3', 'inlet / outlet')).toBe('SOURCEANDSINK');
    expect(nozzleFlow('M1', 'manway')).toBe('SOURCEANDSINK');
    expect(nozzleFlow('N4', undefined)).toBe('SOURCEANDSINK');
  });

  const writer = new StepWriter();
  const context: Context = { writer, guid: ifcGuid, mm: (value) => value, body: '#1', zAxis: '#2', xAxis: '#3' };
  const element = { location: [0, 0], angle: 0 } as unknown as EquipmentElement;
  const level = { elevation: 0 } as BuildingLevel;
  const base = { id: 'e:part', position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'l', tags: [] } as const;

  it('keeps an entity that has no IFC solid as a skipped part (a sphere), and writes a revolution about Y with the mirrored handedness', () => {
    const body = bodyOfEntities(
      context,
      element,
      level,
      [
        { ...base, id: 'e:ball', kind: 'sphere', radius: 1 } as never,
        {
          ...base,
          id: 'e:ring',
          kind: 'revolution',
          profile: [
            [1, 0],
            [2, 0],
            [2, 1],
          ],
          axis: [0, 1, 0],
          angle: Math.PI,
          segments: 8,
        } as never,
      ],
      false,
    );
    expect(body.skipped).toEqual([{ part: 'e:ball', kind: 'sphere' }]);
    expect(body.solids).toHaveLength(1);
    expect(writer.data()).toMatch(/IFCREVOLVEDAREASOLID\(#\d+,#\d+,#\d+,3\.141593\)/);
    expect(writer.data()).toContain('IFCCARTESIANPOINTLIST2D(((1.,0.),(2.,0.),(2.,-1.)))');
  });
});
