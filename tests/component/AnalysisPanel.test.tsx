import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { AnalysisCase } from '@core/model/analysis';
import { AnalysisPanel } from '@ui/panels/analysis/AnalysisPanel';
import { useStore } from '@ui/store';
import { useAnalysisViewStore } from '@ui/store/analysisViewStore';
import { resetStore } from '../helpers/componentEntities';
import { liveSnapshot } from '../helpers/storeTestHelpers';

function run(doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** A bracket with a static case (one support, two loads in two load cases) and a steady thermal case. */
function loadCases(): { staticId: string; thermalId: string } {
  let doc = useStore.getState().document;
  const box = run(doc, 'add_box', { size: [100, 20, 10], anchor: 'min' });
  doc = run(box.doc, 'create_material', { name: 'al', density: 0.0027, color: '#b0b0b0', metalness: 1, roughness: 0.3 }).doc;
  doc = run(doc, 'assign_material', { materialName: 'al', entityIds: [box.id] }).doc;
  const structural = run(doc, 'create_analysis', { name: 'Bracket static', analysisType: 'static' });
  doc = run(structural.doc, 'set_part_idealization', { analysisId: structural.id, entityId: box.id }).doc;
  const target = (point: number[]): Record<string, unknown> => ({ entityId: box.id, facesNear: [point] });
  doc = run(doc, 'add_fea_constraint', { analysisId: structural.id, name: 'Root fixed', kind: 'fixed', target: target([0, 10, 5]) }).doc;
  doc = run(doc, 'add_fea_load', {
    analysisId: structural.id,
    name: 'Tip load',
    kind: 'force',
    loadCase: 'LC1',
    target: target([100, 10, 5]),
    vector: [0, 0, -500],
  }).doc;
  doc = run(doc, 'add_fea_load', {
    analysisId: structural.id,
    name: 'Crash',
    kind: 'force',
    loadCase: 'LC2',
    category: 'ultimate',
    target: target([100, 10, 5]),
    vector: [900, 0, 0],
  }).doc;
  const thermal = run(doc, 'create_analysis', { name: 'Bracket heat', analysisType: 'heat_steady' });
  doc = run(thermal.doc, 'set_part_idealization', { analysisId: thermal.id, entityId: box.id }).doc;
  doc = run(doc, 'add_thermal_bc', {
    analysisId: thermal.id,
    name: 'Root at 20 C',
    kind: 'temperature',
    value: 20,
    unit: 'degC',
    target: target([0, 10, 5]),
  }).doc;
  useStore.getState().hydrateLiveDocument(liveSnapshot(doc));
  return { staticId: structural.id, thermalId: thermal.id };
}

/** Replaces one case with recorded summaries, as record_fe_mesh / record_fea_results would leave it. */
function withResults(analysisId: string, patch: Partial<AnalysisCase>): void {
  const doc = useStore.getState().document;
  const analysis = doc.analysis;
  const current = analysis?.cases[analysisId];
  if (analysis === undefined || current === undefined) throw new Error('no case');
  act(() =>
    useStore.setState({
      document: { ...doc, analysis: { ...analysis, cases: { ...analysis.cases, [analysisId]: { ...current, ...patch } } } },
    }),
  );
}

beforeEach(() => resetStore());

describe('AnalysisPanel', () => {
  it('explains how to start when the document has no case', () => {
    render(<AnalysisPanel />);
    expect(screen.getByText('No analysis case yet.')).toBeInTheDocument();
    expect(useAnalysisViewStore.getState().focusedAnalysisId).toBeNull();
  });

  it('lists the cases and shows the set-up of the focused one, grouped by load case', () => {
    const { staticId, thermalId } = loadCases();
    render(<AnalysisPanel />);
    expect(screen.getByTestId(`analysis-case-${staticId}`)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId(`analysis-case-${thermalId}`)).toHaveTextContent('Steady thermal');
    const setup = screen.getByTestId('analysis-setup');
    expect(setup).toHaveTextContent('Root fixed');
    expect(setup).toHaveTextContent('Load case LC1');
    expect(setup).toHaveTextContent('Load case LC2');
    expect(setup).toHaveTextContent('500 N along −Z');
    expect(setup).toHaveTextContent('900 N along +X');
    expect(screen.getByTestId('analysis-factors')).toHaveTextContent('ultimate 1.5 · yield 1');
    expect(useAnalysisViewStore.getState().focusedAnalysisId).toBe(staticId);
  });

  it('focuses another case for the viewport and clears the focus when closed', () => {
    const { thermalId } = loadCases();
    const { unmount } = render(<AnalysisPanel />);
    fireEvent.click(screen.getByTestId(`analysis-case-${thermalId}`));
    expect(useAnalysisViewStore.getState().focusedAnalysisId).toBe(thermalId);
    expect(screen.getByTestId('analysis-setup')).toHaveTextContent('Root at 20 C');
    unmount();
    expect(useAnalysisViewStore.getState().focusedAnalysisId).toBeNull();
  });

  it('checks readiness offline and says meshing needs the server', async () => {
    const { staticId } = loadCases();
    render(<AnalysisPanel />);
    expect(screen.getByTestId('analysis-mesh-solve')).toBeDisabled();
    expect(screen.getByTestId('analysis-offline-hint')).toHaveTextContent(`llull fea_mesh analysisId=${staticId}`);
    fireEvent.click(screen.getByTestId('analysis-check'));
    await waitFor(() => expect(screen.getByTestId('analysis-check-overall')).toHaveTextContent('unmeshed'));
    expect(screen.getByTestId('analysis-solve')).toHaveTextContent('FEA_MESH_MISSING');
  });

  it('shows the recorded mesh and results of a solved case per load case', () => {
    const { staticId } = loadCases();
    render(<AnalysisPanel />);
    withResults(staticId, {
      meshSummary: {
        meshHash: 'm',
        inputHash: 'i',
        mesher: 'gmsh',
        mesherVersion: '4.15.2',
        nodes: 4200,
        elements: { C3D10: 2100 },
        quality: { metrics: {}, inverted: 0 },
        warnings: [],
        faceMap: [],
      },
      results: {
        resultsHash: 'r',
        inputHash: 'i',
        solver: 'calculix',
        solverVersion: '2.21',
        units: 'N-mm-t-s',
        loadCases: [
          {
            name: 'LC1',
            category: 'limit',
            maxVonMises: { value: 123.4, at: [0, 0, 0], entityId: 'x' },
            maxDisplacement: { value: 0.25, at: [0, 0, 0] },
          },
        ],
      },
    });
    expect(screen.getByTestId(`analysis-case-${staticId}`)).toHaveTextContent('Solved');
    expect(screen.getByTestId('analysis-mesh-summary')).toHaveTextContent('4,200 nodes · 2,100 C3D10 · 0 inverted');
    const row = within(screen.getByTestId('analysis-results-table')).getByText('LC1').closest('tr');
    expect(row).toHaveTextContent('123 MPa');
    expect(row).toHaveTextContent('0.25 mm');
    fireEvent.click(screen.getByTestId('analysis-margins-run'));
    expect(screen.getByTestId('analysis-margins')).toBeInTheDocument();
  });
});
