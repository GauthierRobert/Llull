import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { collectSnapCandidates } from '../../src/ui/viewport/2d/snapping/candidates';
import { isAngleOnArc } from '../../src/ui/viewport/2d/snapping/geometry';

const arcDoc = (startAngle: number, endAngle: number): CadDocument =>
  ({
    ...createEmptyDocument(),
    entities: {
      a1: {
        id: 'a1',
        kind: 'arc',
        center: [0, 0],
        radius: 1,
        startAngle,
        endAngle,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        layerId: 'layer-default',
        color: '#ffffff',
      },
    },
    order: ['a1'],
  }) as CadDocument;

describe('isAngleOnArc', () => {
  it('respects the CCW sweep including the 0/2π wrap', () => {
    expect(isAngleOnArc(0.1, 0, Math.PI)).toBe(true);
    expect(isAngleOnArc(-0.1, 0, Math.PI)).toBe(false);
    expect(isAngleOnArc(0, 1.5 * Math.PI, 0.5 * Math.PI)).toBe(true);
    expect(isAngleOnArc(Math.PI, 1.5 * Math.PI, 0.5 * Math.PI)).toBe(false);
  });
});

describe('arc tangent snaps', () => {
  it('only offers tangent points that lie on the swept arc', () => {
    // Upper half arc; from (2,0) tangent points are at ±60°; only +60° is on the arc.
    const tangents = collectSnapCandidates(arcDoc(0, Math.PI), {}, [2, 0]).filter(
      (p) => p.type === 'tangent',
    );
    expect(tangents).toHaveLength(1);
    expect(tangents[0]?.x).toBeCloseTo(0.5);
    expect(tangents[0]?.y).toBeCloseTo(Math.sqrt(3) / 2);
  });
});
