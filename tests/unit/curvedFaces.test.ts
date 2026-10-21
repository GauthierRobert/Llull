import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type Entity, type MeshData } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { isCurvedPart } from '@core/geometry/curvedFaces';

const prismMesh = (sides: number): MeshData => {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides;
    positions.push(Math.cos(angle) * 5, Math.sin(angle) * 5, 0, Math.cos(angle) * 5, Math.sin(angle) * 5, 20);
  }
  positions.push(0, 0, 0, 0, 0, 20);
  const bottom = sides * 2;
  const top = bottom + 1;
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    indices.push(2 * i, 2 * j, 2 * i + 1, 2 * j, 2 * j + 1, 2 * i + 1, bottom, 2 * j, 2 * i, top, 2 * i + 1, 2 * j + 1);
  }
  return { positions, indices };
};
const entityOf = (command: string, params: Record<string, unknown>): Entity => {
  const added = execute(createEmptyDocument(), command, params);
  return added.document.entities[added.affected[0] ?? ''] as Entity;
};

describe('isCurvedPart: recipe signal first, dihedral heuristic as fallback', () => {
  const cylinder = entityOf('add_cylinder', { radius: 5, height: 20 });
  const box = entityOf('add_box', { size: [10, 10, 10] });
  it.each([8, 10, 12])('a %i-sided polygonal cylinder is curved because its recipe says cylinder', (sides) => {
    expect(isCurvedPart(cylinder, prismMesh(sides))).toBe(true);
  });
  it.each([6, 8, 10])('the same %i-sided prism as an untyped box/mesh stays ambiguous (not curved)', (sides) => {
    expect(isCurvedPart(box, prismMesh(sides))).toBe(false);
  });
  it('a fine 32-sided prism is curved by the dihedral fallback even without a recipe', () => {
    expect(isCurvedPart(box, prismMesh(32))).toBe(true);
  });
});
