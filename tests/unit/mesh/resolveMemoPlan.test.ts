/**
 * Plans and history edits that wait for native mesh jobs, run the way the host runs them (TECHNICAL_SPEC 13.8, 13.9): the whole command again after each job,
 * only the last run standing. The resolve memo makes the cost of a plan linear in its steps and a command's mesh preparation happen once, and changes nothing
 * a caller can observe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommand } from '@core/commands/registry';
import { execute } from '@core/commands/registry';
import { stepIdSource } from '@lib/id';
import { createReplayCache } from '@core/commands/history/replayCache';
import { createResolveMemo, type ResolveMemo } from '@core/commands/resolveMemo';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { deferMeshOp } from '@core/geometry/mesh/engine';
import type { MeshData, CadDocument } from '@core/model/types';
import type { MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { cuboid, docWithMeshes, icosphere, soup } from '../../helpers/meshFixtures';
import { contextWith, quadBox, stubQuadEngine } from '../../helpers/quadFixtures';

interface Late {
  readonly engine: MeshProcessingEngine;
  /** `input.mesh` of every quad_remesh the engine was asked, in order. */
  readonly inputs: MeshData[];
  /** Targets whose job finished. */
  readonly done: Set<number>;
  /** Jobs asked for, in order. */
  readonly asked: number[];
  beginRun(): void;
}

/** A quad engine that behaves like the native one behind the host: a miss asks for the job (the first miss of a run) and defers, the finished job answers. */
function lateEngine(): Late {
  const stub = stubQuadEngine(() => quadBox(5, 1));
  const inputs: MeshData[] = [];
  const done = new Set<number>();
  const asked: number[] = [];
  let askedThisRun: number | null = null;
  return {
    engine: {
      ...stub,
      run(input, op) {
        if (op.op !== 'quad_remesh') return stub.run(input, op);
        inputs.push(input.mesh);
        if (done.has(op.targetQuads)) return stub.run(input, op);
        if (askedThisRun === null) {
          askedThisRun = op.targetQuads;
          asked.push(op.targetQuads);
        }
        return deferMeshOp('quad_remesh');
      },
    },
    inputs,
    done,
    asked,
    beginRun: () => {
      askedThisRun = null;
    },
  };
}

/** `resolveDeferred` in miniature: run again after each finished job until a run asks for nothing; returns that run and how many runs it took. */
function resolveLike<T>(attempt: () => T, late: Late, memo: ResolveMemo | null): { result: T; runs: number } {
  for (let runs = 1; ; runs++) {
    late.beginRun();
    memo?.beginRun();
    const before = late.asked.length;
    const result = attempt();
    if (late.asked.length === before) return { result, runs };
    late.done.add(late.asked.at(-1) as number);
  }
}

const source = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
const sourceId = source.ids[0] as string;

const box = (i: number): { command: string; params: Record<string, unknown> } => ({ command: 'add_box', params: { size: [2 + i, 2, 2] } });
const remesh = (target: number): { command: string; params: Record<string, unknown> } => ({
  command: 'quad_remesh',
  params: { id: sourceId, targetQuadCount: target },
});

/** Counts the real executions of a command (a memoized step does not run). */
function countRuns(name: string): { count: () => number } {
  const definition = getCommand(name) as unknown as { run: (...args: unknown[]) => unknown };
  const spy = vi.spyOn(definition, 'run');
  return { count: () => spy.mock.calls.length };
}

afterEach(() => vi.restoreAllMocks());

interface Outcome {
  readonly result: CommandResult;
  readonly runs: number;
  readonly boxRuns: number;
  readonly quadRuns: number;
  readonly late: Late;
}

/** Runs `name` on `doc` as the host does, with the memo (default) or without. */
function resolveCommand(
  doc: CadDocument,
  name: string,
  params: unknown,
  withMemo: boolean,
  extra: Partial<ExecutionContext> = {},
): Outcome {
  vi.restoreAllMocks();
  const late = lateEngine();
  const memo = withMemo ? createResolveMemo() : null;
  // a replay cache of its own: the other flavour of the same edit must not find the states this one cached
  const context: ExecutionContext = { ...contextWith(late.engine), resolveMemo: memo, replayCache: createReplayCache(), ...extra };
  const boxes = countRuns('add_box');
  const quads = countRuns('quad_remesh');
  const { result, runs } = resolveLike(() => execute(doc, name, params, context), late, memo);
  return { result, runs, boxRuns: boxes.count(), quadRuns: quads.count(), late };
}

const plan = (actions: unknown[], onError?: 'abort' | 'continue'): unknown => ({ actions, ...(onError !== undefined ? { onError } : {}) });

describe('a plan with deferred native steps', () => {
  it('executes every step once, the deferring steps twice: linear in the plan, not in plan x deferrals', () => {
    for (const deferred of [1, 3, 6]) {
      const steps = 10;
      const actions = Array.from({ length: steps }, (_, i) => (i >= steps - deferred ? remesh(6 + i) : box(i)));
      const memoized = resolveCommand(source.doc, 'build_project', plan(actions), true);
      expect(memoized.result.error).toBeUndefined();
      expect(memoized.runs).toBe(deferred + 1);
      expect(memoized.boxRuns).toBe(steps - deferred);
      expect(memoized.quadRuns).toBe(2 * deferred);
      const plain = resolveCommand(source.doc, 'build_project', plan(actions), false);
      expect(plain.runs).toBe(deferred + 1);
      expect(plain.boxRuns).toBeGreaterThan(memoized.boxRuns);
      if (deferred > 1) expect(plain.quadRuns).toBeGreaterThan(memoized.quadRuns);
    }
  });

  it('the plan of the measurement: 10 steps, native steps at 3, 6 and 9, 13 executions instead of 31', () => {
    const actions = Array.from({ length: 10 }, (_, i) => (i === 3 || i === 6 || i === 9 ? remesh(6 + i) : box(i)));
    const memoized = resolveCommand(source.doc, 'build_project', plan(actions), true);
    const plain = resolveCommand(source.doc, 'build_project', plan(actions), false);
    expect([memoized.boxRuns, memoized.quadRuns]).toEqual([7, 6]);
    expect([plain.boxRuns, plain.quadRuns]).toEqual([22, 9]);
  });

  it('commits the same document, ids, summary and report with and without the memo, in both error modes, over several plans', () => {
    let seed = 20261027;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 24; round++) {
      const length = 3 + Math.floor(random() * 10);
      let nextTarget = 6;
      const actions = Array.from({ length }, (_, i) => {
        const pick = random();
        if (pick < 0.3) return remesh(nextTarget++);
        if (pick < 0.4) return { command: 'add_box', params: { size: [-1, 2, 2] } }; // refused by the command
        if (pick < 0.5) return { command: 'no_such_command', params: {} };
        if (pick < 0.6) return { command: 'add_sphere', params: { radius: 1 + i } };
        return box(i);
      });
      for (const onError of ['abort', 'continue'] as const) {
        const params = plan(actions, onError);
        const memoized = resolveCommand(source.doc, 'build_project', params, true);
        const plain = resolveCommand(source.doc, 'build_project', params, false);
        expect(memoized.runs, `round ${round} ${onError}`).toBe(plain.runs);
        expect(memoized.result.document, `round ${round} ${onError}`).toEqual(plain.result.document);
        expect(memoized.result.summary).toBe(plain.result.summary);
        expect(memoized.result.affected).toEqual(plain.result.affected);
        expect(memoized.result.data).toEqual(plain.result.data);
        expect(memoized.late.asked).toEqual(plain.late.asked);
        expect(memoized.boxRuns + memoized.quadRuns).toBeLessThanOrEqual(plain.boxRuns + plain.quadRuns);
      }
    }
  });

  it('runs the steps of a nested plan once as well, and commits what the unmemoized run does', () => {
    const inner = { command: 'build_project', params: plan([box(5), remesh(8), box(6)]) };
    const actions = [box(0), remesh(7), inner, box(1), remesh(9)];
    const memoized = resolveCommand(source.doc, 'build_project', plan(actions), true);
    const plain = resolveCommand(source.doc, 'build_project', plan(actions), false);
    expect(memoized.result.error).toBeUndefined();
    expect(memoized.result.document).toEqual(plain.result.document);
    expect(memoized.runs).toBe(4);
    // box(0), box(5), box(6), box(1) once each; the three quad steps twice each
    expect([memoized.boxRuns, memoized.quadRuns]).toEqual([4, 6]);
    expect(plain.boxRuns).toBeGreaterThan(4);
  });

  it('does not share a step between two input documents: another document is a fresh execution', () => {
    const other = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
    const memo = createResolveMemo();
    const late = lateEngine();
    late.done.add(6);
    const context: ExecutionContext = { ...contextWith(late.engine), resolveMemo: memo };
    const params = plan([box(0), remesh(6)]);
    const first = execute(source.doc, 'build_project', params, context);
    const entities = memo.size;
    const second = execute(other.doc, 'build_project', params, context);
    expect(second.document).toEqual(first.document);
    expect(second.document).not.toBe(first.document);
    expect(memo.size).toBeGreaterThan(entities);
  });
});

describe('a history edit that replays native steps', () => {
  /** A document recorded with two boxes and a quad_remesh between them, built while the engine is ready. */
  function recorded(): { doc: CadDocument; late: Late } {
    const late = lateEngine();
    late.done.add(6);
    const context = contextWith(late.engine);
    let doc = source.doc;
    doc = execute(doc, 'add_box', { size: [3, 3, 3] }, context).document;
    doc = execute(doc, 'quad_remesh', { id: sourceId, targetQuadCount: 6 }, context).document;
    doc = execute(doc, 'add_box', { size: [4, 3, 3] }, context).document;
    return { doc, late };
  }

  it('prepares the mesh of the native step once for all its runs, and commits the document the unmemoized edit commits', () => {
    const { doc } = recorded();
    const stepId = (doc.featureHistory.find((step) => step.name === 'add_box') as { id: string }).id;
    const edit = { stepId, params: { size: [5, 3, 3] } };
    const memoized = resolveCommand(doc, 'edit_step_params', edit, true);
    const plain = resolveCommand(doc, 'edit_step_params', edit, false);
    expect(memoized.result.error).toBeUndefined();
    expect(memoized.result.document).toEqual(plain.result.document);
    expect(memoized.result.summary).toBe(plain.result.summary);
    // two runs asked the engine: the first deferred, the second answered
    expect(memoized.late.inputs.length).toBe(2);
    expect(memoized.late.inputs[1]).toBe(memoized.late.inputs[0]);
    expect(plain.late.inputs[1]).not.toBe(plain.late.inputs[0]);
    expect(Object.keys(memoized.result.document.entities).some((id) => id.startsWith('subd-'))).toBe(true);
  });

  it('replay_history after native steps gives the same document with the memo as without', () => {
    const { doc } = recorded();
    const memoized = resolveCommand(doc, 'replay_history', {}, true);
    const plain = resolveCommand(doc, 'replay_history', {}, false);
    expect(memoized.result.document).toEqual(plain.result.document);
    expect(memoized.result.document.order).toEqual(doc.order);
  });
});

describe('a recorded plan replayed inside a running step', () => {
  /** The imported mesh, then one recorded `build_project` step (a squashed run of steps has this form) holding a box, a native step and a box. */
  function withRecordedPlan(): CadDocument {
    const next = source.doc.nextStepNumber ?? 1;
    const step = { id: `step-${next}`, name: 'build_project', params: plan([box(0), remesh(6), box(1)]), suppressed: false, affected: [] };
    return { ...source.doc, featureHistory: [...source.doc.featureHistory, step], nextStepNumber: next + 1 };
  }

  it('shares nothing from the steps inside it: replay and a step edit give the document the unmemoized resolve gives', () => {
    const doc = withRecordedPlan();
    const stepId = (doc.featureHistory.at(-1) as { id: string }).id;
    const edit = { stepId, params: plan([box(2), remesh(6), box(1)]) };
    for (const [name, params] of [
      ['replay_history', {}],
      ['edit_step_params', edit],
    ] as const) {
      const memoized = resolveCommand(doc, name, params, true);
      const plain = resolveCommand(doc, name, params, false);
      expect(memoized.result.error, name).toBeUndefined();
      expect(memoized.runs, name).toBe(plain.runs);
      expect(memoized.result.document, name).toEqual(plain.result.document);
      expect(
        Object.keys(memoized.result.document.entities).some((id) => id.startsWith('subd-')),
        name,
      ).toBe(true);
    }
  });
});

describe('a plan run inside a step', () => {
  /** What `replay_history` or a recipe does with a plan: run it in the id scope of one step, again after each job, on the same document. */
  function runInStep(withMemo: boolean): { result: CommandResult; runs: number } {
    const late = lateEngine();
    const memo = withMemo ? createResolveMemo() : null;
    const base: ExecutionContext = { ...contextWith(late.engine), resolveMemo: memo, replayCache: createReplayCache() };
    const params = plan([box(0), remesh(6), box(1)]);
    return resolveLike(() => execute(source.doc, 'build_project', params, { ...base, stepKey: '9', ids: stepIdSource('9') }), late, memo);
  }

  it('is not memoized: the steps inside mint their ids from the one id source of the step, which a served step would not advance', () => {
    const memoized = runInStep(true);
    const plain = runInStep(false);
    expect(memoized.runs).toBe(2);
    expect(memoized.result.error).toBeUndefined();
    expect(memoized.result.document).toEqual(plain.result.document);
    const ids = Object.keys(memoized.result.document.entities);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the key of a memoized step', () => {
  it('tells -0 from 0: two read-only steps on one document that differ only by the sign of zero are both executed', () => {
    vi.restoreAllMocks();
    const measures = countRuns('measure_distance');
    const memo = createResolveMemo();
    const context: ExecutionContext = { ...contextWith(null), resolveMemo: memo };
    const measure = (x: number): { command: string; params: Record<string, unknown> } => ({
      command: 'measure_distance',
      params: { point1: [x, 0, 0], point2: [3, 4, 0] },
    });
    const run = (actions: unknown[]): CommandResult => execute(source.doc, 'build_project', plan(actions), context);
    expect(run([measure(0), measure(0)]).error).toBeUndefined();
    expect(measures.count()).toBe(1);
    expect(run([measure(0), measure(-0)]).error).toBeUndefined();
    // the first step of this plan is served from the earlier plan, the second differs by the sign of zero
    expect(measures.count()).toBe(2);
  });
});

describe('the weight of a kept step', () => {
  const sphere = icosphere(10, 2);
  const importSphere = { command: 'import_mesh', params: { bodies: [{ positions: soup(sphere) }] } };

  it('counts the key and the numbers of the meshes the step created, so a step that makes a big mesh is not kept beyond the budget', () => {
    const kept = createResolveMemo();
    execute(source.doc, 'build_project', plan([importSphere]), { ...contextWith(null), resolveMemo: kept });
    const meshNumbers = sphere.positions.length + sphere.indices.length;
    expect(kept.size).toBe(1);
    expect(kept.weight).toBeGreaterThanOrEqual(meshNumbers);
    expect(kept.weight).toBeLessThan(meshNumbers + 100_000);
    const small = createResolveMemo({ maxWeight: meshNumbers - 1 });
    execute(source.doc, 'build_project', plan([importSphere, box(0)]), { ...contextWith(null), resolveMemo: small });
    // the import does not fit; the later box (a primitive, no mesh numbers) is kept by its key alone
    expect(small.size).toBe(1);
    expect(small.weight).toBeLessThan(2000);
  });
});

describe('a nested plan and the step observer', () => {
  const nested = (): unknown[] => [box(0), { command: 'build_project', params: plan([box(5), remesh(7)]) }, box(1), remesh(8)];

  it('reports every inner step to onStep in every run, also those whose results are served from the memo', () => {
    const starts: string[] = [];
    let ends = 0;
    const onStep = (event: { phase: string; command: string }): void => {
      if (event.phase === 'start') starts.push(event.command);
      else ends += 1;
    };
    const memoized = resolveCommand(source.doc, 'build_project', plan(nested()), true, { onStep });
    expect(memoized.result.error).toBeUndefined();
    expect(memoized.runs).toBe(3);
    // run 1 reaches the inner native step (4 starts), runs 2 and 3 reach the outer native step (6 starts each, the inner plan's among them)
    expect(starts).toHaveLength(16);
    expect(starts.slice(-6)).toEqual(['add_box', 'build_project', 'add_box', 'quad_remesh', 'add_box', 'quad_remesh']);
    expect(ends).toBeGreaterThanOrEqual(12);
    // the inner steps still ran once (the native ones twice): the nested plan re-ran, its steps were served
    expect([memoized.boxRuns, memoized.quadRuns]).toEqual([3, 4]);
  });

  it('a throwing observer aborts the plan from inside the nested plan of a later run (rolled back)', () => {
    let innerNativeStarts = 0;
    const onStep = (event: { phase: string; command: string; ordinal: number }): void => {
      // the inner plan numbers its own steps: its native step is ordinal 2
      if (event.phase === 'start' && event.command === 'quad_remesh' && event.ordinal === 2 && ++innerNativeStarts === 3)
        throw new Error('stop at the inner step');
    };
    const outcome = resolveCommand(source.doc, 'build_project', plan(nested()), true, { onStep });
    expect(outcome.runs).toBe(3);
    expect(outcome.result.document).toBe(source.doc);
    expect(outcome.result.summary).toContain('stop at the inner step');
    expect(outcome.result.error?.code).toBe('CMD_THREW');
  });
});
