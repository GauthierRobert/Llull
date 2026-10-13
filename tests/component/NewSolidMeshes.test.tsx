import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@ui/store';
import { dispatchEntity, resetStore } from '../helpers/componentEntities';

interface SolidCase {
  readonly command: string;
  readonly kind: string;
  readonly params: Record<string, unknown>;
  readonly checkParams: Record<string, unknown>;
  readonly expected: Record<string, unknown>;
}

const SOLIDS: readonly SolidCase[] = [
  {
    command: 'add_cone',
    kind: 'cone',
    params: { radius: 2, height: 5 },
    checkParams: { radius: 3, height: 8 },
    expected: { radius: 3, height: 8 },
  },
  {
    command: 'add_torus',
    kind: 'torus',
    params: { ringRadius: 4, tubeRadius: 1 },
    checkParams: { ringRadius: 5, tubeRadius: 1.5 },
    expected: { ringRadius: 5, tubeRadius: 1.5 },
  },
  { command: 'add_wedge', kind: 'wedge', params: { size: [4, 3, 6] }, checkParams: { size: [2, 4, 8] }, expected: { size: [2, 4, 8] } },
  {
    command: 'add_pyramid',
    kind: 'pyramid',
    params: { baseWidth: 4, baseDepth: 4, height: 6 },
    checkParams: { baseWidth: 6, baseDepth: 3, height: 9 },
    expected: { baseWidth: 6, baseDepth: 3, height: 9 },
  },
];

describe.each(SOLIDS)('EntityRenderer — $kind kind', (solid) => {
  beforeEach(resetStore);
  it(`${solid.command} produces an entity with kind "${solid.kind}" in the document`, () => {
    const { entity, affected } = dispatchEntity(solid.command, solid.params);
    expect(affected).toHaveLength(1);
    expect(entity.kind).toBe(solid.kind);
  });
  it(`${solid.kind} entity has the dimensions it was created with`, () => {
    const { entity } = dispatchEntity(solid.command, solid.checkParams);
    expect(entity.kind).toBe(solid.kind);
    expect(entity).toMatchObject(solid.expected);
  });
  it(`${solid.kind} entity has a position and appears in document.order`, () => {
    const { id, entity } = dispatchEntity(solid.command, solid.params);
    expect(entity.position).toHaveLength(3);
    expect(useStore.getState().document.order).toContain(id);
  });
});
