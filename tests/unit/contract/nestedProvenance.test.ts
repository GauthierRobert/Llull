import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { registerCommands } from '@core/commands/commandTable';
import { defineCommand, z } from '@core/commands/schema';
import { defaultContext } from '@core/commands/context';
import type { CommandDefinition, CommandResult, ExecutionContext } from '@core/commands/types';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { fakeKernel } from '../../helpers/fakeKernel';

function kernelWith(info: NonNullable<ReturnType<NonNullable<GeometryKernel['info']>>>): GeometryKernel {
  return { ...fakeKernel(), info: () => info };
}

const degradedKernel = kernelWith({
  capabilities: [],
  active: 'manifold',
  exactRequested: true,
  fallbackReason: 'llull-kernel binary not found',
});
const exactKernel = kernelWith({ capabilities: [], active: 'occt-native', exactRequested: true });
const withKernel = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });

const measure = (doc: CadDocument, ctx: ExecutionContext | undefined): CommandResult =>
  execute(doc, 'mass_properties', { entityId: 'box-1.1' }, ctx);

/** Unannotated: composes a kernel-optional query (through the nested execute), then a command that uses no kernel. */
const composeMeasure = defineCommand({
  name: 'provenance_probe_compose',
  description: 'Test-only: measures a box through the nested execute, then renames it (no kernel).',
  params: z.object({}),
  run: (doc: CadDocument, _params, ctx) => {
    const measured = measure(doc, ctx);
    const renamed = execute(doc, 'set_entity_name', { id: 'box-1.1', name: 'probe' }, ctx);
    return {
      document: doc,
      summary: 'composed',
      affected: [],
      data: { measured: measured.provenance ?? null, renamed: renamed.provenance ?? null },
    };
  },
});

/** Unannotated: unions two boxes through the nested boolean (requiresKernel). */
const composeBoolean = defineCommand({
  name: 'provenance_probe_boolean',
  description: 'Test-only: unions box-1.1 and box-2.1 through the nested boolean execute.',
  params: z.object({}),
  run: (doc: CadDocument, _params, ctx) => {
    const united = execute(doc, 'boolean', { op: 'union', a: 'box-1.1', b: 'box-2.1' }, ctx);
    return { document: united.document, summary: 'composed: ' + united.summary, affected: united.affected };
  },
});

/** Kernel-optional with an exact own kernel, whose nested call runs on a degraded one. */
const crossKernel = defineCommand({
  name: 'provenance_probe_cross',
  description: 'Test-only: kernel-optional; its nested query runs on a different (degraded) kernel than its own.',
  annotations: { kernelOptional: true, readOnly: true },
  params: z.object({}),
  run: (doc: CadDocument, _params, ctx) => {
    measure(doc, { ...(ctx ?? defaultContext()), kernel: degradedKernel });
    return { document: doc, summary: 'crossed', affected: [] };
  },
});

beforeAll(() => {
  registerCommands('test:provenance-probe', [composeMeasure, composeBoolean, crossKernel] as ReadonlyArray<CommandDefinition<unknown>>);
});

afterEach(() => setGeometryKernel(null));

const box = (): CadDocument => execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;

describe('nested provenance (TR-INT-09)', () => {
  it('an unannotated command that composes a degraded kernel command reports the degradation', () => {
    const result = execute(box(), 'provenance_probe_compose', {}, withKernel(degradedKernel));
    expect(result.provenance).toEqual({ kernel: 'manifold', exactRequested: true, fallbackReason: 'llull-kernel binary not found' });
  });

  it('an unannotated command composing the boolean on a degraded kernel reports the degradation', () => {
    const two = execute(box(), 'add_box', { size: [1, 1, 1], position: [5, 0, 0] }).document;
    const result = execute(two, 'provenance_probe_boolean', {}, withKernel(degradedKernel));
    expect(result.summary).not.toContain('rejected');
    expect(result.provenance).toMatchObject({ kernel: 'manifold', exactRequested: true });
  });

  it('the degradation does not leak to a sibling nested call that uses no kernel', () => {
    const data = execute(box(), 'provenance_probe_compose', {}, withKernel(degradedKernel)).data as { measured: unknown; renamed: unknown };
    expect(data.measured).toMatchObject({ kernel: 'manifold', exactRequested: true });
    expect(data.renamed).toBeNull();
  });

  it('an exact kernel leaves the composing command without provenance', () => {
    expect(execute(box(), 'provenance_probe_compose', {}, withKernel(exactKernel)).provenance).toBeUndefined();
  });

  it('a kernel-optional command takes the worst of its own provenance and its nested one', () => {
    const result = execute(box(), 'provenance_probe_cross', {}, withKernel(exactKernel));
    expect(result.provenance).toMatchObject({ kernel: 'manifold', exactRequested: true });
  });

  it('a plan carries the degraded provenance of a composing step', () => {
    const plan = { actions: [{ command: 'provenance_probe_compose', params: {} }] };
    const result = execute(box(), 'build_project', plan, withKernel(degradedKernel));
    expect((result.data as { degradedSteps?: number[] }).degradedSteps).toEqual([0]);
  });
});
