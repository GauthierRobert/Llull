// 04 DIR M-UI: the control-net chip with its pole selection controls (falloff radius and profile, clear) and the box-selection rectangle.
// The controls change UI state only; no document change happens until a pole drag commits one command.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { NurbsNetBar } from '@ui/viewport/3d/nurbsNet/NurbsNetBar';
import { dispatchEntity, resetViewportStores } from '../helpers/componentEntities';
import { resetOfflineStore } from '../helpers/storeTestHelpers';

describe('NurbsNetBar', () => {
  beforeEach(() => {
    resetViewportStores({ qualityOverride: 'auto' });
    resetOfflineStore();
    useNurbsNetStore.setState({
      visible: false,
      selected: [],
      falloff: { radius: 0, shape: 'smooth' },
      marquee: null,
      drag: null,
      hover: null,
    });
    const curve = dispatchEntity('create_nurbs_curve', {
      degree: 2,
      poles: [
        [0, 0, 0],
        [1, 2, 0],
        [2, 0, 0],
      ],
    });
    useStore.getState().select([curve.id]);
  });
  afterEach(cleanup);

  it('shows the selection controls only while the poles are shown, and edits the falloff without touching the document', () => {
    render(<NurbsNetBar />);
    expect(screen.queryByLabelText('Falloff radius (poles)')).toBeNull();
    const before = JSON.stringify(useStore.getState().document);
    fireEvent.click(screen.getByText('Show poles'));
    expect(screen.getByText('Shift-click or Shift-drag a box to select poles')).not.toBeNull();
    const profile = screen.getByLabelText('Falloff profile') as HTMLSelectElement;
    expect(profile.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Falloff radius (poles)'), { target: { value: '2.5' } });
    expect(useNurbsNetStore.getState().falloff.radius).toBe(2.5);
    expect(profile.disabled).toBe(false);
    fireEvent.change(profile, { target: { value: 'linear' } });
    expect(useNurbsNetStore.getState().falloff).toEqual({ radius: 2.5, shape: 'linear' });
    fireEvent.change(screen.getByLabelText('Falloff radius (poles)'), { target: { value: '-3' } });
    expect(useNurbsNetStore.getState().falloff.radius).toBe(0);
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
  });

  it('names how many poles are selected and Clear empties the selection', () => {
    useNurbsNetStore.setState({ visible: true });
    render(<NurbsNetBar />);
    act(() => useNurbsNetStore.getState().setSelected([0, 2]));
    expect(screen.getByText('2 poles selected')).not.toBeNull();
    act(() => useNurbsNetStore.getState().setSelected([1]));
    expect(screen.getByText('1 pole selected')).not.toBeNull();
    fireEvent.click(screen.getByText('Clear'));
    expect(useNurbsNetStore.getState().selected).toEqual([]);
  });

  it('draws the box-selection rectangle from the marquee, whatever the corner order', () => {
    useNurbsNetStore.setState({ visible: true });
    render(<NurbsNetBar />);
    expect(screen.queryByTestId('net-marquee')).toBeNull();
    act(() => useNurbsNetStore.getState().setMarquee({ x0: 80, y0: 90, x1: 20, y1: 30 }));
    const box = screen.getByTestId('net-marquee');
    expect(box.style.left).toBe('20px');
    expect(box.style.top).toBe('30px');
    expect(box.style.width).toBe('60px');
    expect(box.style.height).toBe('60px');
  });
});
