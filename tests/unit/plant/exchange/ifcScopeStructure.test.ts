/**
 * Plant 08 DAT-VIS-FU review round: the structure of a hierarchy-scoped IFC file (`export_ifc` `plant.scope`). Counts are HAND-COUNTED from the fixture
 * `crowded()`: SC-DAT-02 (pump P-101, vessel V-101, routed line in S1/P1/U10) + pump P-201 in P2 + pump P-301 classified at the site S1 + an unclassified
 * block X-1 on a second level 'Upper' + a drawn process line in P2.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { readStep, stepReferences, stepString, type StepEntity, type StepFile } from '@lib/stepRead';
import { sha256Hex } from '@lib/sha256';
import { apply, data as queryData } from '../../../helpers/commandAssertions';
import { TYPE } from '../structures/accessFixtures';
import { addPipe, scDat02Document, withData } from '../data/dataFixtures';
import { stamp } from './ifcFixtures';

interface IfcData {
  ifc: string;
  openPorts: number;
  connections: number;
  scope: string | null;
  counts: Record<string, number>;
  omitted: {
    elements: { noPlantObject: number; outsideScope: number };
    routedLines: { noPlantObject: number; outsideScope: number };
  } | null;
  warnings: Array<{ code: string; id: string; message: string }>;
}

const exportIfc = (doc: CadDocument, scope?: string, extra: Record<string, unknown> = {}, plant: Record<string, unknown> = {}): IfcData =>
  queryData<IfcData>(doc, 'export_ifc', {
    timestamp: stamp,
    schema: 'IFC4X3_ADD2',
    ...extra,
    ...(scope === undefined && Object.keys(plant).length === 0 ? {} : { plant: { ...plant, ...(scope === undefined ? {} : { scope }) } }),
  });

const elementId = (doc: CadDocument, mark: string): string =>
  Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === mark)?.id as string;

const classify = (doc: CadDocument, mark: string, hierarchy: string, className = 'CentrifugalPump'): CadDocument =>
  apply(doc, 'assign_plant_object', { target: elementId(doc, mark), className, hierarchy, tag: mark });

function crowded(lineDn = 50): CadDocument {
  let doc = scDat02Document();
  doc = apply(doc, 'define_plant_hierarchy', { nodes: [{ code: 'P2', kind: 'plant', parent: 'S1' }] });
  doc = apply(doc, 'add_equipment', { name: 'P-201', mark: 'P-201', location: [20000, 0], size: [1000, 500, 800] });
  doc = classify(doc, 'P-201', 'P2');
  doc = apply(doc, 'add_equipment', { name: 'P-301', mark: 'P-301', location: [30000, 0], size: [1000, 500, 800] });
  doc = classify(doc, 'P-301', 'S1');
  doc = apply(doc, 'add_level', { name: 'Upper', elevation: 8000, height: 3000 });
  doc = apply(doc, 'add_equipment', { name: 'X-1', mark: 'X-1', location: [0, 9000], size: [1000, 500, 800], levelId: 'level-2' });
  doc = apply(doc, 'add_equipment', { name: 'P-102', mark: 'P-102', location: [60000, 0], size: [1000, 500, 800], levelId: 'level-1' });
  doc = classify(doc, 'P-102', 'U10');
  // a drawn line of P2 whose start lies in the footprint of P-102 (no real nozzles): an inferred nozzle of a line OUTSIDE the U10 scope
  const piped = addPipe(doc, {
    dn: lineDn,
    levelId: 'level-1',
    points: [
      [60000, 0, 400],
      [62000, 0, 400],
    ],
  });
  return apply(piped.doc, 'assign_plant_object', {
    target: piped.id,
    className: 'ProcessLine',
    hierarchy: 'P2',
    tag: '50-P-9001-A1A',
    properties: { fluidCode: 'P', spec: 'A1A', from: 'P-102' },
  });
}

const PRODUCT_SKIP = new Set([
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCFACILITY',
  'IFCFACILITYPARTCOMMON',
  'IFCDISTRIBUTIONPORT',
]);
const all = (file: StepFile, type: string): StepEntity[] => [...file.entities.values()].filter((entity) => entity.type === type);
const refsOf = (value: unknown): number[] => (value === undefined ? [] : stepReferences([value as string]));

/** Every product (an entity placed by an IFCLOCALPLACEMENT that is not a spatial node or a port) is contained, aggregated or nested. */
function uncontained(file: StepFile): string[] {
  const held = new Set<number>();
  for (const rel of all(file, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')) refsOf(rel.args[4]).forEach((id) => held.add(id));
  for (const type of ['IFCRELAGGREGATES', 'IFCRELNESTS'])
    for (const rel of all(file, type)) refsOf(rel.args[5]).forEach((id) => held.add(id));
  return [...file.entities.values()]
    .filter((entity) => {
      const placed = refsOf(entity.args[5])[0];
      return (
        placed !== undefined &&
        file.entities.get(placed)?.type === 'IFCLOCALPLACEMENT' &&
        !PRODUCT_SKIP.has(entity.type) &&
        !held.has(entity.id)
      );
    })
    .map((entity) => `${entity.type}#${entity.id}`);
}

function unresolved(file: StepFile): string[] {
  return [...file.entities.values()].flatMap((entity) =>
    refsOf(entity.args)
      .filter((id) => !file.entities.has(id))
      .map((id) => `#${entity.id} -> #${id}`),
  );
}

describe('scoped export: omitted counts (blocking 1)', () => {
  const doc = crowded();
  const out = exportIfc(doc, 'U10');

  it('counts what U10 leaves out by reason and warns once (hand count)', () => {
    // outside U10: P-201 (P2), P-301 (site S1, ABOVE the scope), the drawn pipe (P2) = 3; X-1 has no plant object = 1. P-101 and V-101 are in.
    expect(out.omitted).toEqual({ elements: { noPlantObject: 1, outsideScope: 3 }, routedLines: { noPlantObject: 0, outsideScope: 0 } });
    const warning = out.warnings.filter((entry) => entry.code === 'DAT_IFC_SCOPE_OMITTED');
    expect(warning).toHaveLength(1);
    expect(warning[0]?.id).toBe(out.scope);
    expect(out.ifc).not.toContain("'P-301'");
    const summary = execute(doc, 'export_ifc', { schema: 'IFC4X3_ADD2', plant: { scope: 'U10' } }).summary;
    expect(summary).toContain('left out 1 building element(s)');
    expect(summary).toContain('3 element(s)');
  });

  it('a scope that omits nothing reports zeros and no warning; no scope reports null', () => {
    const everything = exportIfc(scDat02Document(), 'S1');
    expect(everything.omitted?.elements.outsideScope).toBe(0);
    expect(everything.warnings.some((entry) => entry.code === 'DAT_IFC_SCOPE_OMITTED')).toBe(false);
    expect(exportIfc(doc).omitted).toBeNull();
  });
});

describe('scoped export: every product is placed and every reference resolves (blocking 2)', () => {
  it('a part whose assembly is outside the scope is contained in its storey', () => {
    let platform = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
      name: 'Grade',
      elevation: 0,
      height: 4000,
    });
    platform = apply(platform, 'add_access_platform', {
      bounds: [
        [0, 0],
        [6000, 3000],
      ],
      topOffset: 3000,
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      levelId: 'level-1',
    });
    platform = apply(platform, 'define_plant_hierarchy', {
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'U10', kind: 'unit', parent: 'S1' },
      ],
    });
    platform = apply(platform, 'load_plant_class_library', { library: 'llull-default-process' });
    const part = Object.values(platform.building?.elements ?? {}).find((element) => element.category === 'member');
    // a generated part cannot be tagged by the commands (DAT_TARGET_TAG_READONLY): a hand-edited file points a plant object at it
    const pumpFirst = apply(platform, 'add_equipment', { name: 'P-101', mark: 'P-101', location: [20000, 0], size: [1000, 500, 800] });
    const classified = classify(pumpFirst, 'P-101', 'U10');
    platform = withData(classified, (current) => {
      const source = current.objects[current.objectOrder[0] as string];
      if (source === undefined || part === undefined) throw new Error('fixture');
      const copy = { ...source, id: 'plantobj-9.1', target: { kind: 'buildingElement' as const, id: part.id }, tag: 'P-901' };
      return { ...current, objects: { ...current.objects, [copy.id]: copy }, objectOrder: [...current.objectOrder, copy.id] };
    });
    // hierarchy:false = no spatial plant container, so the part would be left to its (out of scope) assembly
    const scoped = readStep(exportIfc(platform, 'U10', {}, { hierarchy: false }).ifc);
    expect(scoped.errors).toEqual([]);
    expect(all(scoped, 'IFCBEAM').length).toBe(1);
    expect(all(scoped, 'IFCPUMP').length).toBe(1);
    expect(uncontained(scoped)).toEqual([]);
    expect(unresolved(scoped)).toEqual([]);
    expect(uncontained(readStep(exportIfc(platform).ifc))).toEqual([]);
  });

  it('the crowded scene: no orphan product and no dangling reference at any node', () => {
    const doc = crowded();
    for (const scope of [undefined, 'S1', 'P1', 'U10', 'P2']) {
      const file = readStep(exportIfc(doc, scope).ifc);
      expect(file.errors).toEqual([]);
      expect(unresolved(file)).toEqual([]);
      expect(uncontained(file)).toEqual([]);
    }
  });
});

describe('scoped export: nothing of the outside leaks (blocking 3)', () => {
  const doc = crowded();
  const base = exportIfc(doc, 'U10');

  it('the storey of a level with no exported product is not written (hand count: Grade only)', () => {
    expect(base.counts['IfcBuildingStorey']).toBe(1);
    expect(exportIfc(doc).counts['IfcBuildingStorey']).toBe(2);
    expect(base.ifc).not.toContain("'Upper'");
  });

  it('an unrelated level, an out-of-scope pump or an out-of-scope line leaves the scoped bytes and the deliverable hash identical', () => {
    const hashOf = (document: CadDocument): string =>
      queryData<{ contentSha256: string }>(document, 'set_deliverable_status', {
        at: '2026-11-07T09:00:00Z',
        deliverable: 'ifc',
        revision: 'A',
        status: 'in_work',
        hierarchy: 'U10',
      }).contentSha256;
    const before = hashOf(doc);
    const upper = apply(doc, 'update_level', { levelId: 'level-2', elevation: 9500 });
    const resized = apply(doc, 'update_equipment', { currentMark: 'P-201', size: [1500, 600, 900] });
    const widerLine = crowded(80);
    expect(exportIfc(upper, 'U10').ifc).toBe(base.ifc);
    expect(exportIfc(resized, 'U10').ifc).toBe(base.ifc);
    expect(exportIfc(widerLine, 'U10').ifc).toBe(base.ifc);
    expect(hashOf(upper)).toBe(before);
    expect(hashOf(resized)).toBe(before);
    expect(hashOf(widerLine)).toBe(before);
    expect(exportIfc(widerLine).ifc).not.toBe(exportIfc(doc).ifc);
    expect(exportIfc(upper).ifc).not.toBe(exportIfc(doc).ifc);
  });

  it('an inferred nozzle of an outside line is not written for a scoped pump (hand count: 1 port whole, 0 scoped on P-102)', () => {
    const ports = (file: StepFile): number =>
      all(file, 'IFCDISTRIBUTIONPORT').filter((port) => stepString(port.args[3]).includes('inferred')).length;
    expect(ports(readStep(exportIfc(doc).ifc))).toBe(1);
    expect(ports(readStep(base.ifc))).toBe(0);
  });

  it('changing an in-scope pump changes the scoped bytes', () => {
    const resized = apply(doc, 'update_equipment', { currentMark: 'P-101', size: [1500, 600, 900] });
    expect(exportIfc(resized, 'U10').ifc).not.toBe(base.ifc);
  });

  it('a line outside the scope gives no system: one system, every group member present', () => {
    // hand count: the drawn line in P2 and the routed line in U10 = 2 systems whole; scope U10 keeps the routed line only
    expect(exportIfc(doc).counts['IfcDistributionSystem']).toBe(2);
    expect(base.counts['IfcDistributionSystem']).toBe(1);
    const file = readStep(base.ifc);
    for (const rel of all(file, 'IFCRELASSIGNSTOGROUP')) for (const id of refsOf(rel.args[4])) expect(file.entities.has(id)).toBe(true);
    expect(stepString(all(file, 'IFCDISTRIBUTIONSYSTEM')[0]?.args[2])).toBe('100-P-1001-CS150');
  });

  it('a routed line crossing the boundary keeps its port open: every connection has both ports in the file', () => {
    let moved = apply(doc, 'unassign_plant_object', { objects: ['V-101'] });
    moved = classify(moved, 'V-101', 'P2', 'PressureVessel');
    const whole = exportIfc(moved);
    const scoped = exportIfc(moved, 'U10');
    const file = readStep(scoped.ifc);
    expect(unresolved(file)).toEqual([]);
    for (const rel of all(file, 'IFCRELCONNECTSPORTS')) {
      expect(file.entities.get(refsOf(rel.args[4])[0] as number)?.type).toBe('IFCDISTRIBUTIONPORT');
      expect(file.entities.get(refsOf(rel.args[5])[0] as number)?.type).toBe('IFCDISTRIBUTIONPORT');
    }
    // hand count: the routed line meets the vessel nozzle (1 connection to a nozzle port) only when V-101 is exported
    expect(all(file, 'IFCRELCONNECTSPORTS').length).toBeLessThan(all(readStep(whole.ifc), 'IFCRELCONNECTSPORTS').length);
  });
});

describe('scoped export: bad scopes and option combinations (non-blocking 4)', () => {
  const doc = crowded();
  const duplicate = apply(doc, 'define_plant_hierarchy', {
    nodes: [{ code: 'U10', kind: 'unit', parent: 'P2', properties: { areaNumber: '2' } }],
  });

  it.each([
    ['empty', '', doc],
    ['a path that does not exist', 'S1/NOPE/U10', doc],
    ['an ambiguous code', 'U10', duplicate],
    ['a prototype key', 'constructor', doc],
  ])('%s is DAT_HIERARCHY_UNKNOWN with the document unchanged', (_label, scope, input) => {
    const result = execute(input, 'export_ifc', { schema: 'IFC4X3_ADD2', plant: { scope } });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('DAT_HIERARCHY_UNKNOWN');
    expect(result.error?.paths).toEqual(['plant.scope']);
    expect(result.document).toBe(input);
  });

  it('the refusal comes before the "no levels" no-op', () => {
    expect(execute(createEmptyDocument(), 'export_ifc', { plant: { scope: 'S1' } }).error?.code).toBe('DAT_HIERARCHY_UNKNOWN');
  });

  it('the path disambiguates the shared code', () => {
    expect(exportIfc(duplicate, 'S1/P1/U10').scope).not.toBe(exportIfc(duplicate, 'S1/P2/U10').scope);
  });

  it('with hierarchy:false the filter holds and no plant nodes are written', () => {
    const file = exportIfc(doc, 'U10', {}, { hierarchy: false });
    expect(file.counts['IfcFacility']).toBe(0);
    expect(file.omitted?.elements.outsideScope).toBe(3);
  });

  it('with IFC4 the filter holds and there are no plant nodes', () => {
    const file = exportIfc(doc, 'U10', { schema: 'IFC4' });
    expect(file.counts['IfcFacility']).toBe(0);
    expect(file.omitted?.elements.outsideScope).toBe(3);
    expect(file.ifc).not.toContain("'P-201'");
    expect(file.ifc).toContain("'P-101'");
  });
});

describe('unscoped export is unchanged by the scope work', () => {
  it('the SHA-256 of the whole export equals the one recorded at the merge base 814949d16', () => {
    expect(sha256Hex(exportIfc(scDat02Document()).ifc)).toBe(BASE_SC_DAT_02);
    expect(sha256Hex(exportIfc(crowded()).ifc)).toBe(BASE_CROWDED);
    expect(sha256Hex(exportIfc(crowded(), undefined, { schema: 'IFC4' }).ifc)).toBe(BASE_CROWDED_IFC4);
  });
});

const BASE_SC_DAT_02 = 'b8b959665e9c8e24475fc38a2afe8d41c5a33084a40fb83e7e1cf13a1d98855d';
const BASE_CROWDED = 'ced69f5f0f8db63ebe0aa26490679c889f5bf2acb3671594904851feb9134374';
const BASE_CROWDED_IFC4 = 'faebe9f7997938580ae5fa515bcec65db19ddbc2ede0e7472fc56841f9b93ba3';
