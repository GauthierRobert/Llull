import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { collectSnapCandidates } from '../../src/ui/viewport/2d/snapping/candidates';
import {
  curveCurveIntersections,
  segmentCurveIntersections,
  type CircularCurve,
} from '../../src/ui/viewport/2d/snapping/curveIntersections';

const unit: CircularCurve = { cx: 0, cy: 0, r: 1, startAngle: 0, endAngle: 0, full: true };

describe('segmentCurveIntersections', () => {
  it('finds two crossings, one tangent touch, and none', () => {
    expect(segmentCurveIntersections([-2, 0, 2, 0], unit)).toHaveLength(2);
    expect(segmentCurveIntersections([-2, 1, 2, 1], unit)).toHaveLength(1);
    expect(segmentCurveIntersections([-2, 2, 2, 2], unit)).toHaveLength(0);
  });
  it('ignores crossings outside the finite segment or the arc sweep', () => {
    expect(segmentCurveIntersections([0, 0, 0.5, 0], unit)).toHaveLength(0);
    const upper: CircularCurve = { ...unit, endAngle: Math.PI, full: false };
    const pts = segmentCurveIntersections([-2, 0, 2, 0], upper);
    expect(pts).toHaveLength(2); // both endpoints of the half arc lie on the x axis
    expect(segmentCurveIntersections([0, -2, 0, -0.5], upper)).toHaveLength(0);
  });
  it('returns [] for a degenerate segment', () => {
    expect(segmentCurveIntersections([1, 0, 1, 0], unit)).toEqual([]);
  });
});

describe('curveCurveIntersections', () => {
  it('finds two points for overlapping circles and none for disjoint/concentric', () => {
    const other: CircularCurve = { ...unit, cx: 1 };
    const pts = curveCurveIntersections(unit, other);
    expect(pts).toHaveLength(2);
    expect(pts[0]?.[0]).toBeCloseTo(0.5);
    expect(curveCurveIntersections(unit, { ...unit, cx: 5 })).toEqual([]);
    expect(curveCurveIntersections(unit, { ...unit, r: 2 })).toEqual([]);
  });
});

describe('collectSnapCandidates — curve intersections', () => {
  it('snaps line × circle crossings', () => {
    const base = {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      layerId: 'layer-default',
      color: '#ffffff',
    };
    const document = {
      ...createEmptyDocument(),
      entities: {
        l1: { ...base, id: 'l1', kind: 'line', start: [-3, 0], end: [3, 0] },
        c1: { ...base, id: 'c1', kind: 'circle', center: [0, 0], radius: 2 },
      },
      order: ['l1', 'c1'],
    } as CadDocument;
    const hits = collectSnapCandidates(document).filter((p) => p.type === 'intersection');
    expect(hits).toHaveLength(2);
    expect(hits.map((p) => p.x).sort()).toEqual([-2, 2]);
  });
});
