/**
 * Plant 02 RTE V1c (SC-RTE-22 .. 24): the level of a run from its elevation, one rule for a support whose run is gone (load = live), and the
 * hint of move_building_element for a support on a run. Hand calculations are in the validation README (D25 .. D27).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { PipeSupportElement } from '@aec/building/types';
import { reconcileRunSupports } from '@aec/plant/piping/supportReconcile';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { expectNoOp } from '../../../helpers/expectNoOp';
import { addTie, cs150Document } from './rteFixtures';

/** A DN80 hot line (CS150) from x 0 to 6000 at height `z`, routed on `doc`; the sequence keeps line numbers apart. */
function lineAt(doc: CadDocument, z: number, sequence: string, y: number): { doc: CadDocument; runId: string } {
  const a = addTie(doc, `TP-${sequence}A`, [0, y, z], [1, 0, 0], { dn: 80 });
  const b = addTie(a.doc, `TP-${sequence}B`, [6000, y, z], [-1, 0, 0], { dn: 80 });
  const created = ok(b.doc, 'create_pipeline', { service: 'HO', sequence, spec: 'CS150', dn: 80 });
  const lineId = created.affected[0] as string;
  const routed = apply(created.document, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
  return { doc: routed, runId: routed.plant?.piping?.runOrder.at(-1) as string };
}

const supportsOf = (doc: CadDocument): PipeSupportElement[] =>
  Object.values(doc.building?.elements ?? {}).filter((element): element is PipeSupportElement => element.category === 'pipeSupport');

interface Row {
  id: string;
}
interface Check {
  ok: boolean;
  pipes: Row[];
  orphans: Array<{ id: string; mark: string; pipeId: string; levelId: string; code: string }>;
  totals: { orphans: number };
}

describe('the level of a run is read from its elevation (V1c, SC-RTE-22)', () => {
  /** Levels at 0 and 3000; a run at z 1000 (Ground: highest level at or below 1000 is 0) and one at z 3000 (Upper: 3000 <= 3000, boundary). */
  function twoLevels(): { doc: CadDocument; low: string; high: string; ground: string; upper: string } {
    const base = apply(apply(cs150Document(), 'add_level', { name: 'Ground', elevation: 0, height: 3000 }), 'add_level', {
      name: 'Upper',
      elevation: 3000,
      height: 3000,
    });
    const low = lineAt(base, 1000, '4001', 0);
    const high = lineAt(low.doc, 3000, '4002', 500);
    const levels = high.doc.building?.levelOrder as string[];
    return { doc: high.doc, low: low.runId, high: high.runId, ground: levels[0] as string, upper: levels[1] as string };
  }

  it('without a filter both runs are listed; the levelId filter selects each by its elevation (not "the first level")', () => {
    const { doc, low, high, ground, upper } = twoLevels();
    expect(data<Check>(doc, 'check_pipe_supports', {}).pipes.map((row) => row.id)).toEqual([low, high]);
    expect(data<Check>(doc, 'check_pipe_supports', { levelId: ground }).pipes.map((row) => row.id)).toEqual([low]);
    expect(data<Check>(doc, 'check_pipe_supports', { levelId: upper }).pipes.map((row) => row.id)).toEqual([high]);
  });

  it('a level that holds no run is a no-op naming the filter', () => {
    const { doc } = twoLevels();
    const roof = apply(doc, 'add_level', { name: 'Roof', elevation: 6000, height: 3000 });
    const levelId = roof.building?.levelOrder.at(-1) as string;
    const result = execute(roof, 'check_pipe_supports', { levelId });
    expectNoOp(result, roof, 'no pipe matches the level / line filter');
  });

  it('add_pipe_support puts the support on the level of the run: the Upper run at z 3000 gives relative z 0, the Ground run at z 1000 gives 1000', () => {
    const { doc, low, high, ground, upper } = twoLevels();
    const onHigh = ok(doc, 'add_pipe_support', { runId: high, at: [[3000, 500, 3000]] }).document;
    const onLow = ok(onHigh, 'add_pipe_support', { runId: low, at: [[3000, 0, 1000]] }).document;
    const [first, second] = supportsOf(onLow);
    expect(first).toMatchObject({ pipeId: high, levelId: upper });
    expect(first?.position[2]).toBeCloseTo(0, 6);
    expect(second).toMatchObject({ pipeId: low, levelId: ground });
    expect(second?.position[2]).toBeCloseTo(1000, 6);
  });

  it('a run below every level belongs to the lowest level', () => {
    const only = apply(cs150Document(), 'add_level', { name: 'Deck', elevation: 3000, height: 3000 });
    const { doc, runId } = lineAt(only, 1000, '4003', 0);
    const deck = doc.building?.levelOrder[0] as string;
    const row = data<Check>(doc, 'check_pipe_supports', { levelId: deck }).pipes.map((entry) => entry.id);
    expect(row).toEqual([runId]);
  });

  it('a run in a document with no level is listed without a filter (level "")', () => {
    const { doc, runId } = lineAt(cs150Document(), 1000, '4004', 0);
    expect(data<Check>(doc, 'check_pipe_supports', {}).pipes.map((row) => row.id)).toEqual([runId]);
  });
});

describe('a support whose run is gone: load and live agree (V1c, SC-RTE-23)', () => {
  function supported(): { doc: CadDocument; runId: string } {
    const base = apply(cs150Document(), 'add_level', { name: 'Ground', elevation: 0, height: 3000 });
    const { doc, runId } = lineAt(base, 3000, '4001', 0);
    const beams = [500, 3000, 5500].reduce(
      (next, x) => apply(next, 'add_steel_member', { role: 'beam', start: [x, -1000, 2830], end: [x, 1000, 2830], profile: 'IPE200' }),
      doc,
    );
    return { doc: apply(beams, 'add_pipe_support', { runId, spacing: 3000 }), runId };
  }
  /** The run removed from the table by something other than delete_pipe_run (which takes its supports with it). */
  function orphaned(doc: CadDocument, runId: string): CadDocument {
    const piping = doc.plant?.piping as NonNullable<NonNullable<CadDocument['plant']>['piping']>;
    const { [runId]: gone, ...runs } = piping.runs;
    void gone;
    return { ...doc, plant: { ...doc.plant, piping: { ...piping, runs, runOrder: [], entityIds: {} } } };
  }

  it('live: the reconcile keeps the three supports and names the code', () => {
    const { doc, runId } = supported();
    expect(supportsOf(doc)).toHaveLength(3);
    const live = reconcileRunSupports(doc, orphaned(doc, runId));
    expect(supportsOf(live.document)).toHaveLength(3);
    expect(live.notes.join(' ')).toContain('RTE_SUPPORT_ORPHAN');
  });

  it('load: the file with the orphans opens (no throw), keeps the supports, and check_pipe_supports says exactly what it says live', () => {
    const { doc, runId } = supported();
    const live = orphaned(doc, runId);
    const loaded = deserializeDocument(serializeDocument(live));
    expect(supportsOf(loaded)).toHaveLength(3);
    const [fromLive, fromFile] = [live, loaded].map((candidate) => ok(candidate, 'check_pipe_supports', {}));
    expect(fromFile.data).toEqual(fromLive.data);
    expect(fromFile.summary).toBe(fromLive.summary);
    const check = fromFile.data as Check;
    expect(check.ok).toBe(false);
    expect(check.pipes).toEqual([]);
    expect(check.orphans.map((orphan) => orphan.code)).toEqual(['RTE_SUPPORT_ORPHAN', 'RTE_SUPPORT_ORPHAN', 'RTE_SUPPORT_ORPHAN']);
    expect(check.orphans.every((orphan) => orphan.pipeId === runId)).toBe(true);
    expect(check.totals.orphans).toBe(3);
    expect(fromFile.summary).toContain('RTE_SUPPORT_ORPHAN');
  });

  it('a file whose support names a pipe that never existed loads too, and the check reports it beside the healthy pipe', () => {
    const { doc, runId } = supported();
    const text = serializeDocument(doc).replace(new RegExp(`"pipeId":\\s*"${runId}"`, 'g'), '"pipeId": "run-404"');
    const loaded = deserializeDocument(text);
    const check = data<Check>(loaded, 'check_pipe_supports', {});
    expect(check.pipes.map((row) => row.id)).toEqual([runId]);
    expect(check.orphans.map((orphan) => orphan.pipeId)).toEqual(['run-404', 'run-404', 'run-404']);
    expect(check.ok).toBe(false);
  });

  it('the filters apply: another level or a line number leaves no orphan (and no pipe: a no-op)', () => {
    const { doc, runId } = supported();
    const live = orphaned(doc, runId);
    const levelId = supportsOf(live)[0]?.levelId as string;
    expect(data<Check>(live, 'check_pipe_supports', { levelId }).orphans).toHaveLength(3);
    const other = apply(live, 'add_level', { name: 'Roof', elevation: 6000, height: 3000 });
    const roof = other.building?.levelOrder.at(-1) as string;
    expectNoOp(execute(other, 'check_pipe_supports', { levelId: roof }), other, 'has no pipes');
    expectNoOp(execute(live, 'check_pipe_supports', { line: 'L-404' }), live, 'has no pipes');
  });

  it('is pure', () => {
    const { doc, runId } = supported();
    const live = orphaned(doc, runId);
    const before = JSON.stringify(live);
    execute(live, 'check_pipe_supports', {});
    expect(JSON.stringify(live)).toBe(before);
  });
});

describe('move_building_element names the run a support rests on (V1c, SC-RTE-24)', () => {
  it('a support on a plant run is refused with the run id and what to do, not with "a wall, a steel column or a rafter"', () => {
    const base = apply(cs150Document(), 'add_level', { name: 'Ground', elevation: 0, height: 3000 });
    const { doc, runId } = lineAt(base, 3000, '4001', 0);
    const placed = apply(doc, 'add_pipe_support', { runId, at: [[3000, 0, 3000]] });
    const support = supportsOf(placed)[0] as PipeSupportElement;
    const result = execute(placed, 'move_building_element', { elementIds: [support.id], delta: [0, 100] });
    expectNoOp(result, placed, `${support.id} rests on plant run ${runId}`);
    expect(result.summary).not.toContain('a wall, a steel column or a rafter');
    expect(result.summary).toContain('edit_route');
  });

  it('a support on a building pipe names the pipe; an opening still names its wall, a steel column or a rafter', () => {
    const base = ok(cs150Document(), 'add_pipe_run', {
      points: [
        [0, 0, 1500],
        [4000, 0, 1500],
      ],
      dn: 100,
      line: 'L-1',
      service: 'water',
    });
    const pipeId = base.affected[0] as string;
    const placed = apply(base.document, 'add_pipe_support', { pipeId, at: [[2000, 0, 1500]] });
    const support = supportsOf(placed)[0] as PipeSupportElement;
    const result = execute(placed, 'move_building_element', { elementIds: [support.id], delta: [0, 100] });
    expectNoOp(result, placed, `${support.id} rests on pipe ${pipeId}`);
  });
});
