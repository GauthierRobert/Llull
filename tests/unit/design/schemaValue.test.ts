/** Schema-directed binding and units: the target param's schema decides how each value reads. */

import { describe, expect, it } from 'vitest';
import { getCommand } from '@core/commands/registry';
import type { CommandDefinition } from '@core/commands/types';
import { parseDesign, type Pair } from '@design/parse';
import { AnchorRef, bindCommand, ExprRef, NameRef, type BoundCommand } from '@design/schemaValue';
import { DesignError } from '@design/errors';
import { convertUnits, lengthFactor } from '@design/units';

const mm = { units: 'mm' as const };

function bind(line: string, doc: { units: 'mm' | 'm' } = mm): BoundCommand {
  const [statement] = parseDesign(line);
  if (statement?.kind !== 'command') throw new Error('not a command');
  return bindCommand(getCommand(statement.command) as CommandDefinition<unknown>, statement.pairs as Pair[], doc, 1);
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DesignError) return error.code;
    throw error;
  }
  return 'none';
};

describe('bindCommand', () => {
  it('numbers fold, expressions stay, units convert', () => {
    const { params } = bind('add_box b size=[2*3, w, 1cm] position=[0, 0, t/2] anchor=base-center');
    expect(params['size']).toEqual([6, new ExprRef('w'), 10]);
    expect(params['position']).toEqual([0, 0, new ExprRef('t/2')]);
    expect(params['anchor']).toBe('base-center');
    expect(bind('add_box b size=[1m, 1, 1]', { units: 'm' }).params['size']).toEqual([1, 1, 1]);
  });

  it('enum members, string names, quoted text, booleans, dotted object keys', () => {
    expect(bind('boolean c op=union a=base b=boss').params).toEqual({ op: 'union', a: new NameRef('base'), b: new NameRef('boss') });
    expect(bind('add_box b size=[1,1,1] color="#ffffff"').params['color']).toBe('#ffffff');
    const hole = bind('add_hole h target=body face=base.top points=[[0,0]] hole.kind=simple hole.diameter=8mm extent.kind=through_all');
    expect(hole.params).toMatchObject({
      target: new NameRef('body'),
      face: new AnchorRef('base', 'top'),
      hole: { kind: 'simple', diameter: 8 },
      extent: { kind: 'through_all' },
    });
    expect(bind('check_assembly _ includeJoints=false').params['includeJoints']).toBe(false);
  });

  it('angle units only where the param angle unit is known', () => {
    const rotation = bind('add_box b size=[1,1,1] rotation=[0, 0, 90deg]').params['rotation'] as number[];
    expect(rotation[2]).toBeCloseTo(Math.PI / 2);
    expect(code(() => bind('add_box b size=[45deg, 1, 1]'))).toBe('DESIGN_UNIT_NOT_SUPPORTED');
  });

  it('placement sugar', () => {
    const { placement } = bind('add_box b size=[1,1,1] on=base.top align=back');
    expect(placement).toEqual({ on: new AnchorRef('base', 'top'), align: 'back' });
    expect(code(() => bind('add_box b size=[1,1,1] align=back'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('add_box b size=[1,1,1] on=base'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('add_box b size=[1,1,1] on=base.top align=up'))).toBe('DESIGN_BAD_VALUE');
  });

  it('refuses unknown params, bad enums, wrong shapes and bad expressions', () => {
    expect(code(() => bind('add_box b sise=[1,1,1]'))).toBe('DESIGN_UNKNOWN_PARAM');
    expect(code(() => bind('add_hole h hole.kinds=simple'))).toBe('DESIGN_UNKNOWN_PARAM');
    expect(code(() => bind('boolean c op=merge'))).toBe('DESIGN_BAD_ENUM');
    expect(code(() => bind('add_box b size=4'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('add_box b size=[1,1,1] position=[1, 2, 3+]'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('add_box b size=[1,1,"a"]'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('add_hole h hole=simple'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('add_box b size=[1,1,1] anchor.x=1'))).toBe('DESIGN_UNKNOWN_PARAM');
    expect(code(() => bind('add_hole h hole.kind=simple hole.kind.x=1'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('check_assembly _ includeJoints=1'))).toBe('DESIGN_BAD_VALUE');
    expect(code(() => bind('set_units _ units=[1]'))).toBe('DESIGN_BAD_ENUM');
  });

  it('JSON escape hatch passes a value through', () => {
    expect(bind('add_hole h face={"near": [0, 0, 1]}').params['face']).toEqual({ near: [0, 0, 1] });
  });
});

describe('units', () => {
  it('converts length literals to the document unit, never inside names', () => {
    expect(convertUnits('w/2 + 5mm', { units: 'cm' }, null, 1)).toBe('w/2 + 0.5');
    expect(convertUnits('2in', mm, null, 1)).toBe('50.8');
    expect(convertUnits('w2mm + 1m', mm, null, 1)).toBe('w2mm + 1000');
    expect(convertUnits('1rad', mm, 'add_hole.hole.cskAngle', 1)).toBe(String(Number((180 / Math.PI).toPrecision(15))));
    expect(lengthFactor('cm', mm)).toBe(10);
    expect(lengthFactor('kg', mm)).toBeNull();
  });
});
