import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useFlowViewStore } from '@ui/store/flowViewStore';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { FlowPanel } from '@ui/panels/flow/FlowPanel';
import { CfdLegend } from '@ui/viewport/3d/cfd/CfdLegend';
import { recordedGridStudy } from '../unit/aero/cfd/studyFixtures';
import { sliceBytes, streamlinesBytes } from '../helpers/cfdFiles';

const mocks = vi.hoisted(() => ({ report: null as Record<string, unknown> | null, post: vi.fn(), fetch: vi.fn() }));

vi.mock('@ui/store/serverCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ui/store/serverCommands')>()),
  postExchange: mocks.post,
  postCommand: (name: string) => Promise.resolve({ summary: `${name}: ok`, affected: [], isError: false, data: mocks.report }),
}));

vi.mock('@ui/services/localQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/services/localQuery')>();
  return {
    ...actual,
    runQuery: (command: string, params: Record<string, unknown> = {}): ReturnType<typeof actual.runQuery> =>
      command === 'cfd_report' && mocks.report !== null
        ? { document: useStore.getState().document, summary: 'cfd_report: ok', affected: [], data: mocks.report }
        : actual.runQuery(command, params),
  };
});

const REPORT = {
  stale: false,
  staleReasons: [],
  trusted: true,
  warnings: [],
  convergence: {
    converged: true,
    steps: 1200,
    averagedSteps: 400,
    history: [
      { step: 100, cd: 0.9 },
      { step: 200, cd: 0.7 },
      { step: 300, cd: 0.65 },
    ],
    warnings: [],
  },
};

let dispatch = vi.fn();
let recorded: CadDocument;

function load(patch: (doc: CadDocument) => CadDocument = (doc) => doc): void {
  useStore.getState().setDocument(patch(recorded));
}

const withStudy =
  (patch: Record<string, unknown>) =>
  (doc: CadDocument): CadDocument => {
    const study = doc.cfd?.studies?.['c1'];
    if (doc.cfd === undefined || study === undefined) throw new Error('fixture has no study');
    return { ...doc, cfd: { ...doc.cfd, studies: { c1: { ...study, ...patch } } } };
  };

beforeEach(() => {
  cleanup();
  mocks.report = null;
  mocks.post.mockReset();
  mocks.fetch.mockReset();
  vi.stubGlobal('fetch', mocks.fetch);
  useFlowViewStore.setState(useFlowViewStore.getInitialState(), true);
  dispatch = vi.fn();
  recorded = recordedGridStudy().doc;
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({ dispatch, liveStatus: 'disconnected' });
});

describe('FlowPanel cases', () => {
  it('lists the cases with their state and deletes through a command', () => {
    load();
    render(<FlowPanel />);
    expect(screen.getByTestId('flow-case-c1').textContent).toContain('c1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete flow case c1' }));
    expect(dispatch).toHaveBeenCalledWith('delete_cfd_case', { caseId: 'c1' });
  });

  it('gathers a new case from the selection and dispatches create_cfd_case', () => {
    const body = Object.keys(recorded.entities)[0] as string;
    useStore.getState().setDocument({ ...createEmptyDocument(), entities: recorded.entities, order: recorded.order, selection: [body] });
    render(<FlowPanel />);
    fireEvent.click(screen.getByText('New case'));
    const create = screen.getByTestId('flow-create') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByTestId('flow-create-problem').textContent).toContain('Reference area');
    fireEvent.change(screen.getByTestId('flow-speed'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('flow-alpha'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('flow-area'), { target: { value: '0.8' } });
    fireEvent.change(screen.getByTestId('flow-length'), { target: { value: '1.2' } });
    fireEvent.change(screen.getByTestId('flow-cells'), { target: { value: '48' } });
    fireEvent.change(screen.getByTestId('flow-case-id'), { target: { value: 'wing' } });
    fireEvent.click(create);
    expect(dispatch).toHaveBeenCalledWith('create_cfd_case', {
      id: 'wing',
      entityIds: [body],
      freestream: { speedMS: 40, altitudeM: 0, alphaDeg: 3 },
      reference: { areaM2: 0.8, lengthM: 1.2 },
      cellsPerReferenceLength: 48,
    });
  });

  it('asks for a selection before a case can be created', () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByText('New case'));
    expect(screen.getByTestId('flow-create-problem').textContent).toContain('Select the solids');
  });
});

describe('FlowPanel solve and stop', () => {
  it('disables the solve with a reason while offline', () => {
    load();
    render(<FlowPanel />);
    expect((screen.getByTestId('flow-solve') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('flow-solve-reason').textContent).toContain('backend');
  });

  it('runs cfd_solve with the grid study and device, and stops it with cfd_stop', async () => {
    load();
    useStore.setState({ liveStatus: 'connected' });
    let finish: (value: unknown) => void = () => undefined;
    mocks.post.mockImplementation((name: string) =>
      name === 'cfd_solve'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ summary: 'cfd_stop c1: stopped 1 run', affected: [], isError: false }),
    );
    render(<FlowPanel />);
    fireEvent.click(screen.getByTestId('flow-grid-study'));
    fireEvent.change(screen.getByTestId('flow-device'), { target: { value: 'auto' } });
    fireEvent.click(screen.getByTestId('flow-solve'));
    expect(mocks.post).toHaveBeenCalledWith('cfd_solve', { caseId: 'c1', gridStudy: true });
    expect(screen.getByTestId('flow-progress').textContent).toContain('three grids');
    fireEvent.click(screen.getByTestId('flow-stop'));
    expect(mocks.post).toHaveBeenCalledWith('cfd_stop', { caseId: 'c1' });
    await waitFor(() => expect(screen.getByTestId('flow-stop-note').textContent).toContain('stopped 1 run'));
    await act(async () => {
      finish({ summary: 'cfd_solve c1: stopped', affected: [], isError: true, error: { code: 'CFD_CANCELLED', remediation: '' } });
    });
    expect(screen.getByTestId('flow-solve-summary').textContent).toContain('stopped');
    expect((screen.getByTestId('flow-solve') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the failure code and remediation of a refused solve', async () => {
    load();
    useStore.setState({ liveStatus: 'connected' });
    mocks.post.mockResolvedValue({
      summary: 'cfd_solve c1: not watertight',
      affected: [],
      isError: true,
      error: { code: 'CFD_GEOMETRY_NOT_WATERTIGHT', remediation: 'close the body' },
    });
    render(<FlowPanel />);
    fireEvent.click(screen.getByTestId('flow-solve'));
    await waitFor(() => expect(screen.getByTestId('flow-solve-summary').textContent).toContain('not watertight'));
    expect(screen.getByText(/CFD_GEOMETRY_NOT_WATERTIGHT close the body/)).toBeTruthy();
  });
});

describe('FlowPanel result', () => {
  it('shows the coefficients, convergence, the drag history and the current badge', async () => {
    load();
    mocks.report = REPORT;
    render(<FlowPanel />);
    await waitFor(() => expect(screen.getByTestId('flow-state').textContent).toBe('Current'));
    expect(screen.getByTestId('kpi-cd').textContent).toContain('Cd');
    expect(screen.getByTestId('flow-convergence').textContent).toContain('Converged after 1200 steps');
    expect(screen.getByTestId('flow-history')).toBeTruthy();
    expect(screen.queryByTestId('flow-stale')).toBeNull();
  });

  it('flags a stale result with its reasons and keeps the numbers', async () => {
    load();
    mocks.report = {
      ...REPORT,
      stale: true,
      staleReasons: ['the case changed since the solve'],
      warnings: [{ code: 'CFD_RESULT_STALE', message: 'the case changed', remediation: 'solve again' }],
    };
    render(<FlowPanel />);
    await waitFor(() => expect(screen.getByTestId('flow-stale').textContent).toContain('the case changed since the solve'));
    expect(screen.getByTestId('flow-state').textContent).toBe('Stale');
    expect(screen.getByTestId('flow-warnings').textContent).toContain('CFD_RESULT_STALE');
    expect(screen.getByTestId('kpi-cd')).toBeTruthy();
  });

  it('flags a result whose bundle is not in this store as unverified', async () => {
    load();
    mocks.report = { ...REPORT, trusted: false };
    render(<FlowPanel />);
    await waitFor(() => expect(screen.getByTestId('flow-unverified')).toBeTruthy());
    expect(screen.getByTestId('flow-state').textContent).toBe('Unverified');
  });

  it('says a case with no result is not solved and blocks the overlay queries', () => {
    load((doc) => (doc.cfd === undefined ? doc : { ...doc, cfd: { cases: doc.cfd.cases, results: {} } }));
    render(<FlowPanel />);
    expect(screen.getByTestId('flow-case-c1').textContent).toContain('Not solved');
    expect(screen.queryByTestId('flow-result')).toBeNull();
    expect(screen.getByTestId('flow-layers-reason').textContent).toContain('Solve the case first');
    expect((screen.getByTestId('flow-slice-run') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('FlowPanel grid study', () => {
  it('shows the levels, observed order, GCI and the verified badge', () => {
    load();
    render(<FlowPanel />);
    expect(screen.getByTestId('flow-study-badge').textContent).toBe('Verified');
    expect(screen.getByTestId('flow-study-levels').querySelectorAll('tbody tr')).toHaveLength(3);
    expect(Number(screen.getByTestId('flow-study-order').textContent)).toBeCloseTo(2, 1);
    expect(screen.getByTestId('flow-study-verdict').textContent).toMatch(/Fine-grid GCI of Cd: .* %/);
    expect(screen.queryByTestId('flow-study-stale')).toBeNull();
  });

  it('marks an unverified (replayed) study', () => {
    load(withStudy({ verified: false }));
    render(<FlowPanel />);
    expect(screen.getByTestId('flow-study-badge').textContent).toBe('Unverified');
    expect(screen.getByTestId('flow-study').textContent).toContain('no number is trusted');
  });

  it('notes a stale study when the result is stale', async () => {
    load();
    mocks.report = { ...REPORT, stale: true, staleReasons: ['the case changed since the solve'] };
    render(<FlowPanel />);
    await waitFor(() => expect(screen.getByTestId('flow-study-stale').textContent).toContain('Stale'));
  });

  it('notes a study whose case hash differs from the recorded result', () => {
    load(withStudy({ caseHash: 'f'.repeat(64) }));
    render(<FlowPanel />);
    expect(screen.getByTestId('flow-study-stale')).toBeTruthy();
  });

  it('reports a non-monotone study with no GCI', () => {
    load(
      withStudy({
        status: 'oscillatory',
        orderP: undefined,
        extrapolated: undefined,
        gci21Fine: undefined,
        gci32Fine: undefined,
        asymptoticRatio: undefined,
      }),
    );
    render(<FlowPanel />);
    expect(screen.getByTestId('flow-study-verdict').textContent).toContain('Non-monotone');
    expect(screen.getByTestId('flow-study-verdict').textContent).toContain('no GCI');
    expect(screen.queryByTestId('flow-study-order')).toBeNull();
  });

  it('prints the absolute GCI when the fine value is zero and flags unconverged levels', () => {
    const study = recorded.cfd?.studies?.['c1'];
    load(
      withStudy({
        gci21Fine: undefined,
        relativeUndefined: true,
        gciAbs: 0.0123,
        levels: study?.levels.map((level, index) => ({ ...level, converged: index !== 0 })),
      }),
    );
    render(<FlowPanel />);
    expect(screen.getByTestId('flow-study-verdict').textContent).toContain('absolute GCI 0.0123');
    expect(screen.getByTestId('flow-study-unconverged')).toBeTruthy();
  });
});

describe('FlowPanel overlay layers', () => {
  const SHA = 'b'.repeat(64);
  const serve = (bytes: Uint8Array): void => {
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) });
  };

  it('queries a slice plane through the transport and publishes the decoded file for the overlay', async () => {
    load();
    mocks.report = REPORT;
    useStore.setState({ liveStatus: 'connected' });
    mocks.post.mockResolvedValue({
      summary: 'cfd_slice c1: speed',
      affected: [],
      isError: false,
      data: { file: { sha256: SHA, bytes: 1 } },
    });
    serve(sliceBytes(3, [1, 2, 3, 4, NaN, 6, 7, 8, 9], 'speed'));
    render(<FlowPanel />);
    await waitFor(() => expect((screen.getByTestId('flow-slice-run') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByTestId('flow-slice-axis'), { target: { value: 'z' } });
    fireEvent.change(screen.getByTestId('flow-slice-position'), { target: { value: '0.25' } });
    fireEvent.change(screen.getByTestId('flow-slice-field'), { target: { value: 'cp' } });
    fireEvent.click(screen.getByTestId('flow-slice-run'));
    expect(mocks.post).toHaveBeenCalledWith('cfd_slice', { caseId: 'c1', origin: [0, 0, 0.25], normal: [0, 0, 1], field: 'cp' });
    await waitFor(() => expect(useFlowViewStore.getState().slice.status).toBe('ready'));
    expect(mocks.fetch.mock.calls[0]?.[0]).toContain(`/cfd/file/${SHA}`);
  });

  it('traces streamlines from a rake upstream of the body', async () => {
    load();
    mocks.report = REPORT;
    useStore.setState({ liveStatus: 'connected' });
    mocks.post.mockResolvedValue({
      summary: 'cfd_streamlines c1: 2 lines',
      affected: [],
      isError: false,
      data: { file: { sha256: SHA, bytes: 1 } },
    });
    serve(streamlinesBytes());
    render(<FlowPanel />);
    await waitFor(() => expect((screen.getByTestId('flow-streamlines-run') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('flow-streamlines-run'));
    const [tool, params] = mocks.post.mock.calls[0] as [string, { caseId: string; rake: { kind: string; nu: number; nv: number } }];
    expect(tool).toBe('cfd_streamlines');
    expect(params.caseId).toBe('c1');
    expect(params.rake).toMatchObject({ kind: 'plane', nu: 8, nv: 8 });
    await waitFor(() => expect(screen.getByTestId('flow-streamlines-summary').textContent).toContain('2 lines'));
  });

  it('says why nothing is drawn when the backend cannot serve the file', async () => {
    load();
    mocks.report = REPORT;
    useStore.setState({ liveStatus: 'connected' });
    mocks.post.mockResolvedValue({
      summary: 'cfd_slice c1: speed',
      affected: [],
      isError: false,
      data: { file: { sha256: SHA, bytes: 1 } },
    });
    mocks.fetch.mockResolvedValue({ ok: false, status: 404 });
    render(<FlowPanel />);
    await waitFor(() => expect((screen.getByTestId('flow-slice-run') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('flow-slice-run'));
    await waitFor(() => expect(screen.getByTestId('flow-slice-refused').textContent).toContain('HTTP 404'));
  });

  it('shows the refusal of a stale query and clears the overlay when the panel closes', async () => {
    load();
    mocks.report = { ...REPORT, stale: true, staleReasons: ['the case changed since the solve'] };
    useStore.setState({ liveStatus: 'connected' });
    const view = render(<FlowPanel />);
    await waitFor(() => expect(screen.getByTestId('flow-layers-reason').textContent).toContain('stale'));
    expect(useFlowViewStore.getState().caseId).toBe('c1');
    view.unmount();
    expect(useFlowViewStore.getState().caseId).toBeNull();
  });
});

describe('CfdLegend', () => {
  it('prints the field, unit and range of the slice and the speed range of the streamlines', () => {
    useFlowViewStore.setState({
      caseId: 'c1',
      slice: {
        status: 'ready',
        value: {
          caseId: 'c1',
          file: {
            samples: 2,
            origin: [0, 0, 0],
            axisU: [1, 0, 0],
            axisV: [0, 1, 0],
            spacingM: 1,
            field: 'p',
            values: new Float32Array([-250, 0, 1500, 0]),
            range: { min: -250, max: 1500 },
          },
        },
      },
      streamlines: {
        status: 'ready',
        value: {
          caseId: 'c1',
          summary: 's',
          file: {
            lineCount: 1,
            pointCount: 2,
            offsets: new Uint32Array([0, 2]),
            positions: new Float32Array(6),
            speeds: new Float32Array([5, 30]),
            range: { min: 5, max: 30 },
          },
        },
      },
    });
    render(<CfdLegend />);
    const legend = screen.getByTestId('cfd-legend');
    expect(legend.textContent).toContain('Slice: Gauge pressure');
    expect(legend.textContent).toContain('kPa');
    expect(legend.textContent).toContain('Streamlines: speed');
    expect(legend.textContent).toContain('m/s');
  });

  it('says a patch with no fluid has no values, and draws nothing without a layer', () => {
    const empty = render(<CfdLegend />);
    expect(empty.container.textContent).toBe('');
    cleanup();
    useFlowViewStore.setState({
      caseId: 'c1',
      slice: {
        status: 'ready',
        value: {
          caseId: 'c1',
          file: {
            samples: 2,
            origin: [0, 0, 0],
            axisU: [1, 0, 0],
            axisV: [0, 1, 0],
            spacingM: 1,
            field: 'speed',
            values: new Float32Array(4).fill(NaN),
            range: null,
          },
        },
      },
    });
    render(<CfdLegend />);
    expect(screen.getByTestId('cfd-legend').textContent).toContain('no values in the fluid');
  });
});
