/** Fixtures of the cfd tests: metre documents, bodies, a case builder and typed access to the prepare_cfd_case report. */

import { expect } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { type CadDocument, createEmptyDocument } from '@core/model/types';

export const metreDocument = (): CadDocument => ({ ...createEmptyDocument(), units: 'm' });

export const ctxWith = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });

/** Run `name`; it must neither be rejected nor carry an error. */
export function ok(doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CommandResult {
  const result = execute(doc, name, params, ctx);
  expect(result.rejected, result.summary).toBeUndefined();
  expect(result.error, result.summary).toBeUndefined();
  return result;
}

/** Add one entity with `command`; returns the document and the new id. */
export function addBody(
  doc: CadDocument,
  command: string,
  params: Record<string, unknown>,
  ctx?: ExecutionContext,
): { doc: CadDocument; id: string } {
  const result = ok(doc, command, params, ctx);
  return { doc: result.document, id: result.affected[0] as string };
}

/** Closed box as an indexed mesh body for import_mesh (outward winding unless `inward`). */
export function boxMesh(
  min: [number, number, number],
  size: [number, number, number],
  inward = false,
): { positions: number[]; indices: number[] } {
  const [x, y, z] = min;
  const [a, b, c] = size;
  const positions = [
    x,
    y,
    z,
    x + a,
    y,
    z,
    x + a,
    y + b,
    z,
    x,
    y + b,
    z,
    x,
    y,
    z + c,
    x + a,
    y,
    z + c,
    x + a,
    y + b,
    z + c,
    x,
    y + b,
    z + c,
  ];
  const outward = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const indices = inward ? outward.map((_, i) => outward[i - (i % 3) + [0, 2, 1][i % 3]!]!) : outward;
  return { positions, indices };
}

export const caseParams = (entityIds: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  entityIds,
  freestream: { speedMS: 1 },
  reference: { areaM2: 1, lengthM: 1 },
  ...overrides,
});

/** A document with one case `c1` over `entityIds`. */
export function withCase(doc: CadDocument, entityIds: string[], overrides: Record<string, unknown> = {}): CadDocument {
  return ok(doc, 'create_cfd_case', caseParams(entityIds, overrides)).document;
}

export interface Check {
  code: string;
  status: string;
  message: string;
  [key: string]: unknown;
}

export interface PrepareData {
  status: string;
  solver: string | null;
  checks: Check[];
  surface: Record<string, number | string | boolean | number[] | null | Record<string, number[]>> | null;
  smallFeatures: Array<{ kind: string; sizeM: number; at: number[]; entityId: string | null; count: number }>;
  domain: { box: { min: number[]; max: number[] }; rule: string } | null;
  frontalAreaM2: number | null;
  blockageRatio: number | null;
  grid: { cellsPerReferenceLength: number; targetCellM: number };
  estimate: {
    cells: number;
    bytes: number;
    fitsDevice: boolean | null;
    largestFittingCellsPerReferenceLength: number | null;
    solver: string;
  } | null;
  geometryHash: string | null;
  caseHash: string;
  defaults: Array<{ path: string; value: unknown; source: string }>;
  warnings: string[];
}

export function prepare(doc: CadDocument, params: Record<string, unknown> = {}, ctx?: ExecutionContext): PrepareData {
  const result = ok(doc, 'prepare_cfd_case', { caseId: 'c1', ...params }, ctx);
  return result.data as PrepareData;
}

export const rowOf = (data: PrepareData, code: string): Check => {
  const row = data.checks.find((check) => check.code === code);
  expect(row, `no check ${code} in ${data.checks.map((c) => c.code).join(', ')}`).toBeDefined();
  return row as Check;
};
