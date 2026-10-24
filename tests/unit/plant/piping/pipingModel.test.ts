import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { pipingDocument } from '@aec/plant/piping/derive';
import { pipingErrors } from '@aec/plant/piping/validate';
import { TOOLSETS } from '@protocol/toolsets';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Document, rteJson } from './rteFixtures';

const tieIn = { tag: 'TP-1', position: [0, 0, 1000], direction: [0, 0, 2], dn: 100, endType: 'FL', rating: 'CL150', facing: 'RF' };

describe('add_tie_in_point', () => {
  it('adds a tie-in with a normalised direction', () => {
    const result = ok(createEmptyDocument(), 'add_tie_in_point', tieIn);
    const id = result.affected[0] as string;
    const stored = result.document.plant?.piping?.tieIns[id];
    expect(stored).toEqual({
      id,
      tag: 'TP-1',
      kind: 'tie_in',
      port: { position: [0, 0, 1000], direction: [0, 0, 1], dn: 100, endType: 'FL', rating: 'CL150', facing: 'RF' },
    });
    expect(result.summary).toContain('TP-1');
    expect(Object.keys(result.document.entities)).toHaveLength(0);
  });

  it('refuses a zero direction and a duplicate tag', () => {
    const doc = createEmptyDocument();
    expectRefusal(doc, 'add_tie_in_point', { ...tieIn, direction: [0, 0, 0] }, 'RTE_INVALID_PORT', 'direction');
    const once = apply(doc, 'add_tie_in_point', tieIn);
    expectRefusal(once, 'add_tie_in_point', { ...tieIn, kind: 'battery_limit' }, 'RTE_DUPLICATE_TAG', 'tag');
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    const before = structuredClone(doc);
    execute(doc, 'add_tie_in_point', tieIn);
    expect(doc).toEqual(before);
  });
});

describe('create_pipeline', () => {
  it('numbers the line from the template, insulation code included (SC-RTE-07 line number), and resolves the spec', () => {
    const result = data<{
      lineNumber: string;
      template: { defaulted: boolean };
      unverified: boolean;
      spec: { id: string; revision: number; status: string };
      pipe: { outsideDiameterMm: number; wallMm: number };
    }>(cs150Document(), 'create_pipeline', {
      service: 'HO',
      sequence: '4001',
      spec: 'CS150',
      dn: 80,
      insulation: { code: 'H', thicknessMm: 50 },
      designTempC: 180,
      from: 'E-201',
    });
    expect(result.lineNumber).toBe('80-HO-4001-CS150-H50');
    expect(result.template.defaulted).toBe(true);
    expect(result.unverified).toBe(true);
    expect(result.spec).toEqual({ id: 'CS150', revision: 1, status: 'draft' });
    // NPS 3 Sch 40 from the bundled B36.10M rows.
    expect(result.pipe.outsideDiameterMm).toBe(88.9);
    expect(result.pipe.wallMm).toBe(5.49);
  });

  it('keeps an explicit line number and refuses a duplicate, an unknown spec and a DN the spec has no pipe for', () => {
    const doc = cs150Document();
    const params = { service: 'P', sequence: '1001', spec: 'CS150', dn: 100, lineNumber: 'L-1' };
    const created = ok(doc, 'create_pipeline', params);
    const id = created.affected[0] as string;
    expect(created.document.plant?.piping?.lines[id]).toEqual({
      id,
      lineNumber: 'L-1',
      service: 'P',
      sequence: '1001',
      spec: 'CS150',
      dn: 100,
    });
    expectRefusal(created.document, 'create_pipeline', params, 'RTE_DUPLICATE_LINE_NUMBER', 'sequence');
    expectRefusal(doc, 'create_pipeline', { ...params, dn: 700 }, 'RTE_SPEC_NO_COMPONENT', 'dn');
    expectRefusal(doc, 'create_pipeline', { ...params, spec: 'NOPE' }, 'RTE_SPEC_UNKNOWN', 'spec');
    expectRefusal(createEmptyDocument(), 'create_pipeline', params, 'RTE_SPEC_UNKNOWN', 'spec');
  });

  it('refuses a spec whose catalogue is not loaded (it would silently read other dimensions)', () => {
    const mm = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    const noCatalog = apply(mm, 'import_pipe_spec', { spec: rteJson('spec_cs150.json') });
    const result = expectRefusal(noCatalog, 'create_pipeline', { service: 'P', sequence: '1', spec: 'CS150', dn: 100 }, 'RTE_SPEC_UNKNOWN');
    expect(result.summary).toContain('rte-validation-stub');
  });

  it('is pure', () => {
    const doc = cs150Document();
    const before = structuredClone(doc);
    execute(doc, 'create_pipeline', { service: 'P', sequence: '1', spec: 'CS150', dn: 50 });
    expect(doc).toEqual(before);
  });
});

/** A document with one auto-routed run (SC-RTE-08 geometry). */
function routed(): { doc: CadDocument; runId: string } {
  let doc = cs150Document();
  const ids: string[] = [];
  for (const [tag, position, direction] of [
    ['A', [0, 0, 0], [1, 0, 0]],
    ['B', [3000, 2000, 1000], [0, 0, -1]],
  ] as const) {
    const result = ok(doc, 'add_tie_in_point', { tag, position, direction, dn: 100, endType: 'BW' });
    doc = result.document;
    ids.push(result.affected[0] as string);
  }
  const line = ok(doc, 'create_pipeline', { service: 'P', sequence: '8001', spec: 'CS150', dn: 100 });
  const run = ok(line.document, 'auto_route_pipe', { lineId: line.affected[0], from: { portId: ids[0] }, to: { portId: ids[1] } });
  return { doc: run.document, runId: run.affected[0] as string };
}

describe('piping document extension', () => {
  it('omits the run parts from saved files and re-derives them on load', () => {
    const { doc, runId } = routed();
    const partIds = doc.plant?.piping?.entityIds[runId] ?? [];
    expect(partIds.length).toBe(5);
    const saved = serializeDocument(doc);
    for (const id of partIds) expect(JSON.parse(saved).document.entities[id]).toBeUndefined();
    const loaded = deserializeDocument(saved);
    for (const id of partIds) expect(loaded.entities[id]).toEqual(doc.entities[id]);
    expect(loaded.plant).toEqual(doc.plant);
    expect(loaded.layers['layer-P-PIPE']).toBeDefined();
    expect(loaded.layers['layer-P-FITT']).toBeDefined();
    expect(pipingDocument.derivedEntityIds(doc)).toEqual(new Set(partIds));
  });

  it('refuses a direct edit of a derived part (derivation guard)', () => {
    const { doc, runId } = routed();
    const part = doc.plant?.piping?.entityIds[runId]?.[0] as string;
    const result = execute(doc, 'delete_entities', { ids: [part] });
    expect(result.rejected).toBe(true);
    expect(result.summary).toContain('pipe part');
  });

  it('refuses a spec edit that would leave a routed run without its elbow (and allows one that keeps it)', () => {
    const { doc } = routed();
    const refused = execute(doc, 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'removeComponent', id: 'E90-LR' }] });
    expect(refused.rejected).toBe(true);
    expect(refused.summary).toContain('without a derivable spec part');
    const kept = execute(doc, 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'setHeader', fields: { title: 'CS150 retitled' } }] });
    expect(kept.rejected).toBeUndefined();
  });

  it('clear_document removes the plant slice', () => {
    const { doc } = routed();
    expect(apply(doc, 'clear_document', {}).plant).toBeUndefined();
  });

  it('reports value errors of a malformed plant slice and leaves it unrestored', () => {
    expect(pipingDocument.validate({})).toEqual([]);
    expect(pipingDocument.validate({ plant: 3 })).toEqual(['plant must be an object']);
    expect(pipingDocument.validate({ plant: {} })).toEqual([]);
    expect(pipingErrors(null)).toEqual(['plant.piping must be an object']);
    const empty = { tieIns: {}, tieInOrder: [], lines: {}, lineOrder: [], runs: {}, runOrder: [], entityIds: {} };
    expect(pipingErrors(empty)).toEqual([]);
    expect(pipingErrors({ ...empty, entityIds: undefined })).toEqual(['plant.piping.entityIds must be an object']);
    expect(pipingErrors({ ...empty, entityIds: { r: ['a'] } })).toEqual(['plant.piping.entityIds.r must list entity ids of a run']);
    expect(pipingErrors({ ...empty, tieIns: [] })).toEqual(['plant.piping.tieIns must be an object']);
    expect(pipingErrors({ ...empty, lineOrder: ['x'] })).toEqual(['plant.piping.lineOrder must list the ids of plant.piping.lines']);
    expect(pipingErrors({ ...empty, lines: { a: { id: 'a', lineNumber: 'L', spec: 'S', dn: 1 } } })).toEqual([
      'plant.piping.lineOrder must list every id of plant.piping.lines once',
    ]);
    expect(pipingErrors({ ...empty, tieIns: { t: { id: 'x' } }, tieInOrder: ['t'] })).toEqual([
      'plant.piping.tieIns.t must be an object with id "t"',
    ]);
    expect(pipingErrors({ ...empty, tieIns: { t: { id: 't', tag: 'T' } }, tieInOrder: ['t'] })[0]).toContain('needs a tag and a port');
    expect(pipingErrors({ ...empty, lines: { l: { id: 'l', dn: 0 } }, lineOrder: ['l'] })[0]).toContain('positive dn');
    const badRun = { id: 'r', lineId: 'nope', start: {}, end: { point: [0, 0, 0], direction: [1] }, pis: [[0, 0]] };
    expect(pipingErrors({ ...empty, runs: { r: badRun }, runOrder: ['r'] })).toEqual([
      'plant.piping.runs.r.lineId must name a line',
      'plant.piping.runs.r.start needs a finite point',
      'plant.piping.runs.r.end needs a finite point',
      'plant.piping.runs.r.pis must be [x, y, z] points',
    ]);
    const badRef = { id: 'r', lineId: 'l', start: { point: [0, 0, 0], ref: { kind: 'wormhole' } }, end: { point: [1, 0, 0] }, pis: [] };
    const withLine = { ...empty, lines: { l: { id: 'l', lineNumber: 'L', spec: 'S', dn: 1 } }, lineOrder: ['l'] };
    expect(pipingErrors({ ...withLine, runs: { r: badRef }, runOrder: ['r'] })).toEqual([
      'plant.piping.runs.r.start.ref must be a tieIn, nozzle, runEnd or branch reference',
    ]);
    const goodRefs = [
      { kind: 'tieIn', id: 't' },
      { kind: 'nozzle', equipmentId: 'e', nozzleId: 'N1' },
      { kind: 'runEnd', runId: 'r', end: 'end' },
    ];
    for (const ref of goodRefs)
      expect(
        pipingErrors({ ...withLine, runs: { r: { ...badRef, start: { point: [0, 0, 0], ref } } }, runOrder: ['r'], entityIds: { r: [] } }),
      ).toEqual([]);
    const raw = { plant: { piping: { ...empty, runs: { r: badRun }, runOrder: ['r'] } }, entities: {}, order: [] };
    expect(pipingDocument.restore(raw)).toBe(raw);
    expect(pipingDocument.restore({ entities: {}, order: [] })).toEqual({ entities: {}, order: [] });
  });

  it('restores a run whose spec is missing as a run without geometry (no throw)', () => {
    const { doc, runId } = routed();
    const raw = JSON.parse(serializeDocument(doc)).document as Record<string, unknown>;
    const plant = raw['plant'] as { spec?: unknown };
    delete plant.spec;
    const restored = pipingDocument.restore(raw) as { plant: { piping: { entityIds: Record<string, string[]> } } };
    expect(restored.plant.piping.entityIds[runId]).toEqual([]);
  });

  it('restores a run on a malformed spec slice as a run without geometry instead of throwing', () => {
    const { doc, runId } = routed();
    const raw = JSON.parse(serializeDocument(doc)).document as Record<string, unknown>;
    (raw['plant'] as Record<string, unknown>)['spec'] = 5;
    const restored = pipingDocument.restore(raw) as { plant: { piping: { entityIds: Record<string, string[]> } } };
    expect(restored.plant.piping.entityIds[runId]).toEqual([]);
  });

  it('lists the plant piping commands in the piping toolset', () => {
    expect(TOOLSETS.piping).toEqual(
      expect.arrayContaining([
        'add_pipe_run',
        'add_tie_in_point',
        'create_pipeline',
        'route_pipe',
        'piping_takeoff',
        'route_problem',
        'auto_route_pipe',
        'delete_pipe_run',
      ]),
    );
  });
});
