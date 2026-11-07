/**
 * Plant 08 DAT-VIS-FU: hierarchy-scoped IFC export (`export_ifc` `plant.scope`) and the scoped `ifc` deliverable. Oracles are HAND-COUNTED from the fixture:
 * SC-DAT-02 holds pump P-101, vessel V-101 and the routed line 100-P-1001-CS150, all in S1/P1/U10; the test adds pump P-201 in S1/P2.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { readStep, stepString, type StepEntity } from '@lib/stepRead';
import { apply, data as queryData } from '../../../helpers/commandAssertions';
import { scDat02Document } from '../data/dataFixtures';
import { stamp } from './ifcFixtures';

interface IfcData {
  ifc: string;
  productCount: number;
  openPorts: number;
  scope: string | null;
  counts: Record<string, number>;
  piping: { productCount: number; systemCount: number };
}

const exportIfc = (doc: CadDocument, scope?: string): IfcData =>
  queryData<IfcData>(doc, 'export_ifc', { timestamp: stamp, schema: 'IFC4X3_ADD2', ...(scope === undefined ? {} : { plant: { scope } }) });

/** SC-DAT-02 plus plant P2 holding a second pump P-201 (a plain equipment block, classified). */
function twoPlants(): CadDocument {
  let doc = scDat02Document();
  doc = apply(doc, 'define_plant_hierarchy', { nodes: [{ code: 'P2', kind: 'plant', parent: 'S1' }] });
  doc = apply(doc, 'add_equipment', { name: 'P-201', mark: 'P-201', location: [20000, 0], size: [1000, 500, 800] });
  const id = Object.values(doc.building?.elements ?? {}).find(
    (element) => element.category === 'equipment' && element.mark === 'P-201',
  )?.id;
  return apply(doc, 'assign_plant_object', { target: id, className: 'CentrifugalPump', hierarchy: 'P2', tag: 'P-201' });
}

const names = (entities: StepEntity[]): string[] => entities.map((entity) => stepString(entity.args[2] as string) ?? '').sort();
const ofType = (ifc: string, type: string): StepEntity[] => [...readStep(ifc).entities.values()].filter((entity) => entity.type === type);

describe('export_ifc plant.scope', () => {
  const doc = twoPlants();
  const full = exportIfc(doc);

  it('the whole export holds both pumps and the routed line, and the 4-node hierarchy', () => {
    expect(names(ofType(full.ifc, 'IFCPUMP'))).toEqual(['P-101', 'P-201']);
    // hand count: hierarchy S1, P1, P2, U10 = 1 IfcSite, 2 IfcFacility, 1 IfcFacilityPartCommon
    expect([full.counts['IfcSite'], full.counts['IfcFacility'], full.counts['IfcFacilityPartCommon']]).toEqual([1, 2, 1]);
    expect(full.scope).toBeNull();
    expect(full.piping.productCount).toBeGreaterThan(0);
  });

  it('S1/P2 keeps only P-201 and its ancestors: no routed pipe, no P-101, no unit U10', () => {
    const scoped = exportIfc(doc, 'S1/P2');
    expect(names(ofType(scoped.ifc, 'IFCPUMP'))).toEqual(['P-201']);
    expect(scoped.piping.productCount).toBe(0);
    expect(scoped.piping.systemCount).toBe(0);
    expect(scoped.scope).toBe(Object.values(doc.plant?.data?.hierarchy ?? {}).find((node) => node.code === 'P2')?.id);
    // hand count: hierarchy nodes written = S1 (site) + P2 (plant) = 1 IfcSite, 1 IfcFacility; U10 and P1 are outside
    expect(scoped.counts['IfcSite']).toBe(1);
    expect(scoped.counts['IfcFacility']).toBe(1);
    expect(scoped.counts['IfcFacilityPartCommon']).toBe(0);
    expect(scoped.counts['IfcDistributionSystem']).toBe(0);
    expect(ofType(scoped.ifc, 'IFCPUMP').length).toBe(1);
  });

  it('S1/P1/U10 keeps P-101, V-101 and the routed line, and drops P-201', () => {
    const scoped = exportIfc(doc, 'U10');
    expect(names(ofType(scoped.ifc, 'IFCPUMP'))).toEqual(['P-101']);
    expect(scoped.piping.productCount).toBe(full.piping.productCount);
    expect(scoped.counts['IfcFacility']).toBe(1);
    expect(scoped.counts['IfcFacilityPartCommon']).toBe(1);
    expect(scoped.counts['IfcSite']).toBe(1);
  });

  it('the root site scope equals the whole plant for classified products, and is deterministic', () => {
    const site = exportIfc(doc, 'S1');
    expect(names(ofType(site.ifc, 'IFCPUMP'))).toEqual(['P-101', 'P-201']);
    expect(exportIfc(doc, 'S1/P2').ifc).toBe(exportIfc(doc, 'S1/P2').ifc);
  });

  it('is pure and refuses an unknown or ambiguous node with DAT_HIERARCHY_UNKNOWN', () => {
    const before = JSON.stringify(doc);
    const result = execute(doc, 'export_ifc', { schema: 'IFC4X3_ADD2', plant: { scope: 'NOPE' } });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('DAT_HIERARCHY_UNKNOWN');
    expect(result.document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(execute(doc, 'export_ifc', { schema: 'IFC4X3_ADD2', plant: { scope: '__proto__' } }).error?.code).toBe('DAT_HIERARCHY_UNKNOWN');
  });
});

describe('ifc deliverable scoped to a hierarchy node', () => {
  const doc = twoPlants();
  const AT = '2026-11-07T09:00:00Z';
  const status = (scope?: string): { contentSha256: string; hierarchy?: string } =>
    queryData(doc, 'set_deliverable_status', {
      at: AT,
      deliverable: 'ifc',
      revision: 'A',
      status: 'in_work',
      ...(scope === undefined ? {} : { hierarchy: scope }),
    });

  it('hashes the scoped file: a different node gives a different hash, the same node the same', () => {
    const whole = status().contentSha256;
    const p2 = status('S1/P2');
    expect(p2.contentSha256).not.toBe(whole);
    expect(p2.contentSha256).toBe(status('S1/P2').contentSha256);
    expect(p2.contentSha256).not.toBe(status('U10').contentSha256);
    expect(p2.hierarchy).toBeTruthy();
  });

  it('refuses an unknown node and keeps the scope of an existing revision', () => {
    const bad = execute(doc, 'set_deliverable_status', { at: AT, deliverable: 'ifc', revision: 'A', status: 'in_work', hierarchy: 'ZZ' });
    expect(bad.error?.code).toBe('DAT_HIERARCHY_UNKNOWN');
    const first = execute(doc, 'set_deliverable_status', {
      at: AT,
      deliverable: 'ifc',
      revision: 'A',
      status: 'in_work',
      hierarchy: 'S1/P2',
    });
    const change = execute(first.document, 'set_deliverable_status', {
      at: AT,
      deliverable: 'ifc',
      revision: 'A',
      status: 'issued_for_review',
      hierarchy: 'U10',
    });
    expect(change.rejected).toBe(true);
    expect(change.error?.code).toBe('DAT_PARAM_INVALID');
  });
});
