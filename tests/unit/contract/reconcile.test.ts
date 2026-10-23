/**
 * Extension point `DocumentExtension.reconcile` (architecture L8): applied by one shared helper to every mutating command result (top level,
 * nested and history replay), after the command and before the guards; never for queries, session / meta-history commands, rejections or no-ops.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defineCommand, z } from '@core/commands/schema';
import { installPlugin } from '@core/plugins/host';
import type { CadPlugin } from '@core/plugins/plugin';
import type { CommandDefinition } from '@core/commands/types';

const calls: Array<{ previous: CadDocument; next: CadDocument; previousCopy: CadDocument; nextCopy: CadDocument }> = [];

/** A command that sets displayPrecision (5 = reconcile target, 6 = reconcile makes it 9, which the guard refuses). */
const setting = (name: string, displayPrecision: number, annotations: Record<string, boolean> = {}): CommandDefinition<unknown> =>
  defineCommand({
    name,
    description: `Test command ${name}.`,
    params: z.object({}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    run: (doc) => ({ document: { ...doc, displayPrecision }, summary: `${name} done.`, affected: ['own-1'] }),
  }) as CommandDefinition<unknown>;

const plugin: CadPlugin = {
  name: 'test-reconcile',
  toolset: 'test',
  commands: [
    setting('test_rec_mut', 5),
    setting('test_rec_guarded', 6),
    setting('test_rec_meta', 5, { metaHistory: true }),
    setting('test_rec_session', 5, { session: true }),
    defineCommand({
      name: 'test_rec_noop',
      description: 'Changes nothing.',
      params: z.object({}),
      run: (doc) => ({ document: doc, summary: 'noop.', affected: [] }),
    }) as CommandDefinition<unknown>,
    defineCommand({
      name: 'test_rec_query',
      description: 'Query.',
      params: z.object({}),
      annotations: { readOnly: true },
      run: (doc) => ({ document: doc, summary: 'query.', affected: [] }),
    }) as CommandDefinition<unknown>,
    defineCommand({
      name: 'test_rec_nested',
      description: 'Composes test_rec_mut through execute.',
      params: z.object({}),
      run: (doc) => ({ ...execute(doc, 'test_rec_mut', {}), summary: 'nested.' }),
    }) as CommandDefinition<unknown>,
  ],
  guards: [
    { domain: 'test-reconcile', check: (_previous, next) => (next.displayPrecision === 9 ? 'the reconciled document holds 9.' : null) },
  ],
  document: {
    validate: () => [],
    derivedEntityIds: () => new Set(),
    restore: (raw) => raw,
    reconcile: (previous, next) => {
      calls.push({ previous, next, previousCopy: structuredClone(previous), nextCopy: structuredClone(next) });
      const target = next.displayPrecision === 5 ? 8 : next.displayPrecision === 6 ? 9 : null;
      if (target === null) return { document: next, notes: [], affected: [] };
      return { document: { ...next, displayPrecision: target }, notes: ['stub: reconciled.'], affected: ['rec-1'] };
    },
  },
};
installPlugin(plugin);

const run = (name: string, doc: CadDocument = createEmptyDocument()): ReturnType<typeof execute> => execute(doc, name, {});

describe('reconcile extension point', () => {
  it('runs on a mutating command: the reconciled document, notes appended to the summary, ids appended to affected and to the recorded step', () => {
    const result = run('test_rec_mut');
    expect(result.document.displayPrecision).toBe(8);
    expect(result.summary).toBe('test_rec_mut done. stub: reconciled.');
    expect(result.affected).toEqual(['own-1', 'rec-1']);
    expect(result.document.featureHistory.at(-1)?.affected).toEqual(['own-1', 'rec-1']);
  });

  it('is applied to an execute nested inside a running step, and the replay of the history gives the live document', () => {
    const nested = run('test_rec_nested');
    expect(nested.document.displayPrecision).toBe(8);
    const live = run('test_rec_mut').document;
    const replayed = execute(live, 'replay_history', {}).document;
    expect(live.displayPrecision).toBe(8);
    expect(replayed.displayPrecision).toBe(8);
  });

  it('does not run for queries, no-ops, session and meta-history commands (same document, summary unchanged)', () => {
    calls.length = 0;
    const base = createEmptyDocument();
    for (const name of ['test_rec_query', 'test_rec_noop']) {
      const result = run(name, base);
      expect(result.document).toBe(base);
      expect(result.summary).not.toContain('stub');
    }
    for (const name of ['test_rec_meta', 'test_rec_session']) expect(run(name, base).summary).not.toContain('stub');
    expect(calls).toEqual([]);
  });

  it('does not run for a rejected command (invalid params)', () => {
    calls.length = 0;
    const base = createEmptyDocument();
    const rejected = execute(base, 'test_rec_mut', { surprise: true });
    expect(rejected.rejected).toBe(true);
    expect(rejected.document).toBe(base);
    expect(calls).toEqual([]);
  });

  it('is pure: its inputs are unchanged by the call', () => {
    calls.length = 0;
    run('test_rec_mut');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.previous).toEqual(call.previousCopy);
      expect(call.next).toEqual(call.nextCopy);
    }
  });

  it('shows the reconciled document to the guards: a refusal of its output rejects the whole command', () => {
    const base = createEmptyDocument();
    const result = execute(base, 'test_rec_guarded', {});
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(base);
    expect(result.summary).toContain('the reconciled document holds 9');
  });
});
