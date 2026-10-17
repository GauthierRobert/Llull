import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FastenersPanel } from '@ui/panels/fasteners/FastenersPanel';
import { useStore } from '@ui/store';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { resetStore } from '../helpers/componentEntities';
import { liveSnapshot, spyDispatch } from '../helpers/storeTestHelpers';
import { ctxWith, docWith, inchDocument, ok } from '../unit/aero/fasteners/fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});
beforeEach(() => resetStore());

function show(doc: CadDocument): void {
  useStore.getState().hydrateLiveDocument(liveSnapshot(doc));
}

function withStack(): CadDocument {
  const plates = ok(docWith(undefined, inchDocument()), 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
  const doc = plates.document;
  const stacked = ok(
    doc,
    'insert_fastener_stack',
    { family: 'NAS6203-6220', diameterDash: '3', stackIds: [plates.affected[0]], axisPoint: [1, 0.5, 0], nut: 'MS21042', holeMode: 'none' },
    ctxWith(kernel),
  );
  return stacked.document;
}

describe('FastenersPanel', () => {
  it('tells how to get a catalogue when there is none', () => {
    render(<FastenersPanel />);
    expect(screen.getByText('No fastener catalogue.')).toBeInTheDocument();
    expect(screen.getByTestId('fastener-insert-open')).toBeDisabled();
  });

  it('lists catalogue families with their licence badge', () => {
    show(docWith(undefined, inchDocument()));
    render(<FastenersPanel />);
    const families = screen.getByTestId('fastener-families');
    expect(within(families).getByTestId('family-NAS6203-6220')).toHaveTextContent('NAS6203-6220');
    expect(within(families).getAllByText(/./).length).toBeGreaterThan(3);
  });

  it('previews select_fastener live and only inserts on confirm', () => {
    show(docWith(undefined, inchDocument()));
    const dispatch = spyDispatch();
    render(<FastenersPanel />);
    fireEvent.click(screen.getByTestId('fastener-insert-open'));
    expect(screen.getByTestId('fastener-preview-empty')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('fastener-family'), { target: { value: 'MS20470' } });
    fireEvent.change(screen.getByTestId('fastener-stack'), { target: { value: '0.2' } });
    const preview = screen.getByTestId('fastener-preview');
    expect(preview).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('fastener-preview-pn')).toHaveTextContent('MS20470');
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('fastener-confirm')).toBeDisabled();
    fireEvent.change(screen.getByTestId('fastener-axis-point'), { target: { value: '1, 0.5, 0' } });
    fireEvent.click(screen.getByTestId('fastener-confirm'));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toBe('insert_fastener_stack');
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      family: 'MS20470',
      stack: { value: 0.2, unit: 'in' },
      axisPoint: [1, 0.5, 0],
      holeMode: 'cut_close_tolerance',
    });
    expect(screen.queryByTestId('fastener-confirm')).toBeNull();
  });

  it('shows the refusal reasons of an out-of-range stack and keeps Insert disabled', () => {
    show(docWith(undefined, inchDocument()));
    render(<FastenersPanel />);
    fireEvent.click(screen.getByTestId('fastener-insert-open'));
    fireEvent.change(screen.getByTestId('fastener-family'), { target: { value: 'NAS6203-6220' } });
    fireEvent.change(screen.getByTestId('fastener-stack'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('fastener-axis-point'), { target: { value: '0, 0, 0' } });
    expect(screen.getByTestId('fastener-preview')).toHaveAttribute('data-ok', 'false');
    expect(screen.getByTestId('fastener-preview-reasons')).toHaveTextContent('FAST_');
    expect(screen.getByTestId('fastener-confirm')).toBeDisabled();
  });

  it('shows placed stacks, deletes through a command, and the BOM standard-parts section', () => {
    show(withStack());
    const dispatch = spyDispatch();
    render(<FastenersPanel />);
    const stacks = screen.getByTestId('fastener-stacks');
    const stackId = Object.keys(useStore.getState().document.fasteners?.stacks ?? {})[0] ?? '';
    expect(within(stacks).getByTestId(`stack-${stackId}`)).toHaveTextContent('NAS6203');
    fireEvent.click(screen.getByTestId('bom-run'));
    expect(screen.getByTestId('bom-standard')).toHaveTextContent('NAS6203');
    expect(screen.getByTestId('bom-no-materials')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(`Delete stack ${stackId}`));
    expect(dispatch).toHaveBeenCalledWith('delete_fastener_stack', { stackIds: [stackId] });
    fireEvent.click(screen.getByTestId('layout-run'));
    expect(screen.getByTestId('layout-status')).toHaveTextContent('Layout:');
  });
});
