import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { pipingDocument } from '@aec/plant/piping/derive';
import { pipingErrors } from '@aec/plant/piping/validate';
import { TOOLSETS } from '@protocol/toolsets';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';

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
  it('numbers the line from the template, insulation code included (SC-RTE-07 line number)', () => {
    const result = data<{ lineNumber: string; template: { defaulted: boolean }; unverified: boolean }>(
      createEmptyDocument(),
      'create_pipeline',
      {
        service: 'HO',
        sequence: '4001',
        spec: 'CS150',
        dn: 80,
        insulation: { code: 'H', thicknessMm: 50 },
        designTempC: 180,
        from: 'E-201',
      },
    );
    expect(result.lineNumber).toBe('80-HO-4001-CS150-H50');
    expect(result.template.defaulted).toBe(true);
    expect(result.unverified).toBe(true);
  });

  it('keeps an explicit line number and refuses a duplicate or a DN without a pipe row', () => {
    const doc = createEmptyDocument();
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
    expectRefusal(doc, 'create_pipeline', { ...params, dn: 90 }, 'RTE_SPEC_NO_COMPONENT', 'dn');
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    const before = structuredClone(doc);
    execute(doc, 'create_pipeline', { service: 'P', sequence: '1', spec: 'CS150', dn: 50 });
    expect(doc).toEqual(before);
  });
});

/** A document with one auto-routed run (SC-RTE-08 geometry). */
function routed(): { doc: CadDocument; runId: string } {
  let doc = createEmptyDocument();
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
  it('omits the run mesh from saved files and re-derives it on load', () => {
    const { doc, runId } = routed();
    const saved = serializeDocument(doc);
    expect(JSON.parse(saved).document.entities[runId]).toBeUndefined();
    const loaded = deserializeDocument(saved);
    expect(loaded.entities[runId]).toEqual(doc.entities[runId]);
    expect(loaded.plant).toEqual(doc.plant);
    expect(loaded.layers['layer-P-PIPE']).toBeDefined();
    expect(pipingDocument.derivedEntityIds(doc)).toEqual(new Set([runId]));
  });

  it('refuses a direct edit of the derived run mesh (derivation guard)', () => {
    const { doc, runId } = routed();
    const result = execute(doc, 'delete_entities', { ids: [runId] });
    expect(result.rejected).toBe(true);
    expect(result.summary).toContain('pipe run');
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
    const empty = { tieIns: {}, tieInOrder: [], lines: {}, lineOrder: [], runs: {}, runOrder: [] };
    expect(pipingErrors(empty)).toEqual([]);
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
    const raw = { plant: { piping: { ...empty, runs: { r: badRun }, runOrder: ['r'] } }, entities: {}, order: [] };
    expect(pipingDocument.restore(raw)).toBe(raw);
    expect(pipingDocument.restore({ entities: {}, order: [] })).toEqual({ entities: {}, order: [] });
  });

  it('lists the plant piping commands in the piping toolset', () => {
    expect(TOOLSETS.piping).toEqual(
      expect.arrayContaining(['add_pipe_run', 'add_tie_in_point', 'create_pipeline', 'route_problem', 'auto_route_pipe']),
    );
  });
});
