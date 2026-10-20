/** Scenario runner for docs/aerospace/09-plm-configuration-traceability/validation/scenarios (README §4 contract). */

import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { actPayload } from '@plm/gate';
import { GATED_COMMANDS } from '@plm/commands/status';
import { fakePort } from './fakePort';

const VALIDATION = resolve(import.meta.dirname, '../../../docs/aerospace/09-plm-configuration-traceability/validation');
export const readValidation = (relative: string): string => readFileSync(resolve(VALIDATION, relative), 'utf8');

/** A context with a signing port that trusts any confirmation signed over the exact act payload (see fakePort): the test host of a human with a trusted key. */
export const humanContext = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  ...defaultContext(),
  humanSignature: fakePort(),
  ...overrides,
});
/** An agent: no signing port and no key, so it can prepare acts but never clear a human gate. */
export const agentContext = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  ...defaultContext(),
  humanSignature: null,
  ...overrides,
});

/** The human-only plm commands (the same list as `plm_act_payload`). */
const GATED = new Set(GATED_COMMANDS as readonly string[]);

/** `params` of a human-only command plus a confirmation signed (by the fake key of `as`) over exactly this act on exactly this document. */
export function confirmed(doc: CadDocument, command: string, params: Record<string, unknown>, as: string): Record<string, unknown> {
  const nonce = `nonce-${command}-${as}`;
  return { ...params, confirmation: { alg: 'Ed25519', signature: actPayload(doc, command, params, nonce), nonce, as } };
}

/** Run `command`; a human-only plm command on a context that holds a signing port is auto-confirmed as the user the params name (default u-1). */
export function run(doc: CadDocument, command: string, params: unknown, ctx: ExecutionContext = humanContext()): CommandResult {
  const given = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  if (command === 'release_item' && Array.isArray(given['approvals'])) {
    // Scenario text passes inline approvals; in this build each approval is recorded (and signed) by its own approver first. A refused release
    // returns the document as it was given (the approvals recorded for the attempt are discarded).
    const { approvals, ...rest } = given;
    const approved = (approvals as { role: string; userId: string }[]).reduce(
      (next, approval) => run(next, 'record_approval', approval, ctx).document,
      doc,
    );
    const released = run(approved, 'release_item', rest, ctx);
    return released.rejected === true ? { ...released, document: doc } : released;
  }
  if (!GATED.has(command) || ctx.humanSignature === null || ctx.humanSignature === undefined || 'confirmation' in given)
    return execute(doc, command, params, ctx);
  const as = String(given['userId'] ?? given['decidedBy'] ?? given['by'] ?? 'u-1');
  return execute(doc, command, confirmed(doc, command, given, as), ctx);
}

/** Run exactly what is given: no auto-confirmation (attack tests). */
export const runRaw = (doc: CadDocument, command: string, params: unknown, ctx: ExecutionContext = humanContext()): CommandResult =>
  execute(doc, command, params, ctx);

export const loadSample = (): CadDocument =>
  execute(createEmptyDocument(), 'load_document', { json: readValidation('sample_document.json') }).document;

/** Value at a dotted `path` of `root` (`length` of an array included). */
function at(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export interface ScenarioStep {
  readonly n?: number;
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly expect: Record<string, unknown>;
}

export interface ScenarioOptions {
  /** Command renamed in this build (the scenario text predates it). */
  readonly rename?: Readonly<Record<string, string>>;
  /** Params adjusted before the call (e.g. the test host policy). */
  readonly patch?: (step: ScenarioStep) => Record<string, unknown>;
  readonly ctx?: ExecutionContext;
}

/** Execute one scenario step against `doc` and assert its machine-checkable expectations; returns the next document. */
export function runStep(doc: CadDocument, step: ScenarioStep, options: ScenarioOptions = {}): CadDocument {
  const command = options.rename?.[step.command] ?? step.command;
  const params = options.patch?.(step) ?? step.params;
  const result = run(doc, command, params, options.ctx);
  const want = step.expect;
  const label = `step ${step.n ?? '?'} ${command}`;
  const next = result.document;
  const where = (path: string): unknown =>
    path.startsWith('data.error.')
      ? at(result.error, path.slice('data.error.'.length))
      : at(path.startsWith('data.') ? { data: result.data } : next, path);
  if (want['refused'] === true) expect(result.rejected, `${label} refused: ${result.summary}`).toBe(true);
  if (want['refused'] === false) expect(result.rejected, `${label} must not be refused: ${result.summary}`).toBeUndefined();
  if (want['documentUnchanged'] === true) expect(next, label).toBe(doc);
  if (want['readOnly'] === true) {
    expect(next, label).toBe(doc);
    expect(result.affected, label).toEqual([]);
  }
  if (typeof want['summaryContains'] === 'string') expect(result.summary, label).toContain(want['summaryContains']);
  if (typeof want['summaryMatches'] === 'string') expect(result.summary, label).toMatch(new RegExp(want['summaryMatches']));
  if (want['featureHistoryLengthUnchanged'] === true) expect(next.featureHistory.length, label).toBe(doc.featureHistory.length);
  for (const [key, expected] of Object.entries(want)) {
    if (
      [
        'refused',
        'documentUnchanged',
        'readOnly',
        'summaryContains',
        'summaryMatches',
        'featureHistoryLengthUnchanged',
        'note',
        'auditEventEmitted',
      ].includes(key)
    )
      continue;
    if (key.endsWith('Equals') || key.endsWith('Unchanged') || key.endsWith('DiffersFrom')) continue;
    if (key.startsWith('plm_status.')) {
      const status = run(next, 'plm_status', {});
      expect(at({ data: status.data }, key.replace('plm_status.', '')), `${label} ${key}`).toEqual(expected);
      continue;
    }
    expect(where(key), `${label} ${key}`).toEqual(expected);
  }
  for (const [key, expected] of Object.entries(want)) {
    if (key.endsWith('Unchanged') && expected === true) {
      const path = key.replace(/Unchanged$/, '');
      expect(at(next, path), `${label} ${path} unchanged`).toEqual(at(doc, path));
    }
    if (key.endsWith('DiffersFrom') && typeof expected === 'string') {
      const path = key.replace(/DiffersFrom$/, '');
      expect(at(next, path), `${label} ${path} differs`).not.toEqual(at(next, expected));
    }
  }
  return next;
}
