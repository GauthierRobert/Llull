/** holes_from_recognition (07 FTR FR-FTR-25): the plan of add_hole steps for recognised holes, and its refusals. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { RecognizedHole } from '@core/geometry/recognition/types';
import { holePlan } from '@core/commands/features/holePlan';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { ctxWith, manifoldSuite, plate } from '../../helpers/featureSupport';

manifoldSuite();

const hole = (overrides: Partial<RecognizedHole> = {}): RecognizedHole => ({
  subtype: 'simple',
  axisPoint: [10, 10, 10],
  axis: [0, 0, -1],
  diameter: 4,
  through: true,
  faceIndices: [1],
  confidence: 'exact',
  ...overrides,
});

describe('holePlan', () => {
  it('merges identical holes on one plane into one step with world points and chains the targets', () => {
    const actions = holePlan(
      [hole(), hole({ axisPoint: [20, 10, 10] }), hole({ diameter: 6 }), hole({ axisPoint: [10, 10, 0], axis: [0, 0, 1] })],
      'stock-1',
    );
    expect(actions.map((action) => action.as)).toEqual(['h1', 'h2', 'h3']);
    expect(actions[0]?.params).toMatchObject({
      target: 'stock-1',
      face: { near: [10, 10, 10] },
      points: [
        [10, 10, 10],
        [20, 10, 10],
      ],
      pointsFrame: 'world',
      hole: { kind: 'simple', diameter: 4 },
      extent: { kind: 'through_all' },
    });
    expect(actions[1]?.params).toMatchObject({ target: '$h1' });
    expect(actions[2]?.params).toMatchObject({ target: '$h2', face: { near: [10, 10, 0] } });
    expect(holePlan([], 'stock-1')).toEqual([]);
  });

  it('maps blind holes (drill point or flat), countersinks, counterbores and counterdrills', () => {
    const [blind, flat, csk, cbore, both] = holePlan(
      [
        hole({ through: false, depth: 6, drillPointAngleDeg: 118 }),
        hole({ axisPoint: [30, 10, 10], through: false, depth: 6 }),
        hole({ axisPoint: [40, 10, 10], subtype: 'countersink', cskDiameter: 9, cskAngleDeg: 100, cskDepth: 2 }),
        hole({ axisPoint: [50, 10, 10], subtype: 'counterbore', cboreDiameter: 10, cboreDepth: 5.5 }),
        hole({
          axisPoint: [60, 10, 10],
          subtype: 'countersink',
          cskDiameter: 12,
          cskAngleDeg: 90,
          cskDepth: 1,
          cboreDiameter: 10,
          cboreDepth: 3,
        }),
      ],
      '$base',
    ).map((action) => action.params);
    expect(blind).toMatchObject({ extent: { kind: 'blind', depth: 6, drillPointAngle: 118 } });
    expect(flat).toMatchObject({ extent: { kind: 'blind', depth: 6, drillPointAngle: 0 } });
    expect(csk).toMatchObject({ hole: { kind: 'countersink', cskDiameter: 9, cskAngle: 100 } });
    expect(cbore).toMatchObject({ hole: { kind: 'counterbore', cboreDiameter: 10, cboreDepth: 5.5 } });
    expect(both).toMatchObject({ hole: { kind: 'counterdrill', cboreDiameter: 10, cboreDepth: 4, cskDiameter: 12, cskAngle: 90 } });
  });
});

describe('holes_from_recognition', () => {
  it('is refused without an exact kernel (FTR_NEEDS_EXACT_KERNEL), for a missing id and without a kernel', () => {
    const stock = plate();
    expectPure(stock.doc, () => execute(stock.doc, 'holes_from_recognition', { id: stock.id, stock: stock.id }));
    const mesh = execute(stock.doc, 'holes_from_recognition', { id: stock.id, stock: stock.id });
    expectNoOp(mesh, stock.doc);
    expect(mesh.error?.code).toBe('FTR_NEEDS_EXACT_KERNEL');
    const missing = execute(stock.doc, 'holes_from_recognition', { id: 'nope', stock: 'x' });
    expect(missing.error?.code).toBe('FTR_PART_NOT_FOUND');
    const offline = execute(stock.doc, 'holes_from_recognition', { id: stock.id, stock: stock.id }, ctxWith(null));
    expectNoOp(offline, stock.doc);
  });
});
