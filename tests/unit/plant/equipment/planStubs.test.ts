/**
 * Plant 03 EQP M5: nozzle stubs in the building plan (`buildPlanDrawing`, layer Q-EQPM): a neck line from the wall to the flange face, a flange line across
 * it and the mark; a nozzle that points up or down is the flange and neck circles with the mark. Positions equal the 3D ports (turned by the plan rotation).
 */

import { describe, expect, it } from 'vitest';
import type { DrawingPrimitive } from '@core/model/drawing';
import { buildPlanDrawing } from '@aec/building/drawings/planDrawing';
import { drumDocument, separatorDocument } from './equipmentFixtures';
import { apply } from '../../../helpers/commandAssertions';

const near = (actual: readonly number[], expected: readonly number[]): void =>
  expected.forEach((value, index) => expect(actual[index], `[${index}]`).toBeCloseTo(value, 6));
const layerOf = (primitives: DrawingPrimitive[]): DrawingPrimitive[] => primitives.filter((primitive) => primitive.layer === 'Q-EQPM');
const marks = (primitives: DrawingPrimitive[]): string[] =>
  primitives.flatMap((primitive) => (primitive.type === 'text' && /^[A-Z]\d$/.test(primitive.content) ? [primitive.content] : []));

describe('plan nozzle stubs of the SC-EQP-01 separator', () => {
  const primitives = layerOf(buildPlanDrawing(separatorDocument(), undefined)?.primitives ?? []);

  it('draws the mark of every nozzle and keeps the vessel circle, the clearance and the name', () => {
    expect(marks(primitives).sort()).toEqual(['M1', 'N1', 'N2', 'N3']);
    expect(primitives.some((primitive) => primitive.type === 'text' && primitive.content === 'V-101 HP separator')).toBe(true);
    expect(primitives.filter((primitive) => primitive.type === 'circle' && primitive.radius === 770)).toHaveLength(1);
  });

  it('a shell nozzle is a neck line from the wall (R + t/2) to the flange face and a flange line across it (N1 at 0 deg = north)', () => {
    const lines = primitives.filter((primitive): primitive is Extract<DrawingPrimitive, { type: 'line' }> => primitive.type === 'line');
    const neck = lines.find((line) => Math.abs(line.a[1] - 5755) < 1e-6 && line.a[0] === 5000);
    near(neck?.a ?? [], [5000, 5755]);
    near(neck?.b ?? [], [5000, 6000]);
    const flange = lines.find((line) => Math.abs(line.a[1] - 6000) < 1e-6 && Math.abs(line.b[1] - 6000) < 1e-6);
    expect(Math.abs((flange?.a[0] ?? 0) - (flange?.b[0] ?? 0))).toBeCloseTo(279.4, 6);
    const manway = lines.find((line) => Math.abs(line.b[1] - 4000) < 1e-6 && line.a[0] === 5000);
    near(manway?.a ?? [], [5000, 4245]);
  });

  it('a head nozzle (pointing along Z) is the flange circle and the neck circle at the plan position with the mark beside it', () => {
    const circles = primitives.filter(
      (primitive): primitive is Extract<DrawingPrimitive, { type: 'circle' }> => primitive.type === 'circle',
    );
    const flanges = circles.filter((circle) => circle.radius !== 770 && circle.center[0] === 5000 && circle.center[1] === 5000);
    expect(flanges.length).toBeGreaterThanOrEqual(4);
    expect(flanges.map((circle) => circle.radius)).toEqual(expect.arrayContaining([114.3, 57.15, 95.25, 44.45]));
    const mark = primitives.find((primitive) => primitive.type === 'text' && primitive.content === 'N2');
    expect(mark?.type === 'text' && mark.at[0]).toBeGreaterThan(5000);
  });

  it('turns with the plan rotation: rotated 90 deg clockwise, N1 faces east and its face is at [6000, 5000]', () => {
    const rotated = apply(separatorDocument(), 'update_equipment_parameters', { equipment: 'V-101', set: { planRotationDeg: 90 } });
    const lines = layerOf(buildPlanDrawing(rotated, undefined)?.primitives ?? []).filter(
      (primitive): primitive is Extract<DrawingPrimitive, { type: 'line' }> => primitive.type === 'line',
    );
    const neck = lines.find(
      (line) => Math.abs(line.b[0] - 6000) < 1e-6 && Math.abs(line.b[1] - 5000) < 1e-6 && Math.abs(line.a[0] - 5755) < 1e-6,
    );
    near(neck?.a ?? [], [5755, 5000]);
  });
});

describe('plan nozzle stubs without nozzles or on other elements', () => {
  it('a vessel without nozzles adds nothing; a horizontal drum draws its top nozzles as circles and its end nozzle as a line', () => {
    expect(marks(layerOf(buildPlanDrawing(separatorDocument(false), undefined)?.primitives ?? []))).toEqual([]);
    const drum = layerOf(buildPlanDrawing(drumDocument(), undefined)?.primitives ?? []);
    expect(marks(drum).sort()).toEqual(['N1', 'N2', 'N3', 'N4']);
    const lines = drum.filter((primitive): primitive is Extract<DrawingPrimitive, { type: 'line' }> => primitive.type === 'line');
    // N4 on the right head, projection 1000 from the tangent line (x = 3000): face at x = 4000
    expect(lines.some((line) => Math.abs(line.b[0] - 4000) < 1e-6 && Math.abs(line.b[1]) < 1e-6)).toBe(true);
  });
});
