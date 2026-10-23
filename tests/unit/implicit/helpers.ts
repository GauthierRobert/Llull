/** Shared helpers of the implicit suites: run a command, take the first affected id, read data. */
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { type CadDocument, createEmptyDocument } from '@core/model/types';

export interface Step {
  readonly doc: CadDocument;
  readonly id: string;
  readonly result: CommandResult;
  readonly data: Record<string, unknown>;
}

/** Execute `name` on `doc`; `id` is the first affected id ('' when nothing changed). */
export function run(doc: CadDocument, name: string, params: Record<string, unknown>): Step {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] ?? '', result, data: (result.data ?? {}) as Record<string, unknown> };
}

/** Execute and require success. */
export function ok(doc: CadDocument, name: string, params: Record<string, unknown>): Step {
  const step = run(doc, name, params);
  if (step.result.error !== undefined || step.result.rejected === true) throw new Error(`${name} failed: ${step.result.summary}`);
  return step;
}

export const empty = (): CadDocument => createEmptyDocument();

/** Command result is a refusal with `code` and an unchanged document. */
export function expectRefused(doc: CadDocument, step: Step, code: string): void {
  if (step.result.error?.code !== code)
    throw new Error(`expected ${code}, got ${step.result.error?.code ?? 'success'}: ${step.result.summary}`);
  if (step.doc !== doc) throw new Error('refusal changed the document');
  if (step.result.affected.length !== 0) throw new Error('refusal affected ids');
}

/** Deterministic low-discrepancy points in [-half, half]^3. */
export function lowDiscrepancyPoints(count: number, half: number): Array<[number, number, number]> {
  const phi = 1.2207440846057596;
  return Array.from({ length: count }, (_, n) => {
    const u = [1 / phi, 1 / phi ** 2, 1 / phi ** 3].map((a) => ((0.5 + (n + 1) * a) % 1) * 2 * half - half);
    return [u[0] ?? 0, u[1] ?? 0, u[2] ?? 0];
  });
}
