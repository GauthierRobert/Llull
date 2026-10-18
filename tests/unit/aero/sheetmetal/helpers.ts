import { expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { signedMeshVolume } from '@core/geometry/meshVolume';
import { apply, ok } from '../../../helpers/commandAssertions';

/** Rule params with `thresholds` given as { kind: { value, source } } converted to the command's list form. */
export function ruleParams(rule: Record<string, unknown>): Record<string, unknown> {
  const { thresholds, ...rest } = rule;
  if (thresholds === undefined || Array.isArray(thresholds)) return rule;
  return { ...rest, thresholds: Object.entries(thresholds as Record<string, object>).map(([kind, entry]) => ({ kind, ...entry })) };
}

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
  let doc = apply(createEmptyDocument(), 'create_sheet_metal_rule', ruleParams({ ...RULE, ...rule }));
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
