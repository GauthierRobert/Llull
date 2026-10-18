/** Command assertions shared by the command-layer suites: must succeed, must answer with data, must refuse with a stable code. */

import { expect } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';

/** Runs a command that must succeed (changes the document or answers) and returns the result. */
export function ok(doc: CadDocument, name: string, params: unknown): CommandResult {
  const result = execute(doc, name, params);
  expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
  return result;
}

export const apply = (doc: CadDocument, name: string, params: unknown): CadDocument => ok(doc, name, params).document;

/** `data` of a query that must have answered. */
export function data<T = Record<string, unknown>>(doc: CadDocument, name: string, params: unknown): T {
  const result = ok(doc, name, params);
  expect(result.data, result.summary).toBeDefined();
  return result.data as T;
}

/** A refusal: unchanged document, rejected flag, the stable code and a remediation. */
export function expectRefusal(doc: CadDocument, name: string, params: unknown, code: string, path?: string): CommandResult {
  const result = execute(doc, name, params);
  expect(result.rejected, result.summary).toBe(true);
  expect(result.document).toBe(doc);
  expect(result.affected).toEqual([]);
  expect(result.error?.code, result.summary).toBe(code);
  expect(result.error?.remediation.length).toBeGreaterThan(0);
  if (path !== undefined) expect(result.error?.paths).toContain(path);
  return result;
}
