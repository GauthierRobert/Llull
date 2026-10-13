import { expect } from 'vitest';
import type { execute } from '@core/commands/registry';

type Outcome = { readonly affected: readonly unknown[]; readonly document: unknown; readonly summary: string };

/** A rejected / no-op command: nothing affected, the very same document, optional summary text. */
export function expectNoOp(result: Outcome, doc: unknown, summary?: string): void {
  expect(result.affected).toHaveLength(0);
  expect(result.document).toBe(doc);
  if (summary) expect(result.summary).toContain(summary);
}

/** A command that added exactly one entity, of `kind`. */
export function expectSingleEntity(result: ReturnType<typeof execute>, kind: string): void {
  expect(result.affected).toHaveLength(1);
  expect(result.document.order).toHaveLength(1);
  expect(result.document.entities[result.affected[0]!]!.kind).toBe(kind);
}

/** Purity: `run` (which executes against `doc`) must leave `doc` deep-equal to its snapshot. */
export function expectPure(doc: unknown, run: () => unknown): void {
  const snapshot = JSON.stringify(doc);
  run();
  expect(JSON.stringify(doc)).toBe(snapshot);
}
