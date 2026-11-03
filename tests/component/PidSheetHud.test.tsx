import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createEmptyDocument } from '@core/model/types';
import { useStore } from '@ui/store';
import { usePidViewStore } from '@ui/store/pidViewStore';
import { PidSheetHud } from '@ui/viewport/2d/PidSheetHud';
import { pidItemRows } from '@ui/viewport/2d/pidItemRows';
import type { PidItem } from '@aec/index';
import { apply } from '../helpers/commandAssertions';

function load(): PidItem {
  let doc = apply(createEmptyDocument(), 'create_pid_sheet', { number: 'PID-001', title: 'Feed' });
  doc = apply(doc, 'create_pid_sheet', { number: 'PID-002', title: 'Product' });
  doc = apply(doc, 'add_pid_equipment', { sheet: 'PID-001', class: 'Tank', tag: 'T-101', at: [100, 100] });
  useStore.getState().setDocument(doc);
  return Object.values(doc.plant?.pid?.items ?? {}).find((i) => i.tag === 'T-101') as PidItem;
}

describe('PidSheetHud', () => {
  it('renders nothing without a P&ID model', () => {
    const { container } = render(<PidSheetHud />);
    expect(container.firstChild).toBeNull();
  });

  it('picks the active sheet in the UI store (not the document)', () => {
    load();
    render(<PidSheetHud />);
    const select = screen.getByLabelText('P&ID sheet') as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    const before = useStore.getState().document;
    const second = before.plant?.pid?.sheetOrder[1] as string;
    fireEvent.change(select, { target: { value: second } });
    expect(usePidViewStore.getState().activeSheetId).toBe(second);
    expect(select.value).toBe(second);
    expect(useStore.getState().document).toBe(before);
  });

  it('falls back to the first sheet when the chosen one is not in the model', () => {
    load();
    usePidViewStore.getState().setActiveSheet('gone');
    render(<PidSheetHud />);
    const first = useStore.getState().document.plant?.pid?.sheetOrder[0];
    expect((screen.getByLabelText('P&ID sheet') as HTMLSelectElement).value).toBe(first);
  });

  it('shows the picked item read-only and clears it', () => {
    const tank = load();
    usePidViewStore.getState().setPicked({ id: tank.id, kind: tank.kind });
    render(<PidSheetHud />);
    expect(screen.getByText('T-101')).toBeTruthy();
    expect(screen.getByText('equipment')).toBeTruthy();
    expect(screen.getByText(tank.dexpiClass)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Clear P&ID selection'));
    expect(usePidViewStore.getState().picked).toBeNull();
    expect(screen.queryByLabelText('P&ID item')).toBeNull();
  });

  it('lists the typed fields and attributes of an item', () => {
    const tank = load();
    const rows = pidItemRows({ ...tank, attributes: { Volume: { kind: 'quantity', value: 5, unit: 'm3' } } } as PidItem);
    expect(rows[0]).toEqual({ label: 'Class', value: tank.dexpiClass });
    expect(rows).toContainEqual({ label: 'Volume', value: '5 m3' });
  });
});
