/**
 * Plant 08 DAT H6 (follow-up): real 03 EQP nozzles as IFC ports. The ports exist since 03 EQP M5; here a DRAWN process line meets them (by the nozzle name of
 * its from / to, else by geometry), and each port carries the rated pressure read from the 01 PSC rating table.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { readStep, stepReferences, stepString, type StepEntity } from '@lib/stepRead';
import { apply, data } from '../../../helpers/commandAssertions';
import { separatorDocument } from '../equipment/equipmentFixtures';

interface IfcData {
  ifc: string;
  openPorts: number;
  ports: number;
}
interface PortList {
  ports: Record<string, { mark: string; position: [number, number, number] }>;
}

const ofType = (ifc: string, type: string): StepEntity[] => [...readStep(ifc).entities.values()].filter((entity) => entity.type === type);
const exportIfc = (doc: CadDocument): IfcData =>
  data<IfcData>(doc, 'export_ifc', { timestamp: '2026-11-04T00:00:00', schema: 'IFC4X3_ADD2', plant: { ports: true } });

/** Separator V-101 (nozzles N1..N4), plant library, and one classified drawn line whose first point is the face of nozzle N1 (named by `from` unless `from` is given). */
function scene(from: string | null, shift = 0): CadDocument {
  let doc = apply(separatorDocument(), 'define_plant_hierarchy', {
    nodes: [
      { code: 'S1', kind: 'site' },
      { code: 'U10', kind: 'unit', parent: 'S1', properties: { areaNumber: '1' } },
    ],
  });
  doc = apply(doc, 'load_plant_class_library', { library: 'llull-default-process' });
  const n1 = data<PortList>(doc, 'equipment_ports', {}).ports['V-101:N1'];
  expect(n1).toBeDefined();
  const [x, y, z] = (n1?.position ?? [0, 0, 0]) as [number, number, number];
  doc = apply(doc, 'add_pipe_run', {
    points: [
      [x + shift, y, z],
      [x + shift + 3000, y, z],
    ],
    dn: 150,
    line: 'L-1',
    service: 'process',
    ...(from === null ? {} : { from }),
    to: 'BL-1',
  });
  const pipe = Object.keys(doc.building?.elements ?? {})
    .filter((key) => key.startsWith('pipe'))
    .at(-1);
  return apply(doc, 'assign_plant_object', {
    target: pipe,
    className: 'ProcessLine',
    hierarchy: 'U10',
    tagFields: { nominalSize: 150, fluidCode: 'P', seq: 1, spec: 'CS150' },
  });
}

const connections = (ifc: string): StepEntity[] => ofType(ifc, 'IFCRELCONNECTSPORTS');
const portNamed = (ifc: string, name: string): StepEntity[] =>
  ofType(ifc, 'IFCDISTRIBUTIONPORT').filter((port) => stepString(port.args[2]) === name);
const nozzleN1 = (ifc: string): StepEntity =>
  portNamed(ifc, 'N1').find((port) => (stepString(port.args[3]) ?? '').includes('DN150')) as StepEntity;
const refOf = (value: unknown): number => stepReferences([value as string])[0] as number;

describe('a drawn line meets the real nozzle ports of its equipment', () => {
  it('connects the from end that names V-101:N1 (nozzle = RelatingPort), and the open count drops by one', () => {
    const named = exportIfc(scene('V-101:N1', 2));
    const ids = connections(named.ifc).map((rel) => refOf(rel.args[4]));
    expect(ids).toContain(nozzleN1(named.ifc).id);
    const bare = exportIfc(scene('V-101:N9', 2));
    expect(connections(bare.ifc).map((rel) => refOf(rel.args[4]))).not.toContain(nozzleN1(bare.ifc).id);
    expect(named.openPorts).toBeLessThan(bare.openPorts);
  });

  it('connects by geometry when the line names nothing and its end lies on the nozzle face; not when it is 50 mm away', () => {
    const onFace = exportIfc(scene(null));
    expect(connections(onFace.ifc).map((rel) => refOf(rel.args[4]))).toContain(nozzleN1(onFace.ifc).id);
    const away = exportIfc(scene(null, 50));
    expect(connections(away.ifc).map((rel) => refOf(rel.args[4]))).not.toContain(nozzleN1(away.ifc).id);
  });

  it('is deterministic', () => {
    expect(exportIfc(scene('V-101:N1', 2)).ifc).toBe(exportIfc(scene('V-101:N1', 2)).ifc);
  });
});

describe('nozzle rating read from the PSC rating table', () => {
  it('writes RatedPressure (Pa) of CL150 at 38 degC, its basis and the verified flag in Pset_llullNozzle', () => {
    const { ifc } = exportIfc(scene('V-101:N1', 2));
    const props = ofType(ifc, 'IFCPROPERTYSINGLEVALUE');
    const rated = props.filter((prop) => stepString(prop.args[0]) === 'RatedPressure');
    expect(rated.length).toBeGreaterThanOrEqual(4);
    const pascal = Number(/'RatedPressure','[^']*',IFCPRESSUREMEASURE\(([^)]+)\)/.exec(ifc)?.[1] ?? '');
    expect(pascal).toBeGreaterThan(18e5);
    expect(pascal).toBeLessThan(20e5);
    const basis = props.filter((prop) => stepString(prop.args[0]) === 'RatedPressureBasis');
    expect(ifc).toContain('class 150 at 38 degC (');
    expect(basis.length).toBeGreaterThanOrEqual(4);
    expect(props.some((prop) => stepString(prop.args[0]) === 'RatedPressureVerified')).toBe(true);
  });

  it('adds nothing for a rating label the table does not know', () => {
    const doc = scene('V-101:N1', 2);
    const equipment = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment');
    expect(equipment?.category === 'equipment' && equipment.plant?.nozzles.length).toBeGreaterThan(0);
    const odd = apply(doc, 'update_nozzle', { equipment: equipment?.id, mark: 'N1', rating: 'PN16' });
    const props = ofType(exportIfc(odd).ifc, 'IFCPROPERTYSINGLEVALUE').filter((prop) => stepString(prop.args[0]) === 'RatedPressure');
    expect(props.length).toBeLessThan(4);
  });
});
