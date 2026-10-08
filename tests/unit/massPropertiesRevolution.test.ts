import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';

describe('mass_properties on a revolution', () => {
  const revolved = execute(createEmptyDocument(), 'revolve_profile', {
    profile: [
      [1, 0],
      [2, 0],
      [2, 1],
      [1, 1],
    ],
  });
  const id = revolved.affected[0]!;

  it('computes volume and mass via Pappus', () => {
    const result = execute(revolved.document, 'mass_properties', { entityId: id, density: 2 });
    const data = result.data as { volume: number; mass: number };
    // area 1 * centroid radius 1.5 * 2π
    expect(data.volume).toBeCloseTo(3 * Math.PI);
    expect(data.mass).toBeCloseTo(6 * Math.PI);
  });

  it('advertises revolution as a supported kind', () => {
    expect(getCommand('mass_properties')?.description).toContain("'revolution'");
  });

  it('still rejects a 2D entity', () => {
    const line = execute(revolved.document, 'draw_line', { start: [0, 0], end: [1, 0] });
    const result = execute(line.document, 'mass_properties', {
      entityId: line.affected[0]!,
      density: 1,
    });
    expect(result.data).toBeUndefined();
    expect(result.affected).toEqual([]);
  });
});
