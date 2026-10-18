import { resetStore } from '../helpers/componentEntities';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useLayoutStore, useStore } from '@ui/store';
import { useFocusHousekeeping } from '@ui/hooks/useFocusHousekeeping';
import { type PanelFocus, useFocusStore } from '@ui/store/focusStore';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { FocusBanner } from '@ui/viewport/FocusBanner';
import { KpiStrip, ListRow, StatusChip } from '@ui/panels/PanelParts';
import { localDispatch } from '../helpers/storeTestHelpers';

function focusOf(entityIds: string[]): PanelFocus {
  return { key: 'test:item:1', label: 'Load F1 — 500 N', color: '#ff4fd8', entityIds, markers: [{ position: [1, 2, 3], label: '500 N' }] };
}

describe('panel focus (click a row → highlight on the model)', () => {
  beforeEach(() => {
    resetStore();
    useFocusStore.setState({ focus: null });
  });

  it('focusItem selects the entities and records the markers; a second call clears both', () => {
    const boxId = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    const { result } = renderHook(() => useFocusItem());
    act(() => result.current(focusOf([boxId])));
    expect(useFocusStore.getState().focus?.key).toBe('test:item:1');
    expect(useStore.getState().document.selection).toEqual([boxId]);
    act(() => result.current(focusOf([boxId])));
    expect(useFocusStore.getState().focus).toBeNull();
    expect(useStore.getState().document.selection).toEqual([]);
  });

  it('a marker-only focus keeps the current selection', () => {
    const boxId = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    useStore.getState().select([boxId]);
    const { result } = renderHook(() => useFocusItem());
    act(() => result.current(focusOf([])));
    expect(useStore.getState().document.selection).toEqual([boxId]);
  });

  it('the banner names the highlighted item and its ✕ clears it', () => {
    render(<FocusBanner />);
    expect(screen.queryByTestId('focus-banner')).toBeNull();
    act(() => useFocusStore.getState().setFocus(focusOf([])));
    expect(screen.getByTestId('focus-banner').textContent).toContain('Load F1 — 500 N');
    fireEvent.click(screen.getByRole('button', { name: 'Clear highlight' }));
    expect(useFocusStore.getState().focus).toBeNull();
  });
});

describe('panel focus never goes stale', () => {
  beforeEach(() => {
    resetStore();
    useFocusStore.setState({ focus: null });
  });

  it('drops the highlight when its entity is deleted or moved, but not on a selection change', () => {
    const boxId = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    renderHook(() => useFocusHousekeeping());
    act(() => useFocusStore.getState().setFocus(focusOf([boxId])));
    act(() => useStore.getState().select([boxId]));
    expect(useFocusStore.getState().focus).not.toBeNull();
    act(() => void localDispatch('move_entities', { ids: [boxId], delta: [1, 0, 0] }));
    expect(useFocusStore.getState().focus).toBeNull();
    act(() => useFocusStore.getState().setFocus(focusOf([boxId])));
    act(() => void localDispatch('delete_entities', { ids: [boxId] }));
    expect(useFocusStore.getState().focus).toBeNull();
  });

  it('drops the highlight when the sidebar switches panel', () => {
    renderHook(() => useFocusHousekeeping());
    act(() => useFocusStore.getState().setFocus(focusOf([])));
    act(() => useLayoutStore.setState({ sidebarTab: useLayoutStore.getState().sidebarTab === 'layers' ? 'objects' : 'layers' }));
    expect(useFocusStore.getState().focus).toBeNull();
  });
});

describe('PanelParts glance helpers', () => {
  it('ListRow draws its legend swatch in the glyph colour', () => {
    render(
      <ul>
        <ListRow swatch="#4fc3f7" onSelect={() => undefined}>
          <span>Fixed support</span>
        </ListRow>
      </ul>,
    );
    const swatch = document.querySelector('.panel__swatch') as HTMLElement;
    expect(swatch.style.background).toBe('rgb(79, 195, 247)');
  });

  it('KpiStrip tiles show value + verdict, and a clickable tile calls back', () => {
    let clicked = 0;
    render(
      <KpiStrip
        label="Results"
        items={[
          { key: 'stress', label: 'Max stress', value: '212 MPa', sub: 'FoS 1.18', tone: 'ok', onClick: () => (clicked += 1) },
          { key: 'disp', label: 'Max disp.', value: '0.4 mm' },
        ]}
      />,
    );
    expect(screen.getByTestId('kpi-stress').className).toContain('panel__kpi--ok');
    fireEvent.click(screen.getByTestId('kpi-stress'));
    expect(clicked).toBe(1);
    expect(screen.getByTestId('kpi-disp').tagName).toBe('DIV');
  });

  it('StatusChip renders its tone', () => {
    render(<StatusChip tone="bad" text="2 failing" testId="chip" />);
    expect(screen.getByTestId('chip').className).toContain('panel__status--bad');
  });
});
