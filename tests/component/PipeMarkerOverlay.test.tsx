import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';
import { useStore } from '@ui/store';
import { usePipeMarkerStore } from '@ui/store/pipeMarkerStore';
import { PipeMarkerOverlay } from '@ui/viewport/3d/pipeMarkers/PipeMarkerOverlay';
import { localDispatch, resetOfflineStore } from '../helpers/storeTestHelpers';

const created: number[] = [];

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class CountingInstancedMesh extends three.InstancedMesh {
    constructor(geometry: import('three').BufferGeometry, material: import('three').Material, count: number) {
      super(geometry, material, count);
      created.push(count);
    }
  }
  return { ...three, InstancedMesh: CountingInstancedMesh };
});
vi.mock('@react-three/fiber', () => ({
  useThree: (select: (state: { invalidate: () => void }) => unknown) => select({ invalidate: () => {} }),
}));
vi.mock('@react-three/drei', () => ({
  Billboard: ({ children }: { children?: React.ReactNode }) => <div data-testid="marker-label">{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

function pipesWithStoredMarkers(): number {
  localDispatch('add_pipe_run', {
    points: [
      [0, 0, 3000],
      [20000, 0, 3000],
      [20000, 5000, 3000],
    ],
    dn: 100,
    line: 'CW-101',
    service: 'cooling water',
  });
  localDispatch('add_pipe_markers', {});
  return Object.keys(useStore.getState().document.display?.pipeMarkers ?? {}).length;
}

describe('PipeMarkerOverlay draws the stored display.pipeMarkers', () => {
  beforeEach(() => {
    resetOfflineStore();
    usePipeMarkerStore.setState({ shown: true });
    created.length = 0;
  });

  it('renders one instanced mesh of N instances for N stored markers (one draw call)', () => {
    const count = pipesWithStoredMarkers();
    expect(count).toBeGreaterThan(1);
    render(<PipeMarkerOverlay />);
    expect(created.at(-1)).toBe(count);
    expect(new Set(created.filter((n) => n > 0)).size).toBe(1);
  });

  it('renders nothing when the display flag is off, and again when it is switched on', () => {
    const count = pipesWithStoredMarkers();
    usePipeMarkerStore.setState({ shown: false });
    const view = render(<PipeMarkerOverlay />);
    expect(created).toEqual([]);
    expect(view.container.innerHTML).toBe('');
    act(() => usePipeMarkerStore.setState({ shown: true }));
    expect(created.at(-1)).toBe(count);
  });
});
