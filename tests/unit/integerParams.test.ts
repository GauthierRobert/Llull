import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('integer index/count params are rejected by the schema when fractional', () => {
  const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const id = box.affected[0]!;
  const doc = box.document;

  it.each([
    ['array_linear', { id, count: 2.5, offset: [1, 0, 0] }],
    ['array_polar', { id, count: 2.5, center: [0, 0, 0] }],
    ['set_units', { displayPrecision: 1.5 }],
    ['add_spur_gear', { module: 1, teeth: 12.5, pressureAngle: 0.35, faceWidth: 2 }],
    ['motion_study', { mode: 'parameter', target: 'p', start: 0, end: 1, steps: 3.5 }],
    ['render_view', { turntable: { frames: 2.5 } }],
  ])('%s rejects a fractional integer param', (name, params) => {
    const result = execute(doc, name, params);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('invalid params');
  });
});
