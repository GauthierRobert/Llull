import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { collectSnapCandidates } from '../../src/ui/viewport/2d/snapping/candidates';
import { entityToSegments, localToWorld2D } from '../../src/ui/viewport/2d/snapping/geometry';
import type { Entity } from '@core/model/types';

const QUARTER_TURN = Math.PI / 2;
const base = {
  position: [10, 0, 0] as [number, number, number],
  rotation: [0, 0, QUARTER_TURN] as [number, number, number],
  layerId: 'layer-default',
  color: '#ffffff',
};

const docOf = (entity: Record<string, unknown>): CadDocument =>
  ({
    ...createEmptyDocument(),
    entities: { e: { ...base, id: 'e', ...entity } },
    order: ['e'],
  }) as unknown as CadDocument;

describe('2D snapping honours rotation about Z', () => {
  it('localToWorld2D rotates about the entity origin then offsets', () => {
    const entity = { ...base, id: 'e', kind: 'point' } as Entity;
    const [x, y] = localToWorld2D(entity, 2, 0);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(2);
  });

  it('rotates line endpoints and midpoint', () => {
    const pts = collectSnapCandidates(docOf({ kind: 'line', start: [0, 0], end: [4, 0] }));
    const end = pts.find((p) => p.type === 'endpoint' && p.y > 3);
    expect(end?.x).toBeCloseTo(10);
    expect(end?.y).toBeCloseTo(4);
    const midpoint = pts.find((p) => p.type === 'midpoint');
    expect(midpoint?.y).toBeCloseTo(2);
  });

  it('rotates rectangle corners and center', () => {
    const doc = docOf({ kind: 'rectangle', width: 4, height: 2 });
    const pts = collectSnapCandidates(doc);
    const center = pts.find((p) => p.type === 'center');
    expect(center?.x).toBeCloseTo(9); // local (2,1) -> (-1,2) + (10,0)
    expect(center?.y).toBeCloseTo(2);
    const [first] = entityToSegments(doc.entities['e'] as Entity);
    expect(first?.[2]).toBeCloseTo(10);
    expect(first?.[3]).toBeCloseTo(4);
  });

  it('shifts arc end angles by the rotation', () => {
    const pts = collectSnapCandidates(
      docOf({ kind: 'arc', center: [0, 0], radius: 2, startAngle: 0, endAngle: QUARTER_TURN }),
    );
    const endpoints = pts.filter((p) => p.type === 'endpoint');
    expect(endpoints[0]?.x).toBeCloseTo(10);
    expect(endpoints[0]?.y).toBeCloseTo(2);
    expect(endpoints[1]?.x).toBeCloseTo(8);
    expect(endpoints[1]?.y).toBeCloseTo(0);
  });
});
