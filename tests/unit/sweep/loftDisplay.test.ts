/** DES-2c: the display rings of a ruled polygon loft are dense only where the ruled quads twist (a prism keeps its corner rings). */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type LoftEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';

const corners = [
  [5, -5],
  [5, 5],
  [-5, 5],
  [-5, -5],
];

function squareLoft(start: number): LoftEntity {
  const at = (z: number, first: number): Record<string, unknown> => ({
    section: corners.map((_, i) => corners[(i + first) % 4]),
    center: [0, 0, z],
  });
  const made = execute(createEmptyDocument(), 'loft_sections', { sections: [at(0, 0), at(50, start)], ruled: true, alignment: 'none' });
  return made.document.entities[made.affected[0] as string] as LoftEntity;
}

describe('display rings of a ruled polygon loft', () => {
  it('a prism (planar quads) keeps one ring point per corner', () => {
    expect(squareLoft(0).rings[0]).toHaveLength(4);
  });
  it('a loft whose top is turned a corner (twisted quads) gets 16 points per straight span', () => {
    expect(squareLoft(1).rings[0]).toHaveLength(64);
  });
});
