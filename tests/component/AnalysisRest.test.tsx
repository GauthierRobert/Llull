import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import { useStore, useLayoutStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { AnalysisPanel } from '@ui/panels/analysis/AnalysisPanel';
import { useAnalysisViewStore } from '@ui/panels/analysis/analysisViewStore';
import { localDispatch } from '../helpers/storeTestHelpers';

type Patch = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  state: null as string | null,
  casePatch: {} as Record<string, unknown>,
  idealization: null as Record<string, unknown> | null,
  margins: null as null | { isError: boolean; summary: string; data: unknown },
}));

const loadCases = [
  {
    name: 'LC1',
    category: 'limit',
    maxVonMises: { value: 250, at: [0, 0, 0], entityId: 'x' },
    maxDisplacement: { value: 0.125, at: [0, 0, 0] },
  },
];

vi.mock('@ui/services/localQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/services/localQuery')>();
  return {
    ...actual,
    runQuery: (command: string, params: Record<string, unknown> = {}): ReturnType<typeof actual.runQuery> => {
      if (command === 'compute_margins' && mocks.margins !== null) {
        const { summary, data, isError } = mocks.margins;
        return { document: useStore.getState().document, summary, affected: [], data, ...(isError ? { rejected: true } : {}) };
      }
      if (command === 'describe_analysis' && mocks.state !== null) {
        const real = actual.runQuery(command, params);
        const data = real.data as { analyses?: Patch[]; case?: { parts: Record<string, unknown> } };
        if (params['analysisId'] === undefined)
          return { ...real, data: { ...data, analyses: (data.analyses ?? []).map((entry) => ({ ...entry, state: mocks.state })) } };
        const parts = Object.fromEntries(Object.keys(data.case?.parts ?? {}).map((id) => [id, mocks.idealization ?? { kind: 'solid' }]));
        return { ...real, data: { ...data, state: mocks.state, case: { ...data.case, parts, ...mocks.casePatch } } };
      }
      return actual.runQuery(command, params);
    },
  };
});

const originalDispatch = useStore.getState().dispatch;
let dispatched: Array<{ name: string; params: Record<string, unknown> }> = [];

function seedAnalysis(): string {
  const box = localDispatch('add_box', { size: [10, 20, 30] }).affected[0]!;
  const created = localDispatch('create_analysis', { name: 'Bracket under load', analysisType: 'static' }).affected[0]!;
  localDispatch('set_part_idealization', { analysisId: created, entityId: box });
  localDispatch('add_fea_constraint', {
    analysisId: created,
    name: 'base',
    kind: 'fixed',
    target: { entityId: box, facesNear: [[5, 10, 0]] },
  });
  localDispatch('add_fea_load', {
    analysisId: created,
    name: 'tip',
    kind: 'force',
    loadCase: 'LC1',
    vector: [0, 0, -500],
    target: { entityId: box, facesNear: [[5, 10, 30]] },
  });
  return created;
}

const solvedStatic = (extra: Patch = {}): void => {
  mocks.state = 'solved';
  mocks.casePatch = { type: 'static', results: { loadCases, units: 'N-mm-t-s' }, ...extra };
};

const marginRow = (extra: Patch): Patch => ({
  rowId: 'r1',
  part: 'wing_skin',
  region: 'part',
  loadCase: 'LC1',
  check: 'ultimate',
  criterion: 'von_mises',
  appliedMPa: 120,
  allowableMPa: 310,
  ms: 0.72,
  status: 'PASS',
  statusLabel: 'PASS',
  disposition: 'none',
  singular: false,
  ...extra,
});

describe('AnalysisPanel FEA-REST UI', () => {
  beforeEach(() => {
    cleanup();
    mocks.state = null;
    mocks.casePatch = {};
    mocks.idealization = null;
    mocks.margins = null;
    dispatched = [];
    useStore.setState({
      dispatch: (name, params) => {
        dispatched.push({ name, params: (params ?? {}) as Record<string, unknown> });
        localDispatch(name, params);
      },
    });
    useStore.getState().setDocument(createEmptyDocument());
    useAnalysisViewStore.getState().setActive(null);
    useLayoutStore.setState({ sidebarTab: 'objects', sidebarOpen: true, pinnedTabs: [] });
  });

  afterEach(() => useStore.setState({ dispatch: originalDispatch }));

  it('shows "not meshed" for an unmeshed case', () => {
    seedAnalysis();
    render(<AnalysisPanel />);
    expect(screen.getByTestId('analysis-state-badge').textContent).toBe('not meshed');
  });

  it.each([
    ['stale', /Inputs changed/],
    ['untrusted', /summary differs from its artifact/],
    ['missing', /artifact is not on this machine/],
  ])('marks a %s case with warning styling and a one-line meaning', (state, meaning) => {
    seedAnalysis();
    mocks.state = state;
    render(<AnalysisPanel />);
    const badge = screen.getByTestId('analysis-state-badge');
    expect(badge.textContent).toBe(state);
    expect(badge.className).toContain('analysis__state-badge--warning');
    expect(screen.getByTestId('analysis-state-meaning').textContent).toMatch(meaning);
    expect(screen.getAllByTestId(/^analysis-state-/).some((el) => el.getAttribute('data-state') === state)).toBe(true);
  });

  it('describes a shell with thickness, offset and laminate, and mesh controls with bonding', () => {
    seedAnalysis();
    mocks.state = 'meshed';
    mocks.idealization = {
      kind: 'shell',
      thickness: 2,
      offset: 'top',
      midsurface: { maxThickness: 5, angularTolDeg: 5 },
      laminate: { compositePartId: 'layup_1' },
    };
    mocks.casePatch = {
      mesh: {
        mesher: 'gmsh',
        elementFamily: 'shell_quad',
        order: 2,
        globalSize: 4,
        refinements: [],
        optimize: 'default',
        bonding: 'conformal',
      },
    };
    render(<AnalysisPanel />);
    const parts = screen.getByLabelText('Parts');
    expect(parts.textContent).toContain('shell · thickness 2 mm · offset top · laminate layup_1');
    expect(screen.getByText(/shell_quad · order 2 · size 4 · bonding conformal/)).toBeTruthy();
  });

  it('describes a plane stress part with its thickness', () => {
    seedAnalysis();
    mocks.state = 'meshed';
    mocks.idealization = { kind: 'plane_stress', thickness: 1.5, sourceFacesNear: [] };
    render(<AnalysisPanel />);
    expect(screen.getByLabelText('Parts').textContent).toContain('plane stress · thickness 1.5 mm');
  });

  it('summarises the peaks per load case of a solved case', () => {
    seedAnalysis();
    solvedStatic();
    mocks.margins = { isError: true, summary: 'x', data: null };
    render(<AnalysisPanel />);
    const summary = screen.getByTestId('analysis-result-summary');
    expect(summary.textContent).toContain('LC1');
    expect(summary.textContent).toContain('max von Mises 250 MPa');
    expect(summary.textContent).toContain('max displacement 0.125');
  });

  it('renders the margins table with an accepted FAIL, a pending row and a singular row apart', () => {
    seedAnalysis();
    solvedStatic();
    mocks.margins = {
      isError: false,
      summary: 'compute_margins: ok',
      data: {
        minMs: -0.12,
        reviewRequired: true,
        warnings: ['FEA_MARGINAL_BAND_UNSET: no marginalBand given, so no row is MARGINAL'],
        rows: [
          marginRow({ rowId: 'r1' }),
          marginRow({ rowId: 'r2', ms: -0.12, status: 'FAIL', statusLabel: 'FAIL (accepted)', disposition: 'accepted', fibre: 'bottom' }),
          marginRow({
            rowId: 'r3',
            ms: -0.3,
            status: 'FAIL',
            statusLabel: 'FAIL (pending human disposition)',
            disposition: 'pending_human',
          }),
          marginRow({
            rowId: 'r4',
            part: 'bracket',
            singular: true,
            appliedMPa: 900,
            ms: -0.6,
            status: 'FAIL',
            statusLabel: 'FAIL',
            disposition: 'pending_human',
          }),
        ],
      },
    };
    render(<AnalysisPanel />);
    expect(screen.getByTestId('analysis-margins-min').textContent).toBe('Min MS -0.12');
    expect(screen.getByTestId('analysis-margins-review').textContent).toContain('not approved');
    expect(screen.getByTestId('analysis-margins-warnings').textContent).toContain('FEA_MARGINAL_BAND_UNSET');
    const first = screen.getByTestId('analysis-margin-r1');
    expect(first.textContent).toContain('120 MPa');
    expect(first.textContent).toContain('310 MPa');
    expect(first.textContent).toContain('0.72');
    const accepted = screen.getByTestId('analysis-margin-r2');
    expect(accepted.textContent).toContain('FAIL (accepted)');
    expect(accepted.textContent).toContain('bottom fibre');
    expect(accepted.textContent).toContain('accepted');
    expect(screen.getByTestId('analysis-margin-r3').textContent).toContain('pending human review');
    const singular = screen.getByTestId('analysis-margins-singular');
    expect(within(singular).getByTestId('analysis-margin-r4')).toBeTruthy();
    expect(singular.textContent).toContain('Singular zones');
    expect(within(screen.getByTestId('analysis-margins-table')).getByTestId('analysis-margin-r1').closest('tbody')).not.toBe(singular);
    expect(singular.textContent).not.toContain('re-entrant');
  });

  it('reads the singularity screening object and warns when only a singular row fails', () => {
    seedAnalysis();
    solvedStatic();
    mocks.margins = {
      isError: false,
      summary: 'compute_margins: ok',
      data: {
        minMs: 0.4,
        reviewRequired: true,
        warnings: [],
        singularScreening: { radius: { value: 0.2, unit: 'mm', defaulted: true }, excludedNodes: 3 },
        rows: [marginRow({ rowId: 'r1' }), marginRow({ rowId: 'r2', singular: true, ms: -0.5, status: 'FAIL', statusLabel: 'FAIL' })],
      },
    };
    render(<AnalysisPanel />);
    expect(screen.getByTestId('analysis-margins-min').className).toContain('panel__status--warn');
    const screening = screen.getByTestId('analysis-margins-screening').textContent ?? '';
    expect(screening).toContain('radius 0.2 mm (llull default), 3 node(s) excluded');
    expect(screening).toContain('Re-entrant corners are not screened');
  });

  it('shows the refusal of compute_margins', () => {
    seedAnalysis();
    solvedStatic();
    mocks.margins = { isError: true, summary: 'compute_margins rejected: FEA_MATERIAL_NO_ALLOWABLE: part has no material', data: null };
    render(<AnalysisPanel />);
    expect(screen.getByTestId('analysis-margins-refused').textContent).toContain('FEA_MATERIAL_NO_ALLOWABLE');
    expect(screen.queryByTestId('analysis-margins-table')).toBeNull();
  });

  it('records the result view on the case when the field and the load case change', () => {
    const id = seedAnalysis();
    render(<AnalysisPanel />);
    fireEvent.change(screen.getByTestId('analysis-field'), { target: { value: 'u_mag' } });
    expect(dispatched.at(-1)).toEqual({ name: 'set_result_view', params: { analysisId: id, field: 'u_mag' } });
    expect(useAnalysisViewStore.getState().field).toBe('u_mag');
    fireEvent.change(screen.getByTestId('analysis-scale'), { target: { value: '5' } });
    fireEvent.blur(screen.getByTestId('analysis-scale'));
    expect(dispatched.at(-1)?.params).toEqual({ analysisId: id, field: 'u_mag', deformationScale: 5 });
    expect(useStore.getState().document.analysis?.cases[id]?.view).toMatchObject({ field: 'u_mag', deformationScale: 5 });
  });

  it('initialises the selector from the recorded view', () => {
    const id = seedAnalysis();
    localDispatch('set_result_view', { analysisId: id, field: 's_xx', loadCase: 'LC1', deformationScale: 3 });
    dispatched = [];
    render(<AnalysisPanel />);
    expect((screen.getByTestId('analysis-field') as HTMLSelectElement).value).toBe('s_xx');
    expect((screen.getByTestId('analysis-scale') as HTMLInputElement).value).toBe('3');
    expect(dispatched.filter((call) => call.name === 'set_result_view')).toHaveLength(0);
  });

  it('sets the margin band through set_margin_band and clears it when empty', () => {
    const id = seedAnalysis();
    render(<AnalysisPanel />);
    fireEvent.change(screen.getByTestId('analysis-margin-band'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByTestId('analysis-set-margin-band'));
    expect(dispatched.at(-1)).toEqual({ name: 'set_margin_band', params: { analysisId: id, marginalBand: 0.1 } });
    expect(useStore.getState().document.analysis?.cases[id]?.marginalBand).toBe(0.1);
    fireEvent.change(screen.getByTestId('analysis-margin-band'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('analysis-set-margin-band'));
    expect(dispatched.at(-1)).toEqual({ name: 'set_margin_band', params: { analysisId: id } });
    fireEvent.change(screen.getByTestId('analysis-margin-band'), { target: { value: '-1' } });
    expect((screen.getByTestId('analysis-set-margin-band') as HTMLButtonElement).disabled).toBe(true);
  });

  it('deletes the analysis only after the confirm step', () => {
    const id = seedAnalysis();
    render(<AnalysisPanel />);
    fireEvent.click(screen.getByTestId('analysis-delete'));
    expect(dispatched.some((call) => call.name === 'delete_analysis')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(dispatched.at(-1)).toEqual({ name: 'delete_analysis', params: { analysisId: id } });
    expect(useStore.getState().document.analysis?.cases[id]).toBeUndefined();
  });

  it('offers the disposition only as a disabled, explained control', () => {
    seedAnalysis();
    render(<AnalysisPanel />);
    const button = screen.getByTestId('analysis-disposition') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('signature');
    fireEvent.click(button);
    expect(dispatched.some((call) => call.name === 'dispose_margin')).toBe(false);
  });
});
