/**
 * Unit tests for build_project — the AI plan/transaction command.
 *
 * Pure: documents from createEmptyDocument(); ids reset between tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

interface StepReport {
  index: number;
  command: string;
  ok: boolean;
  summary: string;
  affected: string[];
}
interface BuildData {
  ok: boolean;
  validated: boolean;
  stepCount: number;
  steps: StepReport[];
  failedAt: number | null;
  issues?: string[];
  scene?: { entityCount: number };
}

describe('build_project — happy path', () => {
  beforeEach(() => __resetIdCounter());

  it('runs a multi-step plan and reports each step', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [2, 2, 2] } },
        { command: 'add_sphere', params: { radius: 1 } },
      ],
    });
    const data = result.data as BuildData;

    expect(data.ok).toBe(true);
    expect(data.stepCount).toBe(2);
    expect(data.steps.map((s) => s.ok)).toEqual([true, true]);
    expect(result.affected).toHaveLength(2);
    expect(result.document.order).toHaveLength(2);
    expect(data.scene!.entityCount).toBe(2);
    expect(result.summary).toContain('2/2');
  });

  it('resolves a $alias reference to an earlier step\'s created id', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 0] }, as: 'base' },
        { command: 'move_entity', params: { id: '$base', delta: [5, 0, 0] } },
      ],
    });
    const data = result.data as BuildData;

    expect(data.ok).toBe(true);
    const boxId = data.steps[0]!.affected[0]!;
    expect(result.document.entities[boxId]!.position).toEqual([5, 0, 0]);
  });

  it('resolves $alias inside an array param (boolean ids)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [2, 2, 2] }, as: 'a' },
        { command: 'add_box', params: { size: [2, 2, 2], position: [1, 0, 0] }, as: 'b' },
        { command: 'group_entities', params: { ids: ['$a', '$b'], name: 'Pair' } },
      ],
    });
    const data = result.data as BuildData;
    expect(data.ok).toBe(true);
    expect(data.steps[2]!.ok).toBe(true);
    expect(Object.keys(result.document.groups)).toHaveLength(1);
  });

  it('supports $alias[N] indexing into affected ids', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
        { command: 'move_entity', params: { id: '$b[0]', delta: [0, 2, 0] } },
      ],
    });
    const data = result.data as BuildData;
    expect(data.ok).toBe(true);
    const boxId = data.steps[0]!.affected[0]!;
    expect(result.document.entities[boxId]!.position).toEqual([0, 2, 0]);
  });

  it('is pure — the input document is never mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'build_project', { actions: [{ command: 'add_box', params: { size: [1, 1, 1] } }] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('build_project — abort (default) rolls back', () => {
  beforeEach(() => __resetIdCounter());

  it('aborts on the first failing step and returns the input document unchanged', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { command: 'move_entity', params: { id: 'ghost', delta: [1, 0, 0] } }, // no-op → soft fail
        { command: 'add_sphere', params: { radius: 1 } },
      ],
    });
    const data = result.data as BuildData;

    expect(data.ok).toBe(false);
    expect(data.failedAt).toBe(1);
    expect(result.document).toBe(doc); // full rollback to input reference
    expect(result.affected).toHaveLength(0);
    expect(data.steps).toHaveLength(2); // stopped before step 3
    expect(result.summary).toMatch(/aborted at step 1/);
  });

  it('aborts on an unknown command', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      actions: [{ command: 'frobnicate', params: {} }],
    });
    const data = result.data as BuildData;
    expect(data.failedAt).toBe(0);
    expect(data.steps[0]!.summary).toContain('Unknown command');
    expect(result.document).toBe(doc);
  });

  it('aborts on an unresolvable alias reference', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      actions: [{ command: 'move_entity', params: { id: '$missing', delta: [1, 0, 0] } }],
    });
    const data = result.data as BuildData;
    expect(data.failedAt).toBe(0);
    expect(data.steps[0]!.summary).toContain('undefined alias');
    expect(result.document).toBe(doc);
  });

  it('aborts on an out-of-range alias index', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
        { command: 'move_entity', params: { id: '$b[3]', delta: [1, 0, 0] } },
      ],
    });
    const data = result.data as BuildData;
    expect(data.failedAt).toBe(1);
    expect(data.steps[1]!.summary).toMatch(/no id at index 3/);
    expect(result.document).toBe(doc);
  });

  it('aborts on a malformed (non-object) action', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', { actions: ['not-an-action'] });
    const data = result.data as BuildData;
    expect(data.failedAt).toBe(0);
    expect(result.document).toBe(doc);
  });
});

describe('build_project — continue mode', () => {
  beforeEach(() => __resetIdCounter());

  it('applies the good steps and records the failures without rolling back', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      onError: 'continue',
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { command: 'move_entity', params: { id: 'ghost', delta: [1, 0, 0] } }, // soft fail
        { command: 'add_sphere', params: { radius: 2 } },
      ],
    });
    const data = result.data as BuildData;

    expect(data.ok).toBe(false);
    expect(data.failedAt).toBeNull();
    expect(data.steps.map((s) => s.ok)).toEqual([true, false, true]);
    expect(result.document.order).toHaveLength(2); // box + sphere committed
    expect(result.affected).toHaveLength(2);
  });

  it('continues past an unknown command and a malformed action', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      onError: 'continue',
      actions: [
        { command: 'nope', params: {} },
        42,
        { command: 'add_box', params: { size: [1, 1, 1] } },
      ],
    });
    const data = result.data as BuildData;
    expect(data.steps.map((s) => s.ok)).toEqual([false, false, true]);
    expect(result.document.order).toHaveLength(1);
  });

  it('continues past an unresolvable alias', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      onError: 'continue',
      actions: [
        { command: 'move_entity', params: { id: '$ghost', delta: [1, 0, 0] } },
        { command: 'add_box', params: { size: [1, 1, 1] } },
      ],
    });
    const data = result.data as BuildData;
    expect(data.steps.map((s) => s.ok)).toEqual([false, true]);
    expect(result.document.order).toHaveLength(1);
  });
});

describe('build_project — validate (dry run)', () => {
  beforeEach(() => __resetIdCounter());

  it('reports a valid plan without mutating the document', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      validate: true,
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
        { command: 'move_entity', params: { id: '$b', delta: [1, 0, 0] } },
      ],
    });
    const data = result.data as BuildData;
    expect(data.validated).toBe(true);
    expect(data.ok).toBe(true);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('valid');
  });

  it('flags unknown commands, missing required params, and forward alias refs', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', {
      validate: true,
      actions: [
        { command: 'nope', params: {} },
        { command: 'add_box', params: {} }, // missing required "size"
        { command: 'move_entity', params: { id: '$later', delta: [0, 0, 0] } }, // ref before defined
        { command: 'add_sphere', params: { radius: 1 }, as: 'later' },
      ],
    });
    const data = result.data as BuildData;
    expect(data.ok).toBe(false);
    expect(data.issues!.length).toBeGreaterThanOrEqual(3);
    expect(data.issues!.join(' ')).toMatch(/unknown command/);
    expect(data.issues!.join(' ')).toMatch(/missing required param "size"/);
    expect(data.issues!.join(' ')).toMatch(/undefined alias \$later/);
    expect(result.document).toBe(doc);
  });

  it('flags a malformed action in validate mode', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', { validate: true, actions: [null] });
    const data = result.data as BuildData;
    expect(data.ok).toBe(false);
    expect(data.issues!.join(' ')).toMatch(/not a valid action/);
  });
});

describe('build_project — empty / invalid input', () => {
  beforeEach(() => __resetIdCounter());

  it('no-ops on an empty actions list', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', { actions: [] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect((result.data as BuildData).stepCount).toBe(0);
  });

  it('no-ops when actions is not an array', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'build_project', { actions: 'nope' as unknown as [] });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('no actions');
  });
});
