import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { expectRefusal, ok } from '../../../helpers/commandAssertions';

/** Two DN100 tie-ins and one routed run between them. */
function routed(): { doc: CadDocument; runId: string; params: Record<string, unknown> } {
  let doc = createEmptyDocument();
  const tie = (tag: string, position: [number, number, number], direction: [number, number, number]): string => {
    const result = ok(doc, 'add_tie_in_point', { tag, position, direction, dn: 100, endType: 'BW' });
    doc = result.document;
    return result.affected[0] as string;
  };
  const p1 = tie('DR-1', [0, 0, 0], [1, 0, 0]);
  const p2 = tie('DR-2', [3000, 2000, 1000], [0, 0, -1]);
  const line = ok(doc, 'create_pipeline', { service: 'P', sequence: '8101', spec: 'CS150', dn: 100 });
  const params = { lineId: line.affected[0], from: { portId: p1 }, to: { portId: p2 } };
  const route = ok(line.document, 'auto_route_pipe', params);
  return { doc: route.document, runId: route.affected[0] as string, params };
}

describe('delete_pipe_run', () => {
  it('removes the run and its tube, keeps the line and tie-ins, and frees the ports for a re-route', () => {
    const s = routed();
    expect(s.doc.entities[s.runId]).toBeDefined();
    const deleted = ok(s.doc, 'delete_pipe_run', { runId: s.runId });
    expect(deleted.affected).toEqual([s.runId]);
    expect(deleted.document.entities[s.runId]).toBeUndefined();
    expect(deleted.document.order).not.toContain(s.runId);
    expect(deleted.document.plant?.piping?.runOrder).toEqual([]);
    expect(deleted.document.plant?.piping?.tieInOrder).toHaveLength(2);
    expect(deleted.document.plant?.piping?.lineOrder).toHaveLength(1);
    expect(ok(deleted.document, 'auto_route_pipe', s.params).affected).toHaveLength(1);
  });

  it('is pure', () => {
    const s = routed();
    const snapshot = JSON.stringify(s.doc);
    execute(s.doc, 'delete_pipe_run', { runId: s.runId });
    expect(JSON.stringify(s.doc)).toBe(snapshot);
  });

  it('refuses an unknown run (RTE_UNKNOWN_RUN)', () => {
    expectRefusal(routed().doc, 'delete_pipe_run', { runId: 'run-nope' }, 'RTE_UNKNOWN_RUN', 'runId');
  });

  it('survives replay: the run stays deleted', () => {
    const s = routed();
    const deleted = ok(s.doc, 'delete_pipe_run', { runId: s.runId }).document;
    const replayed = execute(deleted, 'replay_history', {}).document;
    expect(replayed.plant?.piping?.runOrder).toEqual([]);
    expect(replayed.entities[s.runId]).toBeUndefined();
  });
});
