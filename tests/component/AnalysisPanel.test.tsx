import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { useStore, useLayoutStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { Sidebar } from '@ui/components/Sidebar';
import { AnalysisPanel } from '@ui/panels/analysis/AnalysisPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

const mocks = vi.hoisted(() => ({ svgResult: false, solved: null as null | 'modal' | 'static' }));

vi.mock('@ui/services/localQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/services/localQuery')>();
  return {
    ...actual,
    runQuery: (command: string, params: Record<string, unknown> = {}): ReturnType<typeof actual.runQuery> => {
      if (command === 'render_fea_results' && mocks.svgResult) {
        const data = {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
          field: 'von_mises',
          unit: 'MPa',
          min: { value: 0, at: [0, 0, 0] },
          max: { value: 123.4567, at: [1, 2, 3] },
          deformationScale: 5,
          resultSet: { label: 'load case LC1', time: 0 },
        };
        return { document: useStore.getState().document, summary: 'render_fea_results: ok', affected: [], data };
      }
      if (mocks.solved !== null && command === 'describe_analysis' && params['analysisId'] !== undefined) {
        const real = actual.runQuery(command, params);
        const data = real.data as { case: Record<string, unknown> };
        const results = mocks.solved === 'modal' ? { frequenciesHz: [209.73, 1299.4] } : {};
        const probes = { p1: { id: 'p1', name: 'tip temperature', quantity: 'temperature', point: [0, 0, 0] } };
        return { ...real, data: { ...data, state: 'solved', case: { ...data.case, type: mocks.solved, results, probes } } };
      }
      if (command === 'probe_history') {
        const series = [
          {
            probeId: 'p1',
            name: 'tip temperature',
            quantity: 'temperature',
            unit: 'C',
            points: [
              { time: 0, value: 20 },
              { time: 10, value: 85.5 },
            ],
          },
          {
            probeId: 'p2',
            name: 'wall flux',
            quantity: 'heat_flux',
            unit: 'W/m2',
            points: [
              { time: 0, value: 5 },
              { time: 10, value: 2 },
            ],
          },
        ];
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
        return {
          document: useStore.getState().document,
          summary: 'probe_history: ok',
          affected: [],
          data: { analysisId: 'a', series, svg },
        };
      }
      return actual.runQuery(command, params);
    },
  };
});

function seedAnalysis(): string {
  const box = localDispatch('add_box', { size: [10, 20, 30] }).affected[0]!;
  localDispatch('set_entity_name', { id: box, name: 'Bracket' });
  const created = localDispatch('create_analysis', { name: 'Bracket under load', analysisType: 'static' }).affected[0]!;
  localDispatch('set_part_idealization', { analysisId: created, entityId: box });
  localDispatch('add_fea_constraint', {
    analysisId: created,
    name: 'base fixed',
    kind: 'fixed',
    target: { entityId: box, facesNear: [[5, 10, 0]] },
  });
  localDispatch('add_fea_load', {
    analysisId: created,
    name: 'tip load',
    kind: 'force',
    loadCase: 'LC1',
    vector: [0, 0, -500],
    target: { entityId: box, facesNear: [[5, 10, 30]] },
  });
  return created;
}

describe('AnalysisPanel', () => {
  beforeEach(() => {
    cleanup();
    mocks.svgResult = false;
    mocks.solved = null;
    useStore.getState().setDocument(createEmptyDocument());
    useLayoutStore.setState({ sidebarTab: 'objects', sidebarOpen: true });
  });

  it('adds an Analysis tab to the sidebar rail', () => {
    render(<Sidebar />);
    expect(screen.getByRole('tab', { name: 'Analysis' })).toBeTruthy();
  });

  it('shows an empty state without analyses', () => {
    render(<AnalysisPanel />);
    expect(screen.getByText('No analyses yet')).toBeTruthy();
  });

  it('lists a case and shows its constraints, loads, parts and checks', () => {
    seedAnalysis();
    render(<AnalysisPanel />);
    expect(screen.getByText('Bracket under load')).toBeTruthy();
    expect(within(screen.getByLabelText('Constraints')).getByText('base fixed')).toBeTruthy();
    expect(within(screen.getByLabelText('Loads')).getByText(/force \[0, 0, -500\]/)).toBeTruthy();
    expect(within(screen.getByLabelText('Parts')).getByText('Bracket')).toBeTruthy();
    expect(screen.getByTestId('analysis-check-status')).toBeTruthy();
  });

  it('shows the refusal summary and the solve hint when not solved', () => {
    const id = seedAnalysis();
    render(<AnalysisPanel />);
    expect(screen.getByTestId('analysis-results-summary').textContent).toContain('render_fea_results');
    expect(screen.getByTestId('analysis-solve-hint').textContent).toContain(`llull fea_solve analysisId=${id}`);
    expect(screen.queryByTestId('analysis-plot')).toBeNull();
  });

  it('renders the plot image and extremes when the query returns an svg', () => {
    seedAnalysis();
    mocks.svgResult = true;
    render(<AnalysisPanel />);
    const img = screen.getByTestId('analysis-plot') as HTMLImageElement;
    expect(img.src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(screen.getByTestId('analysis-extremes').textContent).toContain('max 123.4567');
  });

  it('lists the modal frequencies and offers the mode number of the mode-shape plot', () => {
    seedAnalysis();
    mocks.solved = 'modal';
    render(<AnalysisPanel />);
    const list = screen.getByTestId('analysis-modes');
    expect(list.textContent).toContain('Mode 1209.73 Hz');
    expect(list.textContent).toContain('Mode 21299.4 Hz');
    expect(screen.getByTestId('analysis-mode')).toBeTruthy();
    expect(screen.queryByTestId('analysis-scale')).toBeNull();
  });

  it('plots the probe history and tabulates start, end and range of each probe', () => {
    seedAnalysis();
    mocks.solved = 'static';
    render(<AnalysisPanel />);
    expect((screen.getByTestId('analysis-probe-plot') as HTMLImageElement).src).toContain('data:image/svg+xml');
    const probes = screen.getByTestId('analysis-probes');
    expect(probes.textContent).toContain('tip temperature');
    expect(probes.textContent).toContain('20 → 85.5 (min 20, max 85.5) C');
    expect(probes.textContent).toContain('heat_flux · 5 → 2');
  });
});
