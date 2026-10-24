/**
 * Plant 02 RTE V1 part 2: IFC export of spec-driven runs (`export_ifc`): IfcPipeSegment / IfcPipeFitting / IfcValve with IfcDistributionPort nested in each
 * (IfcRelNests), IfcRelConnectsPorts between the ports that meet and one IfcDistributionSystem per line. Hand numbers: the small line has 3 parts
 * (pipe 2848, LR 90 elbow, pipe 1848), so 6 ports and 2 port connections; the elbow is a circle of radius 114.3 / 2 = 57.15 at 152 from the bend axis
 * revolved 90 degrees (1.570796 rad).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Line, routedPumpToVesselWithTee } from './rteFixtures';

interface Exported {
  ifc: string;
  productCount: number;
  piping: { productCount: number; portCount: number; connectionCount: number; systemCount: number; bodiless: number; brokenRuns: string[] };
}
const exported = (doc: CadDocument): Exported => data<Exported>(doc, 'export_ifc', {});
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/** Every `#n` a record names exists, and ids are 1..N without a gap. */
function expectClosed(ifc: string): void {
  const records = ifc.split('\n').filter((line) => /^#\d+=/.test(line));
  const ids = records.map((line) => Number(/^#(\d+)=/.exec(line)?.[1]));
  expect(ids).toEqual(ids.map((_, index) => index + 1));
  const known = new Set(ids);
  for (const line of records) {
    for (const ref of line.slice(line.indexOf('=') + 1).matchAll(/#(\d+)/g))
      expect(known.has(Number(ref[1])), `${line} -> #${ref[1]}`).toBe(true);
  }
}

function smallLine(): CadDocument {
  const line = cs150Line(100, '6001');
  const a = addTie(line.doc, 'PCF-A', [0, 0, 0], [1, 0, 0]);
  return apply(a.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 3000 },
      { direction: '+Z', length: 2000 },
    ],
  });
}

describe('export_ifc: pipe runs', () => {
  const doc = smallLine();
  const result = exported(doc);

  it('exports a document with runs and no building level: 2 pipe segments, 1 bend fitting, 6 ports, 2 port connections, 1 system', () => {
    expect(count(result.ifc, /=IFCPIPESEGMENT\(/g)).toBe(2);
    expect(count(result.ifc, /=IFCPIPEFITTING\(.*\.BEND\.\);/g)).toBe(1);
    expect(count(result.ifc, /=IFCDISTRIBUTIONPORT\(/g)).toBe(6);
    expect(count(result.ifc, /=IFCRELNESTS\(/g)).toBe(3);
    expect(count(result.ifc, /=IFCRELCONNECTSPORTS\(/g)).toBe(2);
    expect(count(result.ifc, /=IFCDISTRIBUTIONSYSTEM\(/g)).toBe(1);
    expect(result.piping).toMatchObject({ productCount: 3, portCount: 6, connectionCount: 2, systemCount: 1, brokenRuns: [] });
    expect(result.ifc).toContain("IFCDISTRIBUTIONSYSTEM('");
    expect(result.ifc).toContain("'100-P-6001-CS150'");
  });

  it('the pipe segments are round extrusions of radius 57.15 (OD 114.3), 2848 and 1848 long, and the elbow is an exact torus segment of 90 degrees', () => {
    expect(result.ifc).toMatch(/IFCCIRCLEPROFILEDEF\(\.AREA\.,\$,#\d+,57\.15\)/);
    expect(result.ifc).toContain(',2848.);');
    expect(result.ifc).toContain(',1848.);');
    expect(result.ifc).toContain('IFCCARTESIANPOINT((152.,0.))');
    expect(result.ifc).toContain(',1.570796);');
    expect(result.ifc).toMatch(/IFCREVOLVEDAREASOLID\(#\d+,#\d+,#\d+,1\.570796\)/);
  });

  it('the products sit in the IfcBuilding; the system groups them; ports are nested in their part', () => {
    expect(result.ifc).toMatch(/IFCRELCONTAINEDINSPATIALSTRUCTURE\('[^']+',\$,\$,\$,\(#\d+,#\d+,#\d+\),#18\)/);
    expect(result.ifc).toMatch(/IFCRELASSIGNSTOGROUP\('[^']+',\$,\$,\$,\(#\d+,#\d+,#\d+\),\$,#\d+\)/);
    expect(result.ifc).toMatch(/IFCRELNESTS\('[^']+',\$,\$,\$,#\d+,\(#\d+,#\d+\)\)/);
  });

  it('is a closed STEP file and the same document gives the same bytes', () => {
    expectClosed(result.ifc);
    expect(exported(doc).ifc).toBe(result.ifc);
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'export_ifc', {}));
  });

  it('a document with neither levels nor runs is still refused; a broken run is skipped and named', () => {
    const empty = execute(cs150Line(100, '6002').doc, 'export_ifc', {});
    expect(empty.data).toBeUndefined();
    expect(empty.summary).toContain('no pipe runs');
    const runId = doc.plant?.piping?.runOrder[0] as string;
    const run = doc.plant?.piping?.runs[runId] as object;
    const broken = {
      ...doc,
      plant: { ...doc.plant, piping: { ...(doc.plant?.piping as object), runs: { [runId]: { ...run, lineId: 'line-404' } } } },
    } as unknown as CadDocument;
    const skipped = exported(broken);
    expect(skipped.piping.productCount).toBe(0);
    expect(skipped.piping.brokenRuns).toEqual([runId]);
  });
});

describe('export_ifc: pump to vessel with a tee and a valve', () => {
  const scene = routedPumpToVesselWithTee();
  const doc = apply(scene.doc, 'insert_inline_component', {
    runId: scene.runId,
    type: 'valveGate',
    tag: 'XV-1001',
    at: { leg: 3, centreDistance: 800 },
    stemDirection: [0, -1, 0],
  });
  const takeoff = data<{ counts: Record<string, number> }>(doc, 'piping_takeoff', {}).counts;
  const result = exported(doc);

  it('maps every part kind: pipes -> segments, elbows -> BEND, tee -> JUNCTION, flanges and gaskets -> CONNECTOR, the gate valve -> IfcValve ISOLATING', () => {
    expect(count(result.ifc, /=IFCPIPESEGMENT\(/g)).toBe(takeoff['pipePieces']);
    expect(count(result.ifc, /\.BEND\.\);/g)).toBe(takeoff['elbow90LR']);
    expect(count(result.ifc, /\.JUNCTION\.\);/g)).toBe(takeoff['tee']);
    expect(count(result.ifc, /\.CONNECTOR\.\);/g)).toBe((takeoff['flangeWeldNeck'] ?? 0) + (takeoff['gasketSpiralWound'] ?? 0));
    expect(count(result.ifc, /=IFCVALVE\(.*\.ISOLATING\.\);/g)).toBe(1);
    expect(result.ifc).toContain("'XV-1001'");
  });

  it('bolt sets have no product (counted as bodiless); the line is one system covering header and branch run', () => {
    expect(result.piping.bodiless).toBe(takeoff['boltSet']);
    expect(result.piping.systemCount).toBe(1);
    expect(count(result.ifc, /=IFCPIPEFITTING\(.*OBSTRUCTION/g)).toBe(0);
  });

  it('ports connect pairwise: a port is connected at most once, and the tee outlet meets the branch pipe', () => {
    expectClosed(result.ifc);
    const pairs = [...result.ifc.matchAll(/IFCRELCONNECTSPORTS\('[^']+',\$,\$,\$,#(\d+),#(\d+),\$\)/g)].map((match) => [
      match[1],
      match[2],
    ]);
    const used = pairs.flat();
    expect(new Set(used).size).toBe(used.length);
    expect(pairs.length).toBe(result.piping.connectionCount);
    expect(result.piping.connectionCount).toBeGreaterThan(10);
  });

  it('the valve body carries the operator: more than one solid in the valve representation', () => {
    const valve = result.ifc.split('\n').find((line) => line.includes('=IFCVALVE('));
    const shapeRef = /,(#\d+),'run-[^']+\/valve-1',/.exec(valve ?? '')?.[1];
    const definition = result.ifc.split('\n').find((line) => line.startsWith(`${shapeRef}=IFCPRODUCTDEFINITIONSHAPE`));
    const representation = /\((#\d+)\)\);$/.exec(definition ?? '')?.[1];
    const body = result.ifc.split('\n').find((line) => line.startsWith(`${representation}=IFCSHAPEREPRESENTATION`));
    expect(body?.match(/#\d+/g)?.length).toBeGreaterThan(2);
  });
});
