import { describe, it, expect } from 'vitest';
import type { LineEntity } from '@core/model/types';
import { buildLineBatch } from '../../src/ui/viewport/2d/batchLines';

const line = (id: string, over: Partial<LineEntity> = {}): LineEntity => ({
  id,
  kind: 'line',
  start: [0, 0],
  end: [1, 0],
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'layer-default',
  color: '#ff0000',
  ...over,
});

describe('buildLineBatch', () => {
  it('lays out two vertices and two colours per line, relative to the first start', () => {
    const batch = buildLineBatch([
      line('a', { start: [10, 20], end: [12, 20] }),
      line('b', { start: [10, 25], end: [10, 30], color: '#00ff00' }),
    ]);
    expect(batch.anchor).toEqual([10, 20, 0]);
    expect(batch.positions).toEqual([0, 0, 0, 2, 0, 0, 0, 5, 0, 0, 10, 0]);
    expect(batch.colors.slice(0, 3)).toEqual([1, 0, 0]);
    expect(batch.colors.slice(6, 9)).toEqual([0, 1, 0]);
    expect(batch.colors).toHaveLength(batch.positions.length);
  });

  it('applies entity position, z and Z rotation in world space', () => {
    const batch = buildLineBatch([
      line('a', {
        start: [1, 0],
        end: [3, 0],
        position: [100, 50, 2],
        rotation: [0, 0, Math.PI / 2],
      }),
    ]);
    expect(batch.anchor[0]).toBeCloseTo(100);
    expect(batch.anchor[1]).toBeCloseTo(51);
    expect(batch.anchor[2]).toBe(2);
    expect(batch.positions[3]).toBeCloseTo(0);
    expect(batch.positions[4]).toBeCloseTo(2);
  });

  it('keeps sub-0.06 precision for lines at x about 1e6', () => {
    const base = 1_000_000;
    const batch = buildLineBatch([line('a', { start: [base + 0.01, 0], end: [base + 0.02, 0] })]);
    expect(Math.fround(batch.positions[3] as number)).toBeCloseTo(0.01, 6);
  });

  it('is empty for no lines', () => {
    expect(buildLineBatch([])).toEqual({ anchor: [0, 0, 0], positions: [], colors: [] });
  });
});
