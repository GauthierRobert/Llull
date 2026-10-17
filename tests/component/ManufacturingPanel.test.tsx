import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ManufacturingPanel } from '@ui/panels/manufacturing/ManufacturingPanel';
import { execute } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { resetStore } from '../helpers/componentEntities';
import { liveSnapshot, localDispatch, spyDispatch } from '../helpers/storeTestHelpers';
import { bracket } from '../unit/aero/sheetmetal/helpers';

function loadBracket(): string {
  const { doc, part } = bracket();
  useStore.getState().hydrateLiveDocument(liveSnapshot(doc));
  return part;
}

beforeEach(() => resetStore());

describe('ManufacturingPanel — empty', () => {
  it('asks for a part when the document has none', () => {
    render(<ManufacturingPanel />);
    expect(screen.getByText('No part to check.')).toBeInTheDocument();
  });
});

describe('ManufacturingPanel — sheet-metal part', () => {
  it('toggles the flat pattern with figures, bend table, review banner and provenance', () => {
    loadBracket();
    render(<ManufacturingPanel />);
    const toggle = screen.getByTestId('flat-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const result = screen.getByTestId('flat-result');
    expect(within(result).getByTestId('flat-figures')).toHaveTextContent('1 bend(s)');
    expect(within(result).getByTestId('flat-bends')).toBeInTheDocument();
    expect(within(result).getByTestId('review-required')).toHaveTextContent(/not approved/i);
    expect(within(result).getByTestId('flat-outline')).toBeInTheDocument();
    expect(screen.getByTestId('flat-provenance')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('flat-result')).toBeNull();
  });

  it('runs the checks and lists findings with the review banner', () => {
    loadBracket();
    render(<ManufacturingPanel />);
    fireEvent.click(screen.getByTestId('ftr-run'));
    expect(within(screen.getByTestId('ftr-findings-list')).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByTestId('ftr-overall')).toBeInTheDocument();
    expect(screen.getByTestId('mfg-findings')).toHaveTextContent('FTR_');
    expect(screen.getByTestId('review-required')).toBeInTheDocument();
  });

  it('marks the findings stale once the model changes', () => {
    loadBracket();
    render(<ManufacturingPanel />);
    fireEvent.click(screen.getByTestId('ftr-run'));
    expect(screen.queryByTestId('ftr-stale')).toBeNull();
    const changed = execute(useStore.getState().document, 'add_box', { size: [1, 1, 1] }).document;
    act(() => useStore.setState({ document: changed }));
    expect(screen.getByTestId('ftr-stale')).toBeInTheDocument();
  });

  it('draws the flat pattern through a command', () => {
    const part = loadBracket();
    const dispatch = spyDispatch();
    render(<ManufacturingPanel />);
    fireEvent.click(screen.getByTestId('flat-materialize'));
    expect(dispatch).toHaveBeenCalledWith('materialize_flat_pattern', { id: part });
  });
});

describe('ManufacturingPanel — machined part', () => {
  it('gathers an add_hole call with a countersink preset and shows the preset as unverified', () => {
    const box = localDispatch('add_box', { size: [40, 30, 6] }).affected[0] ?? '';
    const dispatch = spyDispatch();
    render(<ManufacturingPanel />);
    expect(screen.queryByTestId('flat-toggle')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /add hole/i, expanded: false }));
    fireEvent.change(screen.getByTestId('hole-near'), { target: { value: '20, 15, 6' } });
    fireEvent.change(screen.getByTestId('hole-point'), { target: { value: '5, 5' } });
    fireEvent.change(screen.getByTestId('hole-kind'), { target: { value: 'countersink' } });
    fireEvent.change(screen.getByTestId('hole-diameter'), { target: { value: '4' } });
    expect(screen.getByTestId('csk-preset-82')).toHaveTextContent('unverified');
    fireEvent.click(screen.getByTestId('csk-preset-100'));
    expect(screen.getByTestId('hole-csk-angle')).toHaveValue(100);
    fireEvent.change(screen.getByTestId('hole-csk-diameter'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('hole-submit'));
    expect(dispatch).toHaveBeenCalledWith('add_hole', {
      target: box,
      face: { near: [20, 15, 6] },
      points: [[5, 5]],
      hole: { kind: 'countersink', diameter: 4, cskAngle: 100, cskDiameter: 8 },
      extent: { kind: 'through_all' },
    });
  });

  it('does not dispatch an incomplete hole form', () => {
    localDispatch('add_box', { size: [40, 30, 6] });
    const dispatch = spyDispatch();
    render(<ManufacturingPanel />);
    fireEvent.click(screen.getByRole('button', { name: /add hole/i, expanded: false }));
    fireEvent.click(screen.getByTestId('hole-submit'));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('answers the feature table query with a table or its refusal', () => {
    localDispatch('add_box', { size: [40, 30, 6] });
    render(<ManufacturingPanel />);
    fireEvent.click(screen.getByTestId('features-run'));
    expect(
      screen.queryByTestId('features-empty') ?? screen.queryByTestId('features-table') ?? screen.getByTestId('features-status'),
    ).not.toBeNull();
  });
});
