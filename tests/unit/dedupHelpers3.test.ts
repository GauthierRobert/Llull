import { describe, expect, it } from 'vitest';
import { orderedEntities } from '@core/commands/entity/entityOps';
import { execute } from '@core/commands/registry';
import { docWith } from '../helpers/fixtureDocument';
import { ellipsePoint } from '@lib/arc';
import { isStringArray } from '@lib/isStringArray';
import { planPoint } from '@lib/vec2';
import { entityPlanPoint } from '@core/geometry/entityFrame';
import { roundedMetres, unitsToMm } from '@aec/shared/numeric';
import { paperMap, readableDimensionLabel, svgPoints } from '@aec/shared/sheetFrame';

describe('ellipsePoint', () => {
  it('samples the axis-aligned ellipse about the centre', () => {
    expect(ellipsePoint([1, 2], 3, 5, 0)).toEqual([4, 2]);
    const [x, y] = ellipsePoint([1, 2], 3, 5, Math.PI / 2);
    expect(x).toBeCloseTo(1, 12);
    expect(y).toBeCloseTo(7, 12);
  });
});

describe('planPoint', () => {
  it('rotates (u, v) counter-clockwise then offsets by the centre (x, y)', () => {
    const [x, y] = planPoint([10, 20, 99], Math.PI / 2, [2, 0]);
    expect(x).toBeCloseTo(10, 12);
    expect(y).toBeCloseTo(22, 12);
  });
  it('matches the inline expression bit for bit', () => {
    const angle = 0.7;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    expect(planPoint([1.1, 2.2], angle, [3.3, 4.4])).toEqual([
      1.1 + 3.3 * cos - 4.4 * sin,
      2.2 + 3.3 * sin + 4.4 * cos,
    ]);
  });
  it('is what entityPlanPoint applies about the entity Z rotation', () => {
    const entity = { position: [5, 6, 7], rotation: [0, 0, 0.3] } as const;
    expect(entityPlanPoint(entity, [1, 2])).toEqual(planPoint(entity.position, 0.3, [1, 2]));
  });
});

describe('isStringArray', () => {
  it('accepts arrays of strings only', () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isStringArray('a')).toBe(false);
    expect(isStringArray(undefined)).toBe(false);
  });
});

describe('sheet frame helpers', () => {
  it('svgPoints joins rounded x,y pairs with spaces', () => {
    expect(
      svgPoints([
        [1, 2.456],
        [3.001, 4],
      ]),
    ).toBe('1,2.46 3,4');
    expect(svgPoints([])).toBe('');
  });
  it('paperMap centres the model point in the viewport and flips Y', () => {
    const map = paperMap({ x: 10, y: 20, width: 100, height: 60 }, [5, 5], 2);
    expect(map([5, 5])).toEqual([60, 50]);
    expect(map([6, 7])).toEqual([62, 46]);
  });
  it('readableDimensionLabel flips upside-down text and offsets the anchor', () => {
    const up = readableDimensionLabel([0, 0], [10, 0], 1, 0);
    expect(up.angle).toBe(0);
    expect(up.middle[0]).toBeCloseTo(5, 12);
    expect(up.middle[1]).toBeCloseTo(-1.2, 12);
    expect(readableDimensionLabel([0, 0], [10, 0], -1, 0).angle).toBe(360);
    expect(readableDimensionLabel([0, 0], [0, 10], 0, -1).angle).toBe(90);
  });
});

describe('numeric helpers', () => {
  it('roundedMetres converts mm to metres at 2 decimals', () => {
    expect(roundedMetres(1234)).toBe(1.23);
    expect(roundedMetres(0)).toBe(0);
  });
  it('unitsToMm converts document-unit lengths to millimetres', () => {
    expect(unitsToMm({ units: 'm' })(1.5)).toBe(1500);
    expect(unitsToMm({ units: 'mm' })(42)).toBe(42);
  });
});

describe('check_model positive-field table', () => {
  it('flags NaN / Infinity sizes as degenerate (previously leaked through `x <= 0`)', () => {
    for (const radius of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const doc = docWith({ id: 'c', kind: 'cylinder', radius, height: 2 });
      const data = execute(doc, 'check_model', {}).data as {
        issues: Array<{ code: string; entityId?: string }>;
      };
      expect(data.issues.some((i) => i.code === 'degenerate_size' && i.entityId === 'c')).toBe(
        true,
      );
    }
    const healthy = docWith({ id: 'c', kind: 'cylinder', radius: 1, height: 2 });
    const data = execute(healthy, 'check_model', {}).data as { issues: Array<{ code: string }> };
    expect(data.issues.some((i) => i.code === 'degenerate_size')).toBe(false);
  });
});

describe('orderedEntities', () => {
  it('lists entities in document order and skips dangling ids', () => {
    const doc = docWith({ id: 'b', kind: 'point' }, { id: 'a', kind: 'point' });
    expect(orderedEntities(doc).map((e) => e.id)).toEqual(['b', 'a']);
    expect(orderedEntities({ ...doc, order: ['a', 'ghost'] }).map((e) => e.id)).toEqual(['a']);
  });
});
