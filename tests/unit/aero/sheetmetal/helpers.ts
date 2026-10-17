import { expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { signedMeshVolume } from '@core/geometry/meshVolume';

/** Runs a command that must succeed (changes the document or answers) and returns the result. */
export function ok(doc: CadDocument, name: string, params: unknown): CommandResult {
  const result = execute(doc, name, params);
  expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
  return result;
}

export const apply = (doc: CadDocument, name: string, params: unknown): CadDocument => ok(doc, name, params).document;

export const RULE = {
  name: 'AL2024-T3 1.6',
  material: '2024-T3',
  temper: 'T3',
  thickness: 1.6,
  insideRadius: 4.8,
  kFactor: 0.44,
  kFactorStandard: 'ansi',
  relief: { type: 'rectangular', widthRatio: 0.5 },
} as const;

export interface BuiltPart {
  readonly doc: CadDocument;
  readonly part: string;
  readonly profile: string;
}

/** The draft bracket plan: 33.6 x 50 base, 90-degree flange of 30 to the OML (T 1.6, R 4.8, K 0.44). */
export function bracket(rule: Record<string, unknown> = {}, flange: boolean = true): BuiltPart {
  let doc = apply(createEmptyDocument(), 'create_sheet_metal_rule', { ...RULE, ...rule });
  const drawn = ok(doc, 'draw_rectangle', { width: 33.6, height: 50, position: [0, 0, 0] });
  doc = drawn.document;
  const profile = drawn.affected[0] as string;
  const base = ok(doc, 'add_sheet_metal_base', { profileId: profile, rule: (rule['name'] as string | undefined) ?? RULE.name, side: 'up' });
  doc = base.document;
  const part = base.affected[0] as string;
  if (flange)
    doc = apply(doc, 'add_flange', {
      id: part,
      edge: { near: [33.6, 25, 0] },
      angle: 90,
      length: 30,
      lengthReference: 'outside_mold_line',
      position: 'material_outside',
    });
  return { doc, part, profile };
}

export function folded(doc: CadDocument, part: string): MeshSolidEntity {
  const entity = doc.entities[part];
  expect(entity?.kind).toBe('mesh');
  return entity as MeshSolidEntity;
}

export const meshVolume = (doc: CadDocument, part: string): number => {
  const entity = folded(doc, part);
  return signedMeshVolume(entity.mesh.positions, entity.mesh.indices);
};

export function meshBounds(doc: CadDocument, part: string): { min: [number, number, number]; max: [number, number, number] } {
  const positions = folded(doc, part).mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3)
    for (const axis of [0, 1, 2] as const) {
      min[axis] = Math.min(min[axis], positions[i + axis] as number);
      max[axis] = Math.max(max[axis], positions[i + axis] as number);
    }
  return { min, max };
}

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
