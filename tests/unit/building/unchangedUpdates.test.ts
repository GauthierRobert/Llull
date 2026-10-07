import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const expectNoOp = (doc: CadDocument, name: string, params: Record<string, unknown>): void => {
  const result = execute(doc, name, params);
  expect(result.document).toBe(doc);
  expect(result.affected).toEqual([]);
  expect(result.summary).toMatch(/already|nothing changed/);
};

describe('update_* / set_* commands with unchanged values are no-ops', () => {
  it('update_wall', () => {
    const doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [4000, 0],
      thickness: 200,
    }).document;
    expectNoOp(doc, 'update_wall', { wallId: 'wall-1' });
    expectNoOp(doc, 'update_wall', { wallId: 'wall-1', thickness: 200, end: [4000, 0] });
    const changed = execute(doc, 'update_wall', { wallId: 'wall-1', thickness: 250 });
    expect(changed.affected.length).toBeGreaterThan(0);
  });

  it('update_steel_member', () => {
    const doc = execute(createEmptyDocument(), 'add_steel_member', {
      profile: 'IPE300',
      role: 'beam',
      start: [0, 0, 3000],
      end: [4000, 0, 3000],
    }).document;
    expectNoOp(doc, 'update_steel_member', { memberId: 'member-1' });
    expectNoOp(doc, 'update_steel_member', { memberId: 'member-1', profile: 'IPE300' });
    const changed = execute(doc, 'update_steel_member', {
      memberId: 'member-1',
      profile: 'IPE400',
    });
    expect(changed.affected.length).toBeGreaterThan(0);
  });

  it('set_project_info', () => {
    const doc = execute(createEmptyDocument(), 'set_project_info', { name: 'Hall' }).document;
    expectNoOp(doc, 'set_project_info', { name: 'Hall' });
    expect(execute(doc, 'set_project_info', { name: 'Hall B' }).summary).toMatch(/updated/);
  });

  it('set_cost_rates', () => {
    const doc = execute(createEmptyDocument(), 'set_cost_rates', {
      rates: { 'wall.concrete.m3': 180 },
      currency: 'EUR',
    }).document;
    expectNoOp(doc, 'set_cost_rates', { rates: { 'wall.concrete.m3': 180 } });
    expectNoOp(doc, 'set_cost_rates', { rates: { 'wall.concrete.m3': 180 }, replace: true });
    const changed = execute(doc, 'set_cost_rates', { rates: { 'wall.concrete.m3': 190 } });
    expect(changed.summary).toMatch(/Stored 1 cost rate/);
  });
});
