import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document, cs150Line } from './rteFixtures';

/** Two DN100 tie-ins and one routed run between them. */
function routed(): { doc: CadDocument; runId: string; params: Record<string, unknown> } {
  let doc = cs150Document();
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
  it('removes the run and every derived part, keeps the line and tie-ins, and frees the ports for a re-route', () => {
    const s = routed();
    const parts = s.doc.plant?.piping?.entityIds[s.runId] ?? [];
    expect(parts).toHaveLength(5);
    for (const part of parts) expect(s.doc.entities[part]).toBeDefined();
    const deleted = ok({ ...s.doc, selection: [parts[0] as string] }, 'delete_pipe_run', { runId: s.runId });
    expect(deleted.document.selection).toEqual([]);
    expect(deleted.affected).toEqual([s.runId]);
    for (const part of parts) {
      expect(deleted.document.entities[part]).toBeUndefined();
      expect(deleted.document.order).not.toContain(part);
    }
    expect(deleted.document.plant?.piping?.entityIds).toEqual({});
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
    expect(replayed.plant?.piping?.entityIds).toEqual({});
  });

  it('refuses to delete a run another run continues from (RTE_HAS_BRANCHES), and deleting the dependent first works', () => {
    const { doc: withLine, lineId } = cs150Line();
    const { doc, id: tie } = addTie(withLine, 'T-1', [0, 0, 0], [1, 0, 0]);
    const first = ok(doc, 'route_pipe', { lineId, from: { portId: tie }, legs: [{ direction: '+X', length: 2000 }] });
    const firstId = first.affected[0] as string;
    const second = ok(first.document, 'route_pipe', {
      lineId,
      from: { portId: `${firstId}:end` },
      legs: [{ direction: '+X', length: 1000 }],
    });
    const secondId = second.affected[0] as string;
    expect(second.document.plant?.piping?.runs[secondId]?.start).toMatchObject({
      point: [2000, 0, 0],
      ref: { kind: 'runEnd', runId: firstId, end: 'end' },
    });
    const refused = expectRefusal(second.document, 'delete_pipe_run', { runId: firstId }, 'RTE_HAS_BRANCHES', 'runId');
    expect(refused.error?.ids).toEqual([firstId, secondId]);
    const removed = ok(second.document, 'delete_pipe_run', { runId: secondId });
    expect(ok(removed.document, 'delete_pipe_run', { runId: firstId }).document.plant?.piping?.runOrder).toEqual([]);
  });
});
