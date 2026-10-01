import { beforeEach, describe, expect, it } from 'vitest';
import { defaultValues, type ElementTool } from '@ui/panels/building/elementTools';
import { INDUSTRIAL_TOOLS } from '@ui/panels/building/industrialTools';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { __resetIdCounter } from '@lib/id';

const context = { levelId: null, wallIds: [] };

function tool(id: string): ElementTool {
  const found = INDUSTRIAL_TOOLS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found;
}

function apply(doc: CadDocument, id: string, overrides: Record<string, string> = {}): CadDocument {
  const outcome = tool(id).build({ ...defaultValues(tool(id)), ...overrides }, context);
  if (!outcome.ok) throw new Error(outcome.reason);
  const result = execute(doc, outcome.command, outcome.params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
}

beforeEach(() => __resetIdCounter());

describe('industrial tools', () => {
  it('the default forms build a working steel hall with process plant', () => {
    let doc = apply(createEmptyDocument(), 'hall', {
      span: '18000',
      length: '24000',
      craneRailHeight: '5000',
    });
    doc = apply(doc, 'hall', { basePlates: 'false', x: '40000', span: '12000', length: '12000' });
    for (const id of [
      'member',
      'footing',
      'panel',
      'craneRunway',
      'equipment',
      'pipe',
      'tray',
      'basePlates',
    ]) {
      doc = apply(doc, id, id === 'footing' ? { underColumns: 'false' } : {});
    }
    const categories = new Set(
      Object.values(doc.building!.elements).map((element) => element.category),
    );
    for (const category of [
      'member',
      'footing',
      'panel',
      'equipment',
      'pipe',
      'tray',
      'slab',
      'grid',
    ]) {
      expect(categories.has(category as never), category).toBe(true);
    }
    const crane = Object.values(doc.building!.elements).filter(
      (element) => element.category === 'member' && element.role === 'crane',
    );
    expect(crane.length).toBeGreaterThan(0);
  });

  it('builds a multi-span hall from a list of widths', () => {
    const hall = tool('hall').build(
      { ...defaultValues(tool('hall')), spans: '20000, 25000' },
      context,
    );
    expect(hall.ok && hall.params).toMatchObject({ spans: [20000, 25000] });
    expect(hall.ok && 'span' in hall.params).toBe(false);
  });

  it('converts degrees and omits blank optional fields', () => {
    const member = tool('member').build({ ...defaultValues(tool('member')), roll: '90' }, context);
    expect(member.ok && member.params['roll']).toBeCloseTo(Math.PI / 2);
    const hall = tool('hall').build(defaultValues(tool('hall')), {
      ...context,
      levelId: 'level-1',
    });
    expect(hall.ok && hall.params).toMatchObject({ levelId: 'level-1', cladding: true });
    expect(hall.ok && 'crane' in hall.params).toBe(false);
    const equipment = tool('equipment').build(defaultValues(tool('equipment')), context);
    expect(equipment.ok && 'weight' in equipment.params).toBe(false);
  });

  it('reports malformed point lists and a missing equipment name', () => {
    expect(
      tool('pipe').build({ ...defaultValues(tool('pipe')), points: '0,0,0' }, context),
    ).toEqual({ ok: false, reason: 'Check: points' });
    expect(
      tool('panel').build({ ...defaultValues(tool('panel')), corners: '0,0; 1,0; 1,1' }, context),
    ).toEqual({ ok: false, reason: 'Check: corners' });
    expect(
      tool('equipment').build({ ...defaultValues(tool('equipment')), name: ' ' }, context),
    ).toEqual({ ok: false, reason: 'Equipment needs a name.' });
  });
});
