import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { PlanStepEvent } from '@core/commands/types';

const plan = {
  actions: [
    { command: 'add_box', params: { size: [1, 1, 1] } },
    { repeat: { count: 2 }, step: { command: 'add_sphere', params: { radius: 1 } } },
    { command: 'no_such_command', params: {} },
  ],
  onError: 'continue',
};

describe('build_project ExecutionContext.onStep', () => {
  it('reports a start and end per executed command with ordinal, total and step position', () => {
    const events: PlanStepEvent[] = [];
    const ctx = { ...defaultContext(), onStep: (event: PlanStepEvent) => events.push(event) };
    const result = execute(createEmptyDocument(), 'build_project', plan, ctx);

    expect(events.map((e) => `${e.phase}:${e.command}:${e.ordinal}/${e.total}`)).toEqual([
      'start:add_box:1/4',
      'end:add_box:1/4',
      'start:add_sphere:2/4',
      'end:add_sphere:2/4',
      'start:add_sphere:3/4',
      'end:add_sphere:3/4',
    ]);
    const ends = events.filter((e) => e.phase === 'end');
    expect(ends.map((e) => e.ok)).toEqual([true, true, true]);
    const steps = (result.data as { steps: { command: string }[] }).steps;
    expect(ends.map((e) => steps[e.stepPosition ?? -1]?.command)).toEqual(['add_box', 'add_sphere', 'add_sphere']);
  });

  it('marks a graceful no-op step as not ok', () => {
    const events: PlanStepEvent[] = [];
    const ctx = { ...defaultContext(), onStep: (event: PlanStepEvent) => events.push(event) };
    execute(
      createEmptyDocument(),
      'build_project',
      {
        actions: [{ command: 'delete_entities', params: { ids: ['ghost'] } }],
        onError: 'continue',
      },
      ctx,
    );
    expect(events.filter((e) => e.phase === 'end').map((e) => e.ok)).toEqual([false]);
  });

  it('lets the observer abort the plan by throwing: the command fails, the document is unchanged', () => {
    const doc = createEmptyDocument();
    const before = JSON.stringify(doc);
    const ctx = {
      ...defaultContext(),
      onStep: (event: PlanStepEvent) => {
        if (event.ordinal === 2) throw new Error('stop here');
      },
    };
    const result = execute(doc, 'build_project', plan, ctx);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('build_project failed: stop here');
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('changes nothing without an observer', () => {
    const doc = createEmptyDocument();
    const observed = execute(doc, 'build_project', plan, {
      ...defaultContext(),
      onStep: () => undefined,
    });
    const plain = execute(doc, 'build_project', plan);
    expect(observed.summary).toBe(plain.summary);
    expect(observed.affected).toEqual(plain.affected);
  });
});
