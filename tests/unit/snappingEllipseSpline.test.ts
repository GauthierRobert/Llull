import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { collectSnapCandidates } from '../../src/ui/viewport/2d/snapping/candidates';

const base = {
  position: [10, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  layerId: 'layer-default',
  color: '#ffffff',
};

describe('collectSnapCandidates — ellipse and spline', () => {
  it('snaps an ellipse center and quadrant points (position applied)', () => {
    const document = {
      ...createEmptyDocument(),
      entities: {
        e1: { ...base, id: 'e1', kind: 'ellipse', center: [1, 2], radiusX: 4, radiusY: 2 },
      },
      order: ['e1'],
    } as CadDocument;
    const pts = collectSnapCandidates(document);
    expect(pts).toContainEqual({ x: 11, y: 2, type: 'center' });
    expect(pts).toContainEqual({ x: 15, y: 2, type: 'endpoint' });
    expect(pts).toContainEqual({ x: 11, y: 0, type: 'endpoint' });
  });

  it('snaps every spline through-point as an endpoint', () => {
    const document = {
      ...createEmptyDocument(),
      entities: {
        s1: {
          ...base,
          id: 's1',
          kind: 'spline',
          points: [
            [0, 0],
            [1, 1],
            [2, 0],
          ],
          closed: false,
        },
      },
      order: ['s1'],
    } as CadDocument;
    const pts = collectSnapCandidates(document);
    expect(pts.filter((p) => p.type === 'endpoint')).toHaveLength(3);
    expect(pts).toContainEqual({ x: 11, y: 1, type: 'endpoint' });
  });
});
