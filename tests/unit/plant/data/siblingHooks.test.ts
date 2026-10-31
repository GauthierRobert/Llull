/**
 * Plant 08 DAT-M5: the providers for the sibling gaps (03 EQP nozzles, 02 RTE inline valves, 04 PID instruments) and what reads them: the nozzle schedule with real
 * nozzles, `valve_list`, `instrument_index`, the MTO of routed runs with the 01 PSC take-outs, and the P&ID tags reserved in the tag register.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { getPlantData } from '@aec/plant/data/model';
import { allProviders, getProvider } from '@aec/plant/data/providers';
import type { PidInstrument } from '@aec/plant/pid/model';
import { EMPTY_PID, getPid, withPid } from '@aec/plant/pid/state';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { routedPumpToVessel, valveScene, withoutSpecs } from '../piping/rteFixtures';
import { feedPumpControlled } from '../pid/authoringFixtures';
import { addPipe, scDat02Document } from './dataFixtures';

interface ReportData {
  rows: Array<Record<string, unknown>>;
  rowsByTag?: Record<string, Record<string, unknown>>;
  total: number;
  totals: Record<string, number>;
  method: string;
}

const report = (doc: CadDocument, params: Record<string, unknown>): ReportData => data<ReportData>(doc, 'plant_report', params);

/** The hierarchy S1 / U10 and the default process library. */
const withLibrary = (doc: CadDocument): CadDocument =>
  apply(
    apply(doc, 'define_plant_hierarchy', {
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'U10', kind: 'unit', parent: 'S1', properties: { areaNumber: '1' } },
      ],
    }),
    'load_plant_class_library',
    { library: 'llull-default-process' },
  );

const equipmentId = (doc: CadDocument, mark: string): string =>
  Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === mark)?.id as string;

const NOZZLE_CLASS = {
  name: 'Nozzle',
  tagFormat: 'N-{seq:3}',
  properties: [
    { name: 'nominalSize', displayName: 'Nominal size DN', type: 'integer' },
    { name: 'rating', displayName: 'Rating', type: 'text' },
  ],
};

describe('providers of the sibling gaps', () => {
  it('are registered next to the built-in ones', () => {
    expect(allProviders().map((provider) => provider.id)).toEqual(expect.arrayContaining(['nozzle', 'pidInstrument']));
  });

  it('nozzle: lists the nozzles of the equipment as elements <equipment id>:<mark>, none needing a class or a unique tag', () => {
    const { doc } = routedPumpToVessel();
    const pump = equipmentId(doc, 'P-101');
    const provider = getProvider('nozzle');
    expect(provider?.elements(doc).map((element) => element.id)).toEqual([`${pump}:N2`, `${equipmentId(doc, 'V-101')}:N1`]);
    expect(provider?.element(doc, `${pump}:N2`)).toMatchObject({
      category: 'nozzle',
      label: `nozzle P-101:N2 (${pump})`,
      tagUnique: false,
      needsClass: false,
    });
    expect(provider?.dn?.(doc, `${pump}:N2`)).toBe(100);
    for (const id of [`${pump}:ZZ`, 'nope:N2', 'noColon', ':N2', `${pump}:`]) expect(provider?.element(doc, id), id).toBeUndefined();
    expect(provider?.dn?.(doc, `${pump}:ZZ`)).toBeUndefined();
    expect(provider?.seeds?.(doc, `${pump}:ZZ`)).toEqual({});
    expect(provider?.seeds?.(doc, `${pump}:N2`)).toEqual({ nominalSize: 100, rating: 'CL150', facing: 'RF' });
  });

  it('nozzle: a classified nozzle takes its size and rating from the model, owns its tag, and goes orphan when the nozzle is deleted', () => {
    const scene = routedPumpToVessel();
    let doc = apply(withLibrary(scene.doc), 'define_plant_class', NOZZLE_CLASS);
    const target = { provider: 'nozzle', id: `${equipmentId(doc, 'P-101')}:N2` };
    doc = apply(doc, 'assign_plant_object', { target, className: 'Nozzle', hierarchy: 'U10', nextSequence: true });
    const object = Object.values(getPlantData(doc).objects)[0];
    expect(object).toMatchObject({
      tag: 'N-001',
      properties: { nominalSize: 100, rating: 'CL150' },
      target: { kind: 'provider', provider: 'nozzle' },
    });
    expectRefusal(
      doc,
      'assign_plant_object',
      { target, className: 'Nozzle', hierarchy: 'U10', nextSequence: true },
      'DAT_TARGET_ALREADY_TAGGED',
      'target',
    );
    expectRefusal(
      doc,
      'assign_plant_object',
      { target: { provider: 'nozzle', id: `${equipmentId(doc, 'P-101')}:N9` }, className: 'Nozzle', hierarchy: 'U10', nextSequence: true },
      'DAT_TARGET_UNKNOWN',
      'target',
    );
    const tagRow = report(doc, { kind: 'tag_register' }).rowsByTag?.['N-001'];
    expect(tagRow).toMatchObject({ targetKind: 'nozzle', status: 'modelled', className: 'Nozzle' });
    const unrouted = apply(doc, 'delete_pipe_run', { runId: scene.runId });
    const deleted = execute(unrouted, 'delete_nozzle', { equipment: 'P-101', mark: 'N2' });
    expect(deleted.rejected, deleted.summary).toBeUndefined();
    const findings = data<{ findings: Array<{ code: string }> }>(deleted.document, 'check_plant_data', {}).findings;
    expect(findings.filter((finding) => finding.code === 'DAT_OBJECT_ORPHAN')).toHaveLength(1);
    expect(report(deleted.document, { kind: 'tag_register' }).rowsByTag?.['N-001']).toMatchObject({ status: 'orphan' });
  });
});

describe('nozzle_schedule with real 03 EQP nozzles', () => {
  it('lists the nozzles of both equipment with DN, rating and facing; no line object is connected yet, so no flow direction; none is inferred', () => {
    const { doc, line } = routedPumpToVessel();
    const schedule = report(doc, { kind: 'nozzle_schedule' });
    expect(schedule.method).toBe('model');
    expect(schedule.total).toBe(2);
    expect(schedule.rows).toEqual([
      expect.objectContaining({
        key: 'P-101/N2',
        equipment: 'P-101',
        nozzle: 'N2',
        dn: 100,
        rating: 'CL150',
        facing: 'RF',
        inferred: false,
        flowDirection: null,
        line: null,
      }),
      expect.objectContaining({
        key: 'V-101/N1',
        equipment: 'V-101',
        nozzle: 'N1',
        dn: 100,
        rating: 'CL150',
        facing: 'RF',
        inferred: false,
        flowDirection: null,
        line: null,
      }),
    ]);
    expect(schedule.rows.map((row) => row['equipmentId'])).toEqual([equipmentId(doc, 'P-101'), equipmentId(doc, 'V-101')]);
    expect(line).toMatch(/^line-/);
  });

  it('names the process line whose run starts or ends at the nozzle port, and takes the equipment tag of its plant object', () => {
    const scene = routedPumpToVessel();
    let doc = withLibrary(scene.doc);
    doc = apply(doc, 'assign_plant_object', {
      target: scene.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    doc = apply(doc, 'assign_plant_object', {
      target: equipmentId(doc, 'P-101'),
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      tag: 'P-101',
      properties: { Description: 'Feed pump', DesignPressure: 10 },
    });
    const schedule = report(doc, { kind: 'nozzle_schedule' });
    const byKey = Object.fromEntries(schedule.rows.map((row) => [row['key'], row]));
    expect(byKey['P-101/N2']).toMatchObject({
      line: '100-P-1001-CS150',
      flowDirection: 'SOURCE',
      lineId: expect.stringMatching(/^plantobj-/),
    });
    expect(byKey['V-101/N1']).toMatchObject({ line: '100-P-1001-CS150', flowDirection: 'SINK' });
    // a hierarchy filter keeps the equipment that has a plant object in the node; the unclassified vessel drops out
    const scoped = report(doc, { kind: 'nozzle_schedule', hierarchy: 'U10' });
    expect(scoped.rows.map((row) => row['key'])).toEqual(['P-101/N2']);
  });

  it('a process line whose from / to names the port <tag>:<mark> is the connection, from = SOURCE and to = SINK', () => {
    const scene = routedPumpToVessel();
    let doc = withLibrary(scene.doc);
    doc = apply(doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 100, fluidCode: 'P', seq: 7, spec: 'CS150' },
      properties: { from: 'V-101:N1', to: 'P-101:N2' },
    });
    const byKey = Object.fromEntries(report(doc, { kind: 'nozzle_schedule' }).rows.map((row) => [row['key'], row]));
    expect(byKey['V-101/N1']).toMatchObject({ line: '100-P-0007-CS150', flowDirection: 'SOURCE' });
    expect(byKey['P-101/N2']).toMatchObject({ line: '100-P-0007-CS150', flowDirection: 'SINK' });
  });

  it('keeps inferring nozzles for equipment without 03 EQP nozzles next to the real ones', () => {
    const scene = routedPumpToVessel();
    let doc = withLibrary(scene.doc);
    doc = apply(doc, 'add_equipment', { name: 'Tank', location: [20000, 0], size: [1000, 1000, 2000], mark: 'T-201' });
    doc = apply(doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 50, fluidCode: 'P', seq: 9, spec: 'A1A' },
      properties: { from: 'T-201' },
    });
    doc = apply(doc, 'add_pipe_run', {
      points: [
        [20000, 0, 1000],
        [21000, 0, 1000],
      ],
      dn: 50,
    });
    const schedule = report(doc, { kind: 'nozzle_schedule' });
    expect(schedule.rows.filter((row) => row['inferred'] === false)).toHaveLength(2);
    expect(schedule.method).toBe('model');
    const bound = apply(doc, 'assign_plant_object', {
      target: Object.keys(doc.building?.elements ?? {}).find((id) => id.startsWith('pipe')) as string,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 50, fluidCode: 'P', seq: 10, spec: 'A1A' },
      properties: { from: 'T-201' },
    });
    const mixed = report(bound, { kind: 'nozzle_schedule' });
    expect(mixed.rows.filter((row) => row['inferred'] === true).map((row) => row['equipment'])).toEqual(['T-201']);
    expect(mixed.method).toBe('inferred');
  });
});

describe('valve_list from the inline components of 02 RTE', () => {
  const classified = (): { doc: CadDocument; valveId: string } => {
    const scene = valveScene();
    const doc = apply(withLibrary(scene.doc), 'assign_plant_object', {
      target: scene.valveId,
      className: 'IsolationValve',
      hierarchy: 'U10',
    });
    return { doc, valveId: scene.valveId };
  };

  it('an inline valve adopts its tag, takes its DN as a seed, and is listed with size, face-to-face length, line and spec from the derived run', () => {
    const { doc, valveId } = classified();
    expect(Object.values(getPlantData(doc).objects)[0]).toMatchObject({
      tag: 'XV-1001',
      tagFields: { seq: 1001 },
      properties: { nominalSize: 100, valveCode: 'XV' },
      target: { kind: 'provider', provider: 'inlineComponent', id: valveId },
    });
    const list = report(doc, { kind: 'valve_list' });
    expect(list.total).toBe(1);
    expect(list.rowsByTag?.['XV-1001']).toMatchObject({
      className: 'IsolationValve',
      hierarchy: 'S1/U10',
      componentType: 'valveGate',
      dn: 100,
      spec: 'CS150',
      line: '100-P-1001-CS150',
      status: 'modelled',
      element: valveId,
    });
    expect(Number(list.rows[0]?.['lengthMm'])).toBeGreaterThan(100);
    expect(list.totals).toEqual({ valves: 1, modelled: 1, reserved: 0, unclassified: 0 });
    expect(list.method).toBe('none');
  });

  it('valves no plant object stands for are unclassified in the whole-plant list only; reserved valve tags are listed too', () => {
    const scene = valveScene();
    let doc = withLibrary(scene.doc);
    expect(report(doc, { kind: 'valve_list' }).rows).toEqual([
      expect.objectContaining({ tag: 'XV-1001', status: 'unclassified', className: null, element: scene.valveId }),
    ]);
    expect(report(doc, { kind: 'valve_list', hierarchy: 'U10' }).total).toBe(0);
    doc = apply(doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'CheckValve',
      hierarchy: 'U10',
      tagFields: { valveCode: 'NRV', seq: 1002 },
    });
    const list = report(doc, { kind: 'valve_list' });
    expect(list.rows.map((row) => [row['tag'], row['status']])).toEqual([
      ['NRV-1002', 'reserved'],
      ['XV-1001', 'unclassified'],
    ]);
    expect(report(doc, { kind: 'valve_list', hierarchy: 'U10' }).rows.map((row) => row['tag'])).toEqual(['NRV-1002']);
    expect(list.totals).toEqual({ valves: 2, modelled: 0, reserved: 1, unclassified: 1 });
  });

  it('the SC-DAT-02 scene: two classified valves, a passing check and a CSV with the header', () => {
    const doc = scDat02Document();
    const list = report(doc, { kind: 'valve_list' });
    expect(list.rows.map((row) => row['tag'])).toEqual(['NRV-1002', 'XV-1001']);
    expect(list.rows.map((row) => row['className'])).toEqual(['CheckValve', 'IsolationValve']);
    expect(data<{ status: string }>(doc, 'check_plant_data', {}).status).toBe('pass');
    const csv =
      data<{ files: Array<{ content: string }> }>(doc, 'plant_report', { kind: 'valve_list', format: 'csv' }).files[0]?.content ?? '';
    expect(csv.startsWith('Tag,Class,Hierarchy,Component type,DN,Face to face (mm)')).toBe(true);
  });

  it('a valve moved by 02 RTE keeps its row, and its tag cannot be changed from DAT (the tag is owned by insert_inline_component)', () => {
    const { doc, valveId } = classified();
    expectRefusal(doc, 'unassign_plant_object', { objects: ['XV-9999'] }, 'DAT_OBJECT_UNKNOWN');
    const own = apply(withLibrary(valveScene().doc), 'define_plant_class', { name: 'MyValve', parent: 'IsolationValve' });
    const tagged = apply(own, 'assign_plant_object', { target: valveId, className: 'MyValve', hierarchy: 'U10' });
    expectRefusal(
      tagged,
      'set_tag_format',
      { className: 'MyValve', tagFormat: '{valveCode}/{seq:4}', retag: true },
      'DAT_TARGET_TAG_READONLY',
    );
    const moved = apply(doc, 'move_inline_component', {
      runId: Object.keys(doc.plant?.piping?.runs ?? {})[0] as string,
      componentId: valveId,
      delta: 100,
    });
    expect(report(moved, { kind: 'valve_list' }).rows[0]).toMatchObject({ tag: 'XV-1001', status: 'modelled' });
  });

  it('a removed valve leaves an orphan row', () => {
    const { doc, valveId } = classified();
    const removed = apply(doc, 'remove_inline_component', {
      runId: Object.keys(doc.plant?.piping?.runs ?? {})[0] as string,
      componentId: valveId,
    });
    expect(report(removed, { kind: 'valve_list' }).rows[0]).toMatchObject({ tag: 'XV-1001', status: 'orphan', dn: null, lengthMm: null });
  });
});

describe('mto of routed runs with the take-outs of 01 PSC', () => {
  it('counts the pipe by cut length (shorter than the centreline) and every fitting in ea, as piping_takeoff derives them', () => {
    const scene = valveScene();
    const doc = apply(withLibrary(scene.doc), 'assign_plant_object', {
      target: scene.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    const takeoff = data<{ totalPipeMm: number; centrelineLengthMm: number; parts: Array<{ kind: string; typeKey: string }> }>(
      doc,
      'piping_takeoff',
      {},
    );
    const mto = report(doc, { kind: 'mto' });
    expect(mto.method).toBe('cutLength');
    const pipe = mto.rows.filter((row) => row['itemType'] === 'pipe');
    expect(pipe.every((row) => row['unit'] === 'm' && row['spec'] === 'CS150')).toBe(true);
    expect(mto.totals['pipeM']).toBeCloseTo(takeoff.totalPipeMm / 1000, 5);
    expect(mto.totals['pipeM']).toBeLessThan(takeoff.centrelineLengthMm / 1000);
    expect(pipe[0]?.['source']).toContain('cut length, take-outs deducted of 1 line(s): 100-P-1001-CS150');
    const parts = Object.fromEntries(
      mto.rows.filter((row) => row['unit'] === 'ea').map((row) => [`${row['itemType']}/${row['nominalSize']}`, row['quantity']]),
    );
    expect(parts['valveGate/100']).toBe(1);
    const partCounts = new Map<string, number>();
    for (const part of takeoff.parts) if (part.kind !== 'pipe') partCounts.set(part.typeKey, (partCounts.get(part.typeKey) ?? 0) + 1);
    expect(partCounts.size).toBeGreaterThan(3);
    for (const [key, count] of partCounts) {
      const total = mto.rows.filter((row) => row['itemType'] === key).reduce((sum, row) => sum + Number(row['quantity']), 0);
      expect(total, key).toBe(count);
    }
    expect(mto.rows.findIndex((row) => row['itemType'] === 'pipe')).toBe(0);
    expect(mto.totals['items']).toBe(mto.rows.filter((row) => row['unit'] === 'ea').reduce((sum, row) => sum + Number(row['quantity']), 0));
  });

  it('can group the routed items by line, and a legacy pipe next to routed runs makes the method mixed', () => {
    const scene = routedPumpToVessel();
    let doc = withLibrary(scene.doc);
    doc = apply(doc, 'assign_plant_object', {
      target: scene.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    const grouped = report(doc, { kind: 'mto', groupBy: ['line', 'itemType'] });
    expect(new Set(grouped.rows.map((row) => row['line']))).toEqual(new Set(['100-P-1001-CS150']));
    const pipe = addPipe(doc, { dn: 100 });
    doc = apply(pipe.doc, 'assign_plant_object', {
      target: pipe.id,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 100, fluidCode: 'P', seq: 5, spec: 'CS150' },
    });
    const mixed = report(doc, { kind: 'mto' });
    expect(mixed.method).toBe('mixed');
    expect(String(mixed.rows.find((row) => row['itemType'] === 'pipe')?.['source'])).toContain('centreline + cut length');
    expect(mixed.rows.some((row) => row['itemType'] === 'bend')).toBe(false);
  });

  it('a run that no longer derives falls back to its centreline and says so', () => {
    const scene = routedPumpToVessel();
    const classifiedDoc = apply(withLibrary(scene.doc), 'assign_plant_object', {
      target: scene.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    const doc = withoutSpecs(classifiedDoc);
    const mto = report(doc, { kind: 'mto' });
    expect(mto.method).toBe('centreline');
    expect(mto.rows.map((row) => row['itemType'])).toEqual(['pipe', 'bend']);
    expect(String(mto.rows[0]?.['source'])).toContain('unverified');
    expect(mto.rows[0]).toMatchObject({ nominalSize: 100, unit: 'm' });
  });
});

describe('instrument_index and the tags reserved by the P&ID', () => {
  const pidScene = (): CadDocument => withLibrary(feedPumpControlled());
  const instrumentIds = (doc: CadDocument): Record<string, string> =>
    Object.fromEntries(
      Object.values(getPid(doc).items).flatMap((item) =>
        item.kind === 'instrument' && item.tag !== undefined ? [[item.tag, item.id]] : [],
      ),
    );

  it('lists every P&ID instrument with its ISA facts, unclassified until a plant object stands for it', () => {
    const doc = pidScene();
    const index = report(doc, { kind: 'instrument_index' });
    const ids = instrumentIds(doc);
    expect(index.total).toBe(2);
    expect(index.rows.map((row) => row['tag'])).toEqual(['FIC-101', 'FT-101']);
    expect(index.rowsByTag?.['FT-101']).toMatchObject({
      status: 'unclassified',
      className: null,
      category: 'F',
      functions: 'T',
      location: 'field',
      sheet: 'PID-001',
      element: ids['FT-101'],
    });
    expect(index.rowsByTag?.['FIC-101']).toMatchObject({ location: 'central', display: 'shared', controls: 'FV-101' });
    expect(index.rowsByTag?.['FT-101']?.['measuredLine']).toBe('tee:80-P-1002-A1');
    expect(index.totals).toEqual({ instruments: 2, modelled: 0, unclassified: 2 });
    expect(report(doc, { kind: 'instrument_index', hierarchy: 'U10' }).total).toBe(0);
  });

  it('a classified instrument adopts the tag of the P&ID, takes its hierarchy and class, and is the only one left in a hierarchy report', () => {
    let doc = apply(pidScene(), 'define_plant_class', { name: 'Instrument', tagFormat: '{functions}-{seq:3}', properties: [] });
    const ids = instrumentIds(doc);
    doc = apply(doc, 'assign_plant_object', {
      target: { provider: 'pidInstrument', id: ids['FIC-101'] as string },
      className: 'Instrument',
      hierarchy: 'U10',
    });
    expect(Object.values(getPlantData(doc).objects)[0]).toMatchObject({
      tag: 'FIC-101',
      target: { kind: 'provider', provider: 'pidInstrument' },
    });
    const index = report(doc, { kind: 'instrument_index' });
    expect(index.rowsByTag?.['FIC-101']).toMatchObject({
      className: 'Instrument',
      hierarchy: 'S1/U10',
      status: 'modelled',
      id: expect.stringMatching(/^plantobj-/),
    });
    expect(index.rowsByTag?.['FT-101']).toMatchObject({ status: 'unclassified' });
    expect(index.totals).toEqual({ instruments: 2, modelled: 1, unclassified: 1 });
    expect(report(doc, { kind: 'instrument_index', hierarchy: 'U10' }).rows.map((row) => row['tag'])).toEqual(['FIC-101']);
    const register = report(doc, { kind: 'tag_register' });
    expect(register.rowsByTag?.['FIC-101']).toMatchObject({ status: 'modelled', targetKind: 'pidInstrument', className: 'Instrument' });
    expect(register.rowsByTag?.['FT-101']).toMatchObject({ status: 'reserved', targetKind: 'pidInstrument', className: null });
    expect(register.totals).toEqual({ tags: 2, modelled: 1, reserved: 1, orphan: 0 });
    expect(report(doc, { kind: 'tag_register', hierarchy: 'U10' }).rows.map((row) => row['tag'])).toEqual(['FIC-101']);
  });

  it('P&ID instrument tags are reserved against plant tags: a duplicate is refused, and the provider cannot rename an instrument', () => {
    const doc = apply(pidScene(), 'define_plant_class', { name: 'Instrument', tagFormat: '{functions}-{seq:3}', properties: [] });
    const duplicate = expectRefusal(
      doc,
      'assign_plant_object',
      { target: 'reserved', className: 'Instrument', hierarchy: 'U10', tagFields: { functions: 'FT', seq: 101 } },
      'DAT_TAG_DUPLICATE',
      'tag',
    );
    expect(duplicate.summary).toContain('FT-101');
    const id = instrumentIds(doc)['FT-101'] as string;
    expectRefusal(
      doc,
      'assign_plant_object',
      { target: { provider: 'pidInstrument', id }, className: 'Instrument', hierarchy: 'U10', tag: 'FT-102' },
      'DAT_TARGET_TAG_READONLY',
      'tag',
    );
    expectRefusal(
      doc,
      'assign_plant_object',
      { target: { provider: 'pidInstrument', id: 'pid-nope' }, className: 'Instrument', hierarchy: 'U10' },
      'DAT_TARGET_UNKNOWN',
      'target',
    );
    // a plant object may reuse the free tag of another sequence, and a line end that names an instrument tag resolves
    const free = apply(doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'Instrument',
      hierarchy: 'U10',
      tagFields: { functions: 'FT', seq: 102 },
    });
    expect(Object.values(getPlantData(free).objects).map((object) => object.tag)).toEqual(['FT-102']);
  });

  it('the provider lists only tagged instruments, never the equipment or valves the P&ID shares with 3D', () => {
    const doc = pidScene();
    const provider = getProvider('pidInstrument');
    expect(provider?.elements(doc).map((element) => element.tag)).toEqual(['FT-101', 'FIC-101']);
    expect(provider?.element(doc, 'T-101')).toBeUndefined();
    const equipment = Object.values(getPid(doc).items).find((item) => item.kind === 'equipment');
    expect(provider?.element(doc, equipment?.id ?? '')).toBeUndefined();
    expect(data<{ findings: unknown[] }>(doc, 'check_plant_data', {}).findings).toEqual([]);
  });
});

describe('purity, replay and persistence with the sibling hooks', () => {
  it('the new report kinds change nothing, are deterministic and survive replay_history', () => {
    const scene = valveScene();
    const doc = apply(withLibrary(scene.doc), 'assign_plant_object', {
      target: scene.valveId,
      className: 'IsolationValve',
      hierarchy: 'U10',
    });
    const before = JSON.stringify(doc);
    for (const kind of ['valve_list', 'instrument_index', 'nozzle_schedule', 'mto', 'tag_register']) {
      const first = execute(doc, 'plant_report', { kind });
      expect(first.document, kind).toBe(doc);
      expect(first.affected).toEqual([]);
      expect(execute(doc, 'plant_report', { kind }).data, kind).toEqual(first.data);
    }
    expect(JSON.stringify(doc)).toBe(before);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(replayed.plant?.data).toEqual(doc.plant?.data);
    expect(report(replayed, { kind: 'valve_list' })).toEqual(report(doc, { kind: 'valve_list' }));
  });

  it('plant objects of the new provider targets round-trip through export_plant_data and import_plant_data unchanged', () => {
    const scene = valveScene();
    let doc = apply(withLibrary(scene.doc), 'define_plant_class', NOZZLE_CLASS);
    doc = apply(doc, 'assign_plant_object', { target: scene.valveId, className: 'IsolationValve', hierarchy: 'U10' });
    doc = apply(doc, 'assign_plant_object', {
      target: { provider: 'nozzle', id: `${equipmentId(doc, 'V-101')}:N1` },
      className: 'Nozzle',
      hierarchy: 'U10',
      nextSequence: true,
    });
    const exported = data<{ files: Array<{ base64?: string }> }>(doc, 'export_plant_data', {
      classes: ['Valve', 'Nozzle'],
      format: 'xlsx',
    });
    const file = exported.files[0]?.base64;
    expect(file).toBeDefined();
    const imported = execute(doc, 'import_plant_data', { fileBase64: file, mode: 'preview' });
    expect(imported.rejected, imported.summary).toBeUndefined();
    expect(imported.document).toBe(doc);
    const saved = JSON.parse(JSON.stringify(doc.plant?.data)) as unknown;
    expect(saved).toEqual(doc.plant?.data);
  });

  it('save and load keep the objects that stand for nozzles, valves and P&ID instruments, and the reports on the loaded file agree', () => {
    let doc = apply(withLibrary(feedPumpControlled()), 'define_plant_class', {
      name: 'Instrument',
      tagFormat: '{functions}-{seq:3}',
      properties: [],
    });
    const instrument = Object.values(getPid(doc).items).find((item) => item.kind === 'instrument' && item.tag === 'FT-101')?.id as string;
    doc = apply(doc, 'assign_plant_object', {
      target: { provider: 'pidInstrument', id: instrument },
      className: 'Instrument',
      hierarchy: 'U10',
    });
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.plant?.data).toEqual(doc.plant?.data);
    expect(report(loaded, { kind: 'instrument_index' })).toEqual(report(doc, { kind: 'instrument_index' }));
    expect(report(loaded, { kind: 'tag_register' })).toEqual(report(doc, { kind: 'tag_register' }));
  });
});

describe('budgets (generous bounds)', () => {
  it('3000 P&ID instruments and 3000 reserved valves: the reports answer in seconds and a tag held by an instrument is refused', () => {
    const count = 3000;
    const items: Record<string, PidInstrument> = {};
    for (let k = 0; k < count; k += 1)
      items[`pid-1.${k}`] = {
        id: `pid-1.${k}`,
        kind: 'instrument',
        sheetId: 'sheet-1',
        at: [10, 10],
        rotationDeg: 0,
        dexpiClass: 'ProcessInstrumentationFunction',
        tag: `PT-${1000 + k}`,
        attributes: {},
        category: 'P',
        functions: 'T',
        loopNumber: String(1000 + k),
        location: 'field',
        display: 'discrete',
      };
    const pid = {
      ...EMPTY_PID,
      sheets: {
        'sheet-1': { id: 'sheet-1', number: 'PID-001', title: 't', paper: 'A3' as const, revision: 'A', status: 'draft' as const },
      },
      sheetOrder: ['sheet-1'],
      items,
      itemOrder: Object.keys(items),
    };
    const csv = ['Tag', ...Array.from({ length: count }, (_, k) => `XV-${1000 + k}`)].join(String.fromCharCode(10));
    const doc = apply(withPid(withLibrary(createEmptyDocument()), pid), 'import_tag_list', {
      className: 'IsolationValve',
      hierarchy: 'U10',
      csv,
      mode: 'apply',
    });
    const started = performance.now();
    const index = report(doc, { kind: 'instrument_index' });
    const valves = report(doc, { kind: 'valve_list' });
    const register = report(doc, { kind: 'tag_register' });
    const timing = performance.now() - started;
    expect(index.total).toBe(count);
    expect(valves.total).toBe(count);
    expect(register.total).toBe(count * 2);
    expect(timing).toBeLessThan(15000);
    const refused = expectRefusal(
      doc,
      'assign_plant_object',
      { target: 'reserved', className: 'IsolationValve', hierarchy: 'U10', tag: 'PT-1500' },
      'DAT_TAG_DUPLICATE',
    );
    expect(refused.summary).toContain('PT-1500');
  });
});
