import { describe, it, expect } from 'vitest';
import { type CadDocument, type FeatureStep, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext, runInContext } from '@core/commands/context';
import { getCommand } from '@core/commands/commandTable';
import { createReplayCache } from '@core/commands/history/replayCache';
import { replayHistory } from '@core/commands/history/replay';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandDefinition } from '@core/commands/types';

/** A command that reads `doc.parameters` inside `run` (not through `=expr` params). */
const probeRead = defineCommand({
  name: 'probe_read',
  description: 'Test probe: adds a box whose width is the current value of parameter w, read directly from doc.parameters.',
  params: z.object({ label: z.string().describe('Label') }),
  run: (doc) => {
    const width = doc.parameters['w']?.value ?? 1;
    const result = execute(doc, 'add_box', { size: [width, 1, 1] });
    return result;
  },
});

const registry =
  (runs: string[]) =>
  (name: string): CommandDefinition<unknown> | undefined => {
    const command = name === 'probe_read' ? (probeRead as CommandDefinition<unknown>) : getCommand(name);
    if (command === undefined) return undefined;
    return {
      ...command,
      run: (doc, params, ctx) => {
        runs.push(name);
        return command.run(doc, params, ctx);
      },
    };
  };

const step = (n: number, name: string, params: unknown): FeatureStep => ({ id: `step-${n}`, name, params, affected: [] });

function baseDoc(history: FeatureStep[], w: number): CadDocument {
  return {
    ...createEmptyDocument(),
    featureHistory: history,
    nextStepNumber: history.length + 1,
    parameters: { w: { name: 'w', expression: String(w), value: w } },
  };
}

function replay(doc: CadDocument, runs: string[], cache = createReplayCache()): CadDocument {
  const context = { ...defaultContext(), replayCache: cache };
  return runInContext(context, () => replayHistory(doc, doc.featureHistory, registry(runs)));
}

const cold = (doc: CadDocument): CadDocument =>
  runInContext({ ...defaultContext(), replayCache: null }, () => replayHistory(doc, doc.featureHistory, registry([])));

const boxes = (count: number): FeatureStep[] =>
  Array.from({ length: count }, (_, i) => step(i + 1, 'add_box', { size: [i + 1, 1, 1], position: [i * 3, 0, 0] }));

describe('replay cache and parameters', () => {
  it('a parameter change re-runs only the steps that read it (output equals a cold replay)', () => {
    const history = [...boxes(40), step(41, 'add_box', { size: ['=w', 2, 3] })];
    const cache = createReplayCache();
    const first = replay(baseDoc(history, 10), [], cache);
    const changed = baseDoc(history, 40);
    const runs: string[] = [];
    const warm = replay(changed, runs, cache);
    expect(runs).toHaveLength(1);
    expect(warm).toEqual(cold(changed));
    expect(warm.parameters).toBe(changed.parameters);
    expect(Object.keys(warm.entities)).toEqual(Object.keys(first.entities));
    const lastBox = warm.entities[warm.order[40] as string];
    expect(lastBox?.kind === 'box' ? lastBox.size[0] : null).toBe(40);
  });

  it('an unrelated parameter change re-runs nothing and carries the new parameter table', () => {
    const history = boxes(25);
    const cache = createReplayCache();
    replay(baseDoc(history, 1), [], cache);
    const changed = baseDoc(history, 2);
    const runs: string[] = [];
    const warm = replay(changed, runs, cache);
    expect(runs).toHaveLength(0);
    expect(warm.parameters).toBe(changed.parameters);
    expect(warm).toEqual(cold(changed));
  });

  it('a step whose run reads doc.parameters directly, and every step after it, re-run when the table changes', () => {
    const history = [...boxes(5), step(6, 'probe_read', { label: 'p' }), ...boxes(4).map((s, i) => step(7 + i, s.name, s.params))];
    const cache = createReplayCache();
    replay(baseDoc(history, 3), [], cache);
    const same: string[] = [];
    replay(baseDoc(history, 3), same, cache);
    expect(same).toHaveLength(0);
    const changed = baseDoc(history, 9);
    const runs: string[] = [];
    const warm = replay(changed, runs, cache);
    expect(runs).toEqual(['probe_read', 'add_box', 'add_box', 'add_box', 'add_box']);
    expect(warm).toEqual(cold(changed));
    const probed = warm.entities[warm.order[5] as string];
    expect(probed?.kind === 'box' ? probed.size[0] : null).toBe(9);
  });

  it('switching back to an earlier parameter table re-runs nothing (both tables stay cached)', () => {
    const history = [...boxes(3), step(4, 'probe_read', { label: 'p' }), ...boxes(3).map((s, i) => step(5 + i, s.name, s.params))];
    const cache = createReplayCache();
    replay(baseDoc(history, 3), [], cache);
    replay(baseDoc(history, 9), [], cache);
    const back = baseDoc(history, 3);
    const runs: string[] = [];
    const warm = replay(back, runs, cache);
    expect(runs).toHaveLength(0);
    expect(warm).toEqual(cold(back));
  });

  it('editing a late step re-runs only the suffix; a long history fits the cache', () => {
    const history = boxes(300);
    const cache = createReplayCache();
    replay(baseDoc(history, 1), [], cache);
    const edited = history.map((s) => (s.id === 'step-290' ? { ...s, params: { size: [9, 9, 9] } } : s));
    const runs: string[] = [];
    const warm = replay(baseDoc(edited, 1), runs, cache);
    expect(runs).toHaveLength(11);
    expect(warm).toEqual(cold(baseDoc(edited, 1)));
  });
});
