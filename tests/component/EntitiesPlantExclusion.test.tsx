import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useTintStore } from '@ui/store/tintStore';
import { resetStore } from '../helpers/componentEntities';
import { synRackDocument } from '../helpers/synRack';

const seen = vi.hoisted(() => ({ perEntity: new Set<string>(), covered: null as ReadonlySet<string> | null }));

vi.mock('@ui/viewport/3d/entities/solidMeshes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/viewport/3d/entities/solidMeshes')>();
  const record = ({ entity }: { entity: { id: string } }): null => {
    seen.perEntity.add(entity.id);
    return null;
  };
  return { SOLID_MESHES: Object.fromEntries(Object.keys(actual.SOLID_MESHES).map((kind) => [kind, record])) };
});
vi.mock('@ui/viewport/3d/InstancedRenderer', () => ({ InstancedRenderer: (): null => null }));
vi.mock('@ui/viewport/3d/plant/PlantBatchRenderer', () => ({
  PlantBatchRenderer: ({ covered }: { covered: ReadonlySet<string> }): null => {
    seen.covered = covered;
    return null;
  },
}));
vi.mock('@ui/viewport/3d/GridAnnotations3D', () => ({ GridAnnotations3D: (): null => null }));
vi.mock('@ui/viewport/3d/preview/PreviewLayer', () => ({ PreviewLayer: (): null => null }));
vi.mock('@ui/viewport/liveFx/LiveFxLayer', () => ({ LiveFxLayer: (): null => null }));
vi.mock('@ui/viewport/liveFx/LiveTransitionGroup', () => ({
  LiveTransitionGroup: ({ children }: { children: React.ReactNode }): React.ReactNode => children,
}));

import { Entities } from '@ui/viewport/3d/Entities';

describe('Entities with the plant batch renderer', () => {
  beforeEach(() => {
    seen.perEntity.clear();
    seen.covered = null;
    resetStore();
  });

  it('draws a covered entity only through the plant renderer, and a tinted one per entity', () => {
    const document = synRackDocument(8);
    useStore.setState({ document });
    const { rerender } = render(<Entities />);
    const covered = seen.covered as ReadonlySet<string>;
    expect(covered.size).toBeGreaterThan(1000);
    for (const id of covered) expect(seen.perEntity.has(id)).toBe(false);
    expect(seen.perEntity.size).toBe(document.order.length - covered.size);

    const tinted = [...covered][0] as string;
    seen.perEntity.clear();
    act(() => useTintStore.getState().setTints(new Map([[tinted, '#ff0000']])));
    rerender(<Entities />);
    expect(seen.covered?.has(tinted)).toBe(false);
    expect(seen.perEntity.has(tinted)).toBe(true);
  });

  it('leaves small documents to the per-entity path', () => {
    const document = synRackDocument(1);
    useStore.setState({ document });
    render(<Entities />);
    expect(seen.covered).toBeNull();
  });
});
