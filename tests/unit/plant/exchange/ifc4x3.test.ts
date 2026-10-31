/**
 * Plant 08 DAT-M3 (VC-DAT-06, 07, 08, 11): `export_ifc` with `schema: 'IFC4X3_ADD2'` on the SC-DAT-01 scene, read back with `@lib/stepRead`: schema header,
 * closed STEP graph, class mapping and PredefinedTypes, USERDEFINED => ObjectType, hierarchy, ports / nests / SOURCE -> SINK connections, systems, units,
 * property sets; the IFC4 export of the same document unchanged except the Tag of classified products; determinism and replay.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { readStep, stepReferences, stepString, type StepEntity, type StepFile } from '@lib/stepRead';
import { globalIdProblems } from '../../../production/oracle/ifc';
import { apply, data as queryData } from '../../../helpers/commandAssertions';
import { packJson } from '../data/dataFixtures';
import { referenceIfc, scDat01, stamp } from './ifcFixtures';

interface IfcData {
  ifc: string;
  schema: string;
  counts: Record<string, number>;
  predefinedTypes: Record<string, Record<string, number>>;
  ports: number;
  connections: number;
  openPorts: number;
  proxies: Array<{ id: string; reason: string }>;
  warnings: Array<{ code: string; id: string; message: string }>;
}

const exportIfc = (doc: CadDocument, params: Record<string, unknown> = {}): IfcData =>
  queryData<IfcData>(doc, 'export_ifc', { timestamp: stamp, ...params });

const ofType = (file: StepFile, type: string): StepEntity[] => [...file.entities.values()].filter((entity) => entity.type === type);
const refOf = (value: unknown): number => stepReferences([value as string])[0] as number;
const countsOf = (file: StepFile): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const entity of file.entities.values()) counts[entity.type] = (counts[entity.type] ?? 0) + 1;
  return counts;
};

describe('export_ifc IFC4X3_ADD2 on SC-DAT-01', () => {
  const doc = scDat01();
  const out = exportIfc(doc, { schema: 'IFC4X3_ADD2' });
  const file = readStep(out.ifc);
  const stats = packJson<{
    counts: Record<string, number>;
    predefinedTypes: Record<string, number>;
    systemMembers: Record<string, number>;
    openPorts: number;
    ports: number;
  }>('data/reference/sc-dat-01-reference.stats.json');

  it('writes the 4.3 header and a closed, well-formed STEP graph with unique GlobalIds', () => {
    expect(out.schema).toBe('IFC4X3_ADD2');
    expect(file.schema).toBe('IFC4X3_ADD2');
    expect(out.ifc).toContain("FILE_SCHEMA(('IFC4X3_ADD2'));");
    expect(file.errors).toEqual([]);
    const problems = globalIdProblems(file);
    expect(problems).toEqual({ malformed: [], duplicated: [] });
  });

  it('matches the entity counts of the IfcOpenShell reference file (VC-DAT-07)', () => {
    const counts = countsOf(file);
    for (const [name, expected] of Object.entries(stats.counts)) {
      if (name === 'IfcBuildingStorey' || name === 'IfcPropertySet' || name === 'IfcRelDefinesByProperties' || name === 'IfcRelAggregates')
        continue;
      expect(counts[name.toUpperCase()] ?? 0, name).toBe(expected);
      expect(out.counts[name], `data.counts.${name}`).toBe(expected);
    }
    expect(out.predefinedTypes).toEqual({
      IfcPipeFitting: { BEND: 3 },
      IfcPipeSegment: { RIGIDSEGMENT: 5 },
      IfcPump: { ENDSUCTION: 1 },
      IfcTank: { STORAGE: 1 },
    });
    expect(Object.keys(stats.predefinedTypes).sort()).toEqual([
      'IfcPipeFitting.BEND',
      'IfcPipeSegment.RIGIDSEGMENT',
      'IfcPump.ENDSUCTION',
      'IfcTank.STORAGE',
    ]);
  });

  it('writes the class entity, PredefinedType, Tag and Name of each classified product', () => {
    const [tank] = ofType(file, 'IFCTANK');
    const [pump] = ofType(file, 'IFCPUMP');
    expect(stepString(tank?.args[2])).toBe('T-101');
    expect(stepString(tank?.args[7])).toBe('T-101');
    expect(tank?.args[8]).toBe('.STORAGE.');
    expect(stepString(pump?.args[7])).toBe('P-101');
    expect(pump?.args[8]).toBe('.ENDSUCTION.');
    expect(stepString(tank?.args[3])).toBe('Tank - Feed tank');
  });

  it('sets ObjectType on every USERDEFINED product (EXPRESS rule CorrectPredefinedType)', () => {
    const typed = [...file.entities.values()].filter((entity) =>
      /^IFC(TANK|PUMP|VALVE|PIPESEGMENT|PIPEFITTING|DISTRIBUTIONSYSTEM)$/.test(entity.type),
    );
    expect(typed.length).toBeGreaterThan(0);
    for (const entity of typed) {
      if (entity.args.at(-1) === '.USERDEFINED.') expect(stepString(entity.args[4]), `#${entity.id} ${entity.type}`).not.toBe('');
    }
    const systems = ofType(file, 'IFCDISTRIBUTIONSYSTEM');
    expect(systems.map((system) => [stepString(system.args[2]), stepString(system.args[4]), system.args[6]])).toEqual([
      ['150-P-1001-A1A', 'PIPELINE', '.USERDEFINED.'],
      ['100-P-1002-A1A', 'PIPELINE', '.USERDEFINED.'],
    ]);
  });

  it('writes the hierarchy S1 > P1 > U10 and contains the products in the unit (VC-DAT-07)', () => {
    const site = ofType(file, 'IFCSITE');
    const facility = ofType(file, 'IFCFACILITY');
    const [part] = ofType(file, 'IFCFACILITYPARTCOMMON');
    expect(site).toHaveLength(1);
    expect(stepString(site[0]?.args[2])).toBe('S1');
    expect(stepString(facility[0]?.args[4])).toBe('PROCESSPLANT');
    expect(part?.args.slice(9)).toEqual(['.NOTDEFINED.', '.USERDEFINED.']);
    expect(stepString(part?.args[4])).toBe('UNIT');
    const aggregates = ofType(file, 'IFCRELAGGREGATES').map((rel) => [refOf(rel.args[4]), refOf((rel.args[5] as string[])[0])]);
    expect(aggregates).toContainEqual([facility[0]?.id, part?.id]);
    expect(aggregates).toContainEqual([site[0]?.id, facility[0]?.id]);
    const contained = ofType(file, 'IFCRELCONTAINEDINSPATIALSTRUCTURE').find((rel) => refOf(rel.args[5]) === part?.id);
    expect(stepReferences(contained?.args[4] as string[])).toHaveLength(10);
  });

  it('writes 19 ports, 10 nests, 9 SOURCE -> SINK connections and 1 open port (VC-DAT-08)', () => {
    expect(out.ports).toBe(stats.ports);
    expect(out.connections).toBe(9);
    expect(out.openPorts).toBe(stats.openPorts);
    const ports = new Map(ofType(file, 'IFCDISTRIBUTIONPORT').map((port) => [port.id, port]));
    expect(ports.size).toBe(19);
    const nested = ofType(file, 'IFCRELNESTS').flatMap((rel) => stepReferences(rel.args[5] as string[]));
    expect(nested.sort()).toEqual([...ports.keys()].sort());
    const connections = ofType(file, 'IFCRELCONNECTSPORTS');
    expect(connections).toHaveLength(9);
    for (const rel of connections) {
      expect(ports.get(refOf(rel.args[4]))?.args[7], 'RelatingPort').toBe('.SOURCE.');
      expect(ports.get(refOf(rel.args[5]))?.args[7], 'RelatedPort').toBe('.SINK.');
      expect(refOf(rel.args[4])).not.toBe(refOf(rel.args[5]));
    }
    const connected = new Set(connections.flatMap((rel) => [refOf(rel.args[4]), refOf(rel.args[5])]));
    expect([...ports.keys()].filter((id) => !connected.has(id))).toHaveLength(1);
  });

  it('infers the nozzles of the equipment (tank N1 SOURCE; pump N1 SINK and N2 SOURCE) as the nozzle schedule lists them', () => {
    const named = ofType(file, 'IFCDISTRIBUTIONPORT').filter((port) => stepString(port.args[3]) === 'inferred from line from/to');
    expect(named.map((port) => [stepString(port.args[2]), port.args[7]])).toEqual([
      ['N1', '.SOURCE.'],
      ['N1', '.SINK.'],
      ['N2', '.SOURCE.'],
    ]);
    const schedule = queryData<{ rows: Array<{ equipment: string; nozzle: string; flowDirection: string }> }>(doc, 'plant_report', {
      kind: 'nozzle_schedule',
    });
    const key = (pair: unknown[]): string => pair.join(' ');
    expect(schedule.rows.map((row) => key([row.nozzle, `.${row.flowDirection}.`])).sort()).toEqual(
      named.map((port) => key([stepString(port.args[2]), port.args[7]])).sort(),
    );
  });

  it('groups the segments and bends of each line in its system (5 and 3 members)', () => {
    const groups = ofType(file, 'IFCRELASSIGNSTOGROUP').map(
      (rel) => [refOf(rel.args[6]), stepReferences(rel.args[4] as string[]).length] as const,
    );
    const bySystem = new Map(ofType(file, 'IFCDISTRIBUTIONSYSTEM').map((system) => [system.id, stepString(system.args[2])]));
    expect(Object.fromEntries(groups.map(([system, members]) => [bySystem.get(system), members]))).toEqual(stats.systemMembers);
  });

  it('adds mass, pressure, temperature and flow units and writes pressures in Pa (gauge in the description)', () => {
    expect(ofType(file, 'IFCSIUNIT').map((unit) => unit.args[1])).toEqual([
      '.LENGTHUNIT.',
      '.AREAUNIT.',
      '.VOLUMEUNIT.',
      '.PLANEANGLEUNIT.',
      '.MASSUNIT.',
      '.PRESSUREUNIT.',
      '.THERMODYNAMICTEMPERATUREUNIT.',
      '.TIMEUNIT.',
    ]);
    expect(ofType(file, 'IFCDERIVEDUNIT').map((unit) => unit.args[1])).toEqual(['.VOLUMETRICFLOWRATEUNIT.', '.MASSFLOWRATEUNIT.']);
    const pressure = ofType(file, 'IFCPROPERTYSINGLEVALUE').filter((value) => stepString(value.args[0]) === 'DesignPressure');
    expect(pressure.map((value) => [stepString(value.args[1]), (value.args[2] as string[]).join(' ')])).toEqual([
      ['DesignPressure (Pa, gauge)', 'IFCPRESSUREMEASURE 350000.'],
      ['DesignPressure (Pa, gauge)', 'IFCPRESSUREMEASURE 1600000.'],
    ]);
    const sets = ofType(file, 'IFCPROPERTYSET').map((set) => stepString(set.args[2]));
    expect(sets.filter((name) => name === 'Pset_llullPlant')).toHaveLength(4);
    expect(sets).toContain('Pset_PipeSegmentTypeCommon');
    expect(sets).toContain('Pset_DistributionPortTypePipe');
  });

  it('is deterministic and survives replay_history (VC-DAT-11)', () => {
    expect(exportIfc(doc, { schema: 'IFC4X3_ADD2' }).ifc).toBe(out.ifc);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(exportIfc(replayed, { schema: 'IFC4X3_ADD2' }).ifc).toBe(out.ifc);
  });

  it('does not change the document (is pure)', () => {
    const before = JSON.stringify(doc);
    execute(doc, 'export_ifc', { schema: 'IFC4X3_ADD2' });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('honours the options: ports false, systems none, hierarchy false', () => {
    const bare = exportIfc(doc, { schema: 'IFC4X3_ADD2', plant: { ports: false, systems: 'none', hierarchy: false } });
    const bareFile = readStep(bare.ifc);
    expect(bareFile.errors).toEqual([]);
    expect(bare.counts['IfcDistributionPort']).toBe(0);
    expect(bare.counts['IfcRelConnectsPorts']).toBe(0);
    expect(bare.counts['IfcDistributionSystem']).toBe(0);
    expect(bare.counts['IfcFacility']).toBe(0);
    expect(bare.counts['IfcSite']).toBe(1);
    expect(bare.counts['IfcPipeSegment']).toBe(5);
    expect(bare.ports).toBe(0);
    expect(ofType(bareFile, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')).toHaveLength(1);
  });
});

describe('export_ifc IFC4 (default) on SC-DAT-01', () => {
  const doc = scDat01();

  it('defaults to IFC4 and writes the plant tag in Tag and nothing else', () => {
    const tagged = exportIfc(doc);
    expect(tagged.schema).toBe('IFC4');
    expect(tagged.ifc).toContain("FILE_SCHEMA(('IFC4'));");
    expect(tagged.ifc).toContain('DesignTransferView_V1.0');
    expect(tagged.counts['IfcDistributionPort']).toBe(0);
    const plain = exportIfc({ ...doc, plant: undefined } as unknown as CadDocument);
    const taggedLines = tagged.ifc.split('\n');
    const plainLines = plain.ifc.split('\n');
    expect(taggedLines).toHaveLength(plainLines.length);
    const changed = taggedLines.flatMap(
      (line, index): Array<[string, string]> => (line === plainLines[index] ? [] : [[line, plainLines[index] as string]]),
    );
    expect(changed).toHaveLength(4);
    for (const [after, before] of changed) {
      expect(after).toMatch(/^#\d+=IFC(BUILDINGELEMENTPROXY|PIPESEGMENT)\(/);
      expect(after.replace(/,'[^']*',\.[A-Z]+\.\);$/, '')).toBe(before.replace(/,'[^']*',\.[A-Z]+\.\);$/, ''));
    }
    const tags = changed.map(([after]) => /,'([^']*)',\.[A-Z]+\.\);$/.exec(after)?.[1]);
    expect(tags.map(String).sort()).toEqual(['100-P-1002-A1A', '150-P-1001-A1A', 'P-101', 'T-101']);
  });

  it('is identical with and without the explicit schema, and for a document without plant data', () => {
    const house = apply(apply(createEmptyDocument(), 'add_level', { name: 'L0', elevation: 0, height: 3000 }), 'draw_walls', {
      points: [
        [0, 0],
        [4000, 0],
        [4000, 3000],
      ],
    });
    expect(exportIfc(house, { schema: 'IFC4' }).ifc).toBe(exportIfc(house).ifc);
  });
});

describe('export_ifc IFC4X3_ADD2 without plant data', () => {
  it('writes a valid file with the 4.3 header, units and the default site', () => {
    const house = apply(apply(createEmptyDocument(), 'add_level', { name: 'L0', elevation: 0, height: 3000 }), 'draw_walls', {
      points: [
        [0, 0],
        [4000, 0],
        [4000, 3000],
      ],
    });
    const out = exportIfc(house, { schema: 'IFC4X3_ADD2' });
    const file = readStep(out.ifc);
    expect(file.errors).toEqual([]);
    expect(file.schema).toBe('IFC4X3_ADD2');
    expect(out.counts['IfcFacility']).toBe(0);
    expect(out.counts['IfcSite']).toBe(1);
    expect(stepString(ofType(file, 'IFCSITE')[0]?.args[2])).toBe('Site');
    expect(out.proxies).toEqual([]);
  });

  it('refuses nothing it cannot do: a document without levels and runs is the existing no-op', () => {
    const empty = createEmptyDocument();
    const result = execute(empty, 'export_ifc', { schema: 'IFC4X3_ADD2' });
    expect(result.document).toBe(empty);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('no levels');
  });

  it('rejects an unknown schema value with invalid params', () => {
    const result = execute(scDat01(), 'export_ifc', { schema: 'IFC2X3' });
    expect(result.rejected).toBe(true);
    expect(result.summary).toContain('invalid params');
  });
});

describe('the pack reference file', () => {
  it('reads with stepRead and has the counts the exporter reproduces', () => {
    const reference = readStep(referenceIfc('sc-dat-01-reference.ifc'));
    expect(reference.schema).toBe('IFC4X3_ADD2');
    expect(reference.errors).toEqual([]);
    expect(ofType(reference, 'IFCRELCONNECTSPORTS')).toHaveLength(9);
  });
});
