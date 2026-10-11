import { expect } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';

/** Runs `[command, params]` steps in order; each must change the document. */
export function applySteps(
  start: CadDocument,
  steps: ReadonlyArray<readonly [string, Record<string, unknown>]>,
): CadDocument {
  let doc = start;
  for (const [name, params] of steps) {
    const result = execute(doc, name, params);
    expect(result.affected.length, `${name}: ${result.summary}`).toBeGreaterThan(0);
    doc = result.document;
  }
  return doc;
}
