/** AGENT_FIRST AF-11 / AF-14: machine-readable refusals and build_project reports a script can act on. */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandError } from '@core/commands/types';
import type { BuildProjectData, StepReport } from '@core/commands/project/types';
import { expectPure } from '../helpers/expectNoOp';

const BOX = { command: 'add_box', params: { size: [2, 2, 2] } };

function build(actions: unknown[], extra: Record<string, unknown> = {}): { result: ReturnType<typeof execute>; data: BuildProjectData } {
  const result = execute(createEmptyDocument(), 'build_project', { ...extra, actions });
  return { result, data: result.data as BuildProjectData };
}

const failed = (data: BuildProjectData): StepReport => data.steps.find((step) => !step.ok) as StepReport;

describe('CommandResult.error on registry refusals', () => {
  it('codes an unknown command', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'no_such_command', {});
    expect(result).toMatchObject({ rejected: true, document: doc, error: { code: 'CMD_UNKNOWN', ids: [], paths: [] } });
    expect(result.error?.remediation).toContain('llull search');
  });
  it('codes invalid params with the offending param paths', () => {
    const result = execute(createEmptyDocument(), 'add_box', { size: [1, 'x', 1], position: 'here' });
    expect(result.error?.code).toBe('CMD_INVALID_PARAMS');
    expect(result.error?.paths).toEqual(expect.arrayContaining(['size.1', 'position']));
  });
  it('codes a reserved id and a missing kernel', () => {
    expect(execute(createEmptyDocument(), 'delete_entities', { ids: ['constructor'] }).error?.code).toBe('CMD_RESERVED_ID');
    const noKernel = { ...defaultContext(), kernel: null };
    const refused = execute(createEmptyDocument(), 'fillet_edge', { id: 'box-1.1', radius: 0.2 }, noKernel);
    expect(refused.error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
  });
  it('leaves successful results without an error', () => {
    expect(execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).error).toBeUndefined();
  });
});

describe('build_project step errors', () => {
  it('carries the command error of a refused step and the plan path of plan failures', () => {
    const invalid = build([BOX, { command: 'add_box', params: { size: 'big' } }], { onError: 'continue' });
    expect(failed(invalid.data).error).toMatchObject({ code: 'CMD_INVALID_PARAMS', paths: ['size'] });

    const unknown = build([{ command: 'make_wing' }]);
    expect(failed(unknown.data).error).toMatchObject({ code: 'CMD_UNKNOWN', paths: ['step 0'] });

    const alias = build([BOX, { command: 'delete_entities', params: { ids: ['$nothing'] } }]);
    expect(failed(alias.data).error).toMatchObject({ code: 'PLAN_PARAM_UNRESOLVED', paths: ['step 1'] });
  });
  it('codes a graceful no-op step as CMD_NO_EFFECT', () => {
    const { data } = build([{ command: 'move_entities', params: { ids: ['ghost'], delta: [1, 0, 0] } }]);
    expect(failed(data).error?.code).toBe('CMD_NO_EFFECT');
    expect(data.failedAt).toBe(0);
  });
  it('codes loop failures at their nested path', () => {
    const header = build([{ repeat: { count: '=missing + 1' }, actions: [BOX] }]);
    expect(failed(header.data).error).toMatchObject({ code: 'PLAN_LOOP_HEADER', paths: ['step 0'] });

    const nested = build([{ repeat: { count: 2 }, actions: [BOX, 42] }]);
    expect(failed(nested.data).error).toMatchObject({ code: 'PLAN_INVALID_ACTION', paths: ['step 0 › iter 0 › step 1'] });

    const limit = build([
      { repeat: { count: 600 }, actions: [] },
      { repeat: { count: 600 }, actions: [] },
    ]);
    expect(failed(limit.data).error?.code).toBe('PLAN_LOOP_LIMIT');

    const legacy = build([{ repeat: { count: -1 }, step: { command: 'add_box', params: {} } }]);
    expect(failed(legacy.data).error?.code).toBe('PLAN_LOOP_HEADER');
  });
  it('codes a whole-plan refusal on the result itself', () => {
    const empty = build([]);
    expect(empty.result.error).toMatchObject({ code: 'PLAN_EMPTY', paths: ['actions'] });
    expect(empty.data.steps).toEqual([]);
  });
  it('gives every failed step an error and no ok step one', () => {
    const { data } = build([BOX, { command: 'nope' }, { command: 'add_box', params: { size: -1 } }, BOX], { onError: 'continue' });
    for (const step of data.steps) expect(step.error === undefined).toBe(step.ok);
    const codes = data.steps.flatMap((step) => (step.error ? [(step.error as CommandError).code] : []));
    expect(codes).toEqual(['CMD_UNKNOWN', 'CMD_INVALID_PARAMS']);
  });
});

describe('build_project query data and aliases', () => {
  it('returns a read-only step answer in the step report, and none for mutating steps', () => {
    const { data } = build([
      { ...BOX, as: 'body' },
      { command: 'mass_properties', params: { entityId: '$body' } },
    ]);
    expect(data.steps[0]?.data).toBeUndefined();
    expect(data.steps[1]?.data).toMatchObject({ volume: 8 });
  });
  it('maps every alias, loop-interpolated ones included, to the ids it bound', () => {
    const { result, data } = build([
      { ...BOX, as: 'body' },
      { repeat: { count: 2 }, actions: [{ command: 'add_sphere', params: { radius: 1 }, as: 'ball{i}' }] },
    ]);
    expect(Object.keys(data.aliases ?? {})).toEqual(['body', 'ball0', 'ball1']);
    expect(data.aliases?.['body']).toEqual([result.affected[0]]);
    expect(data.aliases?.['ball1']).toEqual([result.affected[2]]);
  });
  it('hands out a copy, keeps reserved alias names and leaves out for_each element variables', () => {
    const { data } = build([
      { ...BOX, as: '__proto__' },
      { for_each: { values: [1, 2], as: 'r' }, step: { command: 'add_sphere', params: { radius: '=r' } } },
    ]);
    expect(Object.keys(data.aliases ?? {})).toEqual(['__proto__']);
    data.aliases?.['__proto__']?.push('tampered');
    expect(data.steps[0]?.affected).toHaveLength(1);
  });
  it('surfaces the failing step error on an aborted plan, also to an outer plan', () => {
    const inner = { command: 'build_project', params: { actions: [BOX, { command: 'add_box', params: { size: 'big' } }] } };
    const direct = execute(createEmptyDocument(), 'build_project', inner.params);
    expect(direct.error).toMatchObject({ code: 'CMD_INVALID_PARAMS', paths: ['size'] });
    const { data } = build([inner]);
    expect(failed(data).error?.code).toBe('CMD_INVALID_PARAMS');
  });
  it('omits the alias map when the run rolled back or only validated', () => {
    expect(build([{ ...BOX, as: 'body' }, { command: 'nope' }]).data.aliases).toBeUndefined();
    expect(build([{ ...BOX, as: 'body' }], { validate: true }).data.aliases).toBeUndefined();
  });
  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'build_project', { actions: [{ ...BOX, as: 'b' }, { command: 'nope' }], onError: 'continue' }));
  });
});
