import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { RegionEntity } from '@core/model/types';

const shapeLines = vi.hoisted(() => vi.fn());
vi.mock('@ui/viewport/2d/entities/ShapeLine', () => ({
  ShapeLine: (props: { positions: number[]; segments?: boolean }): null => {
    shapeLines(props);
    return null;
  },
}));

import { RegionRenderer } from '@ui/viewport/2d/entities/RegionRenderer';

const SQUARE_LOOP: RegionEntity['loops'][number] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
const HOLE_LOOP: RegionEntity['loops'][number] = [
  [4, 4],
  [6, 4],
  [6, 6],
  [4, 6],
];

const region = (overrides: Partial<RegionEntity>): RegionEntity => ({
  id: 'r1',
  kind: 'region',
  loops: [SQUARE_LOOP, HOLE_LOOP],
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'layer-default',
  color: '#4a90d9',
  ...overrides,
});

describe('RegionRenderer', () => {
  it('draws one segment list for every loop edge (4 + 4 edges = 8 segments of 2 vertices) and one for the hatch lines', () => {
    shapeLines.mockClear();
    render(<RegionRenderer entity={region({ hatch: { pattern: 'lines', angle: 0, spacing: 2 } })} selected={false} />);
    expect(shapeLines).toHaveBeenCalledTimes(2);
    const [outline, hatch] = shapeLines.mock.calls.map(([props]) => props as { positions: number[]; segments?: boolean });
    expect(outline?.segments).toBe(true);
    expect(outline?.positions).toHaveLength(8 * 2 * 3);
    // y = 2, 4 (touches the hole edge: skipped by the half-open rule), 6, 8; 0 too: every line has an even number of crossings
    expect(hatch?.positions.length).toBeGreaterThan(0);
    expect((hatch?.positions.length ?? 0) % 6).toBe(0);
  });

  it('draws no hatch lines for none and solid (solid is a filled mesh)', () => {
    for (const hatch of [undefined, { pattern: 'solid' as const, angle: 0, spacing: 2 }]) {
      shapeLines.mockClear();
      const { container } = render(<RegionRenderer entity={region(hatch === undefined ? {} : { hatch })} selected />);
      expect(shapeLines).toHaveBeenCalledTimes(1);
      expect(container.querySelector('mesh') !== null).toBe(hatch !== undefined);
    }
  });
});
