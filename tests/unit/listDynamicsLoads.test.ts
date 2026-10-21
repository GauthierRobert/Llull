/** list_dynamics_loads: read-only design loads of the rigid-body model (weights, joint axes, drives). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { LoadItem } from '@dynamics/sim/dynamicsLoads';

function run(doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, name, params);
  expect(result.error, result.summary).toBeUndefined();
  return { doc: result.document, id: result.affected[0] ?? '' };
}

function rotor(): CadDocument {
  const disc = run(createEmptyDocument(), 'add_cylinder', { radius: 100, height: 20, axis: [0, 1, 0] });
  const body = run(disc.doc, 'add_rigid_body', { entityIds: [disc.id], name: 'flywheel' });
  return run(body.doc, 'add_body_joint', { kind: 'revolute', child: body.id, anchor: [0, 0, 0], axis: [0, 1, 0] }).doc;
}

const loadsOf = (result: ReturnType<typeof execute>): LoadItem[] => (result.data as { loads: LoadItem[] }).loads;

describe('list_dynamics_loads', () => {
  it('lists the weight and the joint axis, filterable by layer', () => {
    const doc = rotor();
    const all = execute(doc, 'list_dynamics_loads', {});
    expect(all.error, all.summary).toBeUndefined();
    expect(loadsOf(all).map((load) => load.layer)).toEqual(['gravity', 'joints']);
    expect(loadsOf(all)[0]?.value).toBe('W 48.4 N');
    expect(all.affected).toEqual([]);
    const weights = execute(doc, 'list_dynamics_loads', { layers: ['gravity'] });
    expect(loadsOf(weights)).toHaveLength(1);
  });

  it('is pure', () => {
    const doc = rotor();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'list_dynamics_loads', {});
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
  });

  it('reports no loads without a dynamics model and rejects an unknown layer', () => {
    const empty = execute(createEmptyDocument(), 'list_dynamics_loads', {});
    expect(loadsOf(empty)).toEqual([]);
    expect(empty.summary).toMatch(/no dynamics model/);
    const bad = execute(createEmptyDocument(), 'list_dynamics_loads', { layers: ['bogus'] });
    expect(bad.summary).toMatch(/rejected/);
  });
});
