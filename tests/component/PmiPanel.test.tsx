// 03 GDT M3 (VC-GDT-53): the PMI panel gathers params and dispatches commands; the viewport layer shows the active saved view's items.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createEmptyDocument } from '@core/model/types';
import { setGeometryKernel } from '@core/geometry/kernel';
import { useStore } from '@ui/store';
import { PmiPanel } from '@ui/panels/pmi/PmiPanel';
import { usePmiViewStore, visiblePmiItems } from '@ui/viewport/3d/pmiViewStore';
import { localDispatch, spyDispatch } from '../helpers/storeTestHelpers';
import { plateKernel } from '../helpers/pmiPlateKernel';

function reset(): void {
  useStore.getState().setDocument(createEmptyDocument());
  usePmiViewStore.setState({ showPmi: true });
}

function withPmi(): { entityId: string; datum: string; size: string; view: string } {
  const { affected } = localDispatch('add_box', { size: [120, 80, 12] });
  const entityId = affected[0] as string;
  const datum = localDispatch('add_datum_feature', { entityId, facesNear: [[30, 10, 0]], label: 'A' }).affected[0] as string;
  const size = localDispatch('add_size_dimension', {
    entityId,
    facesNear: [[50, 40, 6]],
    sizeKind: 'diameter',
    tolerance: { type: 'plusMinus', upper: 0.021, lower: 0 },
  }).affected[0] as string;
  const view = localDispatch('create_saved_view', { name: 'TOP', direction: 'top', pmiIds: [size] }).affected[0] as string;
  return { entityId, datum, size, view };
}

describe('PmiPanel', () => {
  beforeEach(() => {
    setGeometryKernel(plateKernel());
    reset();
  });
  afterEach(() => setGeometryKernel(null));

  it('shows an empty state without PMI', () => {
    render(<PmiPanel />);
    expect(screen.getByText('No PMI yet')).toBeTruthy();
    expect(screen.getByText('No saved views')).toBeTruthy();
  });

  it('lists items with their text and review state, and warns that nothing is approved', () => {
    const { datum, size } = withPmi();
    render(<PmiPanel />);
    expect(within(screen.getByTestId(`pmi-row-${datum}`)).getByText('[A]')).toBeTruthy();
    expect(within(screen.getByTestId(`pmi-row-${size}`)).getByText('Ø20 +0.021/0')).toBeTruthy();
    expect(screen.getByTestId(`pmi-row-${size}`).textContent).toContain('review required');
    expect(screen.getByTestId('review-required').textContent).toContain('2 PMI item(s)');
  });

  it('accept dispatches accept_pmi_review for an item awaiting review; reject needs a comment so it is disabled', () => {
    const { datum } = withPmi();
    const spy = spyDispatch();
    render(<PmiPanel />);
    fireEvent.click(screen.getByTestId(`pmi-accept-${datum}`));
    expect(spy).toHaveBeenCalledWith('accept_pmi_review', {
      pmiIds: [datum],
      decision: 'accept',
      comment: '',
      at: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    });
    const reject = screen.getByTestId(`pmi-reject-${datum}`) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    expect(reject.title).toContain('comment');
  });

  it('dispatches set_pmi_standard, delete_pmi and the saved-view commands', () => {
    const { datum, view } = withPmi();
    const spy = spyDispatch();
    render(<PmiPanel />);
    fireEvent.change(screen.getByTestId('pmi-standard'), { target: { value: 'ISO_GPS' } });
    expect(spy).toHaveBeenCalledWith('set_pmi_standard', { standard: 'ISO_GPS' });
    fireEvent.click(screen.getByTestId(`pmi-delete-${datum}`));
    expect(spy).toHaveBeenCalledWith('delete_pmi', { pmiId: datum });
    fireEvent.click(screen.getByTestId(`pmi-view-open-${view}`));
    expect(spy).toHaveBeenCalledWith('activate_saved_view', { savedViewId: view });
    fireEvent.click(screen.getByTestId(`pmi-view-delete-${view}`));
    expect(spy).toHaveBeenCalledWith('delete_saved_view', { savedViewId: view });
  });

  it('add datum gathers a face POINT (never a face index) and the optional letter', () => {
    const { entityId } = withPmi();
    const spy = spyDispatch();
    render(<PmiPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Add datum/ }));
    fireEvent.change(screen.getByTestId('pmi-datum-label'), { target: { value: 'B' } });
    fireEvent.click(screen.getByTestId('pmi-datum-add'));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText('Give the x, y and z of a point on the face.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pmi-datum-x'), { target: { value: '60' } });
    fireEvent.change(screen.getByTestId('pmi-datum-y'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('pmi-datum-z'), { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('pmi-datum-add'));
    expect(spy).toHaveBeenCalledWith('add_datum_feature', { entityId, facesNear: [[60, 0, 6]], label: 'B' });
  });

  it('add datum without a solid explains itself and dispatches nothing', () => {
    const spy = spyDispatch();
    render(<PmiPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Add datum/ }));
    fireEvent.click(screen.getByTestId('pmi-datum-add'));
    expect(screen.getByText('Add a 3D solid first.')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('the viewport toggle writes the view store', () => {
    render(<PmiPanel />);
    fireEvent.click(screen.getByTestId('pmi-show'));
    expect(usePmiViewStore.getState().showPmi).toBe(false);
  });
});

describe('visiblePmiItems', () => {
  beforeEach(() => {
    setGeometryKernel(plateKernel());
    reset();
  });
  afterEach(() => setGeometryKernel(null));

  it('is every item, or only the active saved view when one is open', () => {
    const { datum, size, view } = withPmi();
    const pmi = useStore.getState().document.pmi;
    expect(visiblePmiItems(pmi).map((item) => item.id)).toEqual([datum, size]);
    localDispatch('activate_saved_view', { savedViewId: view });
    expect(visiblePmiItems(useStore.getState().document.pmi).map((item) => item.id)).toEqual([size]);
    expect(visiblePmiItems(undefined)).toEqual([]);
  });
});
