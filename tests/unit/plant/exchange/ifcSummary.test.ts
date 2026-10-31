/** Plant 08 DAT-M4: `ifc_summary` (VC-DAT-13): the pack reference files and the buildingSMART samples against the IfcOpenShell statistics, hostile text, speed. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { PACK } from '../data/dataFixtures';
import { referenceIfc, scDat01, stamp } from './ifcFixtures';

interface Summary {
  schema: string;
  entityCount: number;
  counts: Record<string, number>;
  predefinedTypes: Record<string, number>;
  systems: Array<{ name: string; predefinedType: string | null; members: number }>;
  ports: number;
  portsNestedInElements: number;
  connections: number;
  physicalConnections: number;
  connectedPorts: number;
  openPorts: number;
  duplicateTags: string[];
  errors: string[];
}
interface Stats {
  schema: string;
  counts: Record<string, number>;
  ports: number;
  portsNestedInElements: number;
  connectedPorts: number;
  openPorts: number;
  predefinedTypes: Record<string, number>;
  duplicateTags: string[];
  systemMembers: Record<string, number>;
}

const doc = createEmptyDocument();
const summary = (ifc: string): Summary => data<Summary>(doc, 'ifc_summary', { ifc });
const stats = (file: string): Stats => JSON.parse(readFileSync(path.join(PACK, 'data/reference', file), 'utf8')) as Stats;

function expectStats(actual: Summary, expected: Stats): void {
  expect(actual.schema).toBe(expected.schema);
  for (const [name, count] of Object.entries(expected.counts)) expect(actual.counts[name] ?? 0, name).toBe(count);
  expect(actual.ports).toBe(expected.ports);
  expect(actual.portsNestedInElements).toBe(expected.portsNestedInElements);
  expect(actual.connectedPorts).toBe(expected.connectedPorts);
  expect(actual.openPorts).toBe(expected.openPorts);
  // the statistics list the distribution FLOW elements; the summary also lists ports, systems and proxies
  const flow = Object.fromEntries(
    Object.entries(actual.predefinedTypes).filter(
      ([key]) => !/^(IfcDistributionPort|IfcDistributionSystem|IfcBuildingElementProxy)./.test(key),
    ),
  );
  expect(flow).toEqual(expected.predefinedTypes);
  expect(actual.duplicateTags).toEqual(expected.duplicateTags);
  expect(Object.fromEntries(actual.systems.map((system) => [system.name, system.members]))).toEqual(expected.systemMembers);
}

describe('ifc_summary against the IfcOpenShell statistics of the pack', () => {
  it.each([
    ['sc-dat-01-reference.ifc', 'sc-dat-01-reference.stats.json'],
    ['sc-dat-02-reference.ifc', 'sc-dat-02-reference.stats.json'],
    ['sc-dat-02-negative.ifc', 'sc-dat-02-negative.stats.json'],
  ])('%s', (ifc, statistics) => {
    const actual = summary(referenceIfc(ifc));
    expectStats(actual, stats(statistics));
    expect(actual.errors).toEqual([]);
  });

  it.each([
    ['IFC4X3_ADD2_Infra-Plumbing.ifc', 24],
    ['IFC4X3_ADD2_Building-Hvac.ifc', 0],
  ])('the buildingSMART sample %s (VC-DAT-13)', (file, segments) => {
    const text = readFileSync(path.join(PACK, 'data/bsi', file), 'utf8');
    const all = JSON.parse(readFileSync(path.join(PACK, 'data/reference/bsi_sample_stats.json'), 'utf8')) as Record<string, Stats>;
    expectStats(summary(text), all[file] as Stats);
    expect(summary(text).counts['IfcPipeSegment'] ?? 0).toBe(segments);
  });

  it('SC-DAT-05 numbers: 26 members in the road wastewater system, the duct and terminals of the HVAC sample', () => {
    const plumbing = summary(readFileSync(path.join(PACK, 'data/bsi/IFC4X3_ADD2_Infra-Plumbing.ifc'), 'utf8'));
    expect(plumbing.systems).toMatchObject([{ name: 'road wastewater system', members: 26 }]);
    const hvac = summary(readFileSync(path.join(PACK, 'data/bsi/IFC4X3_ADD2_Building-Hvac.ifc'), 'utf8'));
    expect(hvac.counts['IfcDuctSegment']).toBe(1);
    expect(hvac.counts['IfcAirTerminal']).toBe(2);
    expect(hvac.systems).toMatchObject([{ name: 'house - chimney flue', predefinedType: 'EXHAUST', members: 3 }]);
  });

  it('a reciprocal pair of IfcRelConnectsPorts (the IfcOpenShell way) is ONE physical connection', () => {
    const base = referenceIfc('sc-dat-01-reference.ifc');
    const ports = [...base.matchAll(/^#(\d+)=IFCRELCONNECTSPORTS\('[^']*',[^,]*,[^,]*,[^,]*,#(\d+),#(\d+),\$\);$/gm)];
    expect(ports.length).toBe(9);
    const first = ports[0] as RegExpMatchArray;
    const reciprocal = `#99999=IFCRELCONNECTSPORTS('3abcdefghijklmnopqrstu',$,$,$,#${first[3]},#${first[2]},$);\n`;
    const doubled = base.replace('ENDSEC;\nEND-ISO-10303-21;', `${reciprocal}ENDSEC;\nEND-ISO-10303-21;`);
    const result = summary(doubled);
    expect(result.connections).toBe(10);
    expect(result.physicalConnections).toBe(9);
  });

  it('summarises the export of the SC-DAT-01 document the same way (counts of the reference)', () => {
    const exported = data<{ ifc: string }>(scDat01(), 'export_ifc', { schema: 'IFC4X3_ADD2', timestamp: stamp });
    const actual = summary(exported.ifc);
    expect(actual.counts['IfcPipeSegment']).toBe(5);
    expect(actual.counts['IfcPipeFitting']).toBe(3);
    expect(actual.physicalConnections).toBe(9);
    expect(actual.openPorts).toBe(1);
    expect(actual.systems.map((system) => system.members).sort()).toEqual([3, 5]);
  });
});

describe('ifc_summary refusals and hostile text', () => {
  it.each([
    ['empty text', ''],
    ['not STEP', 'hello'],
    [
      'a STEP file of another schema',
      "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=PRODUCT('a');\nENDSEC;\nEND-ISO-10303-21;\n",
    ],
    ['no entity', "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"],
  ])('refuses %s with DAT_IFC_PARSE', (_name, ifc) => {
    expectRefusal(doc, 'ifc_summary', { ifc }, 'DAT_IFC_PARSE', 'ifc');
  });

  it('lists structure errors without failing, keeps unknown class names as written and an IFC2X3 file has no PredefinedType table', () => {
    const text =
      "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n#1=IFCSUPERNEWTHING('x');\n#2=IFCPIPESEGMENT('0',$,'a',$,$,$,$,'T',.RIGIDSEGMENT.);\n#3=BROKEN(;\nENDSEC;\nEND-ISO-10303-21;\n";
    const result = summary(text);
    expect(result.counts).toMatchObject({ IFCSUPERNEWTHING: 1, IfcPipeSegment: 1 });
    expect(result.predefinedTypes).toEqual({});
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('counts the products with one Tag as duplicates and reads 50 000 entities fast', () => {
    const records = Array.from(
      { length: 50000 },
      (_, k) => `#${k + 1}=IFCVALVE('g${k}',$,'v',$,$,$,$,'${k % 2 === 0 ? 'V-1' : `V-${k}`}',.ISOLATING.);`,
    ).join('\n');
    const started = performance.now();
    const result = summary(
      `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n${records}\nENDSEC;\nEND-ISO-10303-21;\n`,
    );
    expect(performance.now() - started).toBeLessThan(10000);
    expect(result.duplicateTags).toEqual(['V-1']);
    expect(result.predefinedTypes).toEqual({ 'IfcValve.ISOLATING': 50000 });
  });

  it('is pure', () => {
    const before = JSON.stringify(doc);
    summary(referenceIfc('sc-dat-01-reference.ifc'));
    expect(JSON.stringify(doc)).toBe(before);
  });
});
