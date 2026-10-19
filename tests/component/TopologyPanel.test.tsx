import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { TopologyPanel } from '@ui/panels/analysis/TopologyPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

const mocks = vi.hoisted(() => ({
  report: null as Record<string, unknown> | null,
  check: null as Record<string, unknown> | null,
  rebuild: null as Record<string, unknown> | null,
  post: vi.fn(),
}));

vi.mock('@ui/store/serverCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ui/store/serverCommands')>()),
  postCommand: mocks.post,
}));

vi.mock('@ui/services/localQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/services/localQuery')>();
  return {
    ...actual,
    runQuery: (command: string, params: Record<string, unknown> = {}): ReturnType<typeof actual.runQuery> => {
      const data = { topology_report: mocks.report, check_topology: mocks.check, suggest_rebuild: mocks.rebuild }[command];
      if (data === undefined || data === null) return actual.runQuery(command, params);
      return { document: useStore.getState().document, summary: `${command}: ok`, affected: [], data };
    },
  };
});

const history = [1, 2, 3, 4].map((it) => ({ it, compliance: 10 / it, volume: 0.9 - it * 0.1, change: 0.1 }));
const SOLVED = {
  state: 'solved',
  problem: null,
  concept: true,
  unverified: true,
  unverifiedReasons: ['material yield not verified'],
  result: { compliance: 2.5, complianceUnit: 'N*mm', iterations: 4, status: 'converged', volumeFraction: 0.5, grey: 0.04, history },
};

function seed(): { analysisId: string; studyId: string; boxId: string } {
  const boxId = localDispatch('add_box', { size: [10, 20, 30] }).affected[0]!;
  const analysisId = localDispatch('create_analysis', { name: 'Bracket', analysisType: 'static' }).affected[0]!;
  localDispatch('set_part_idealization', { analysisId, entityId: boxId });
  const created = localDispatch('create_topology_study', {
    analysisId,
    name: 'Lighter',
    designDomain: [boxId],
    dimension: 3,
    voxel: 5,
    volumeFraction: 0.6,
  });
  return { analysisId, studyId: created.affected[0]!, boxId };
}

let dispatch = vi.fn();

beforeEach(() => {
  cleanup();
  mocks.report = null;
  mocks.check = null;
  mocks.rebuild = null;
  mocks.post.mockReset();
  dispatch = vi.fn();
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({ dispatch, liveStatus: 'disconnected' });
});

describe('TopologyPanel', () => {
  it('lists the studies of the case and deletes through a command', () => {
    const { analysisId, studyId } = seed();
    render(<TopologyPanel analysisId={analysisId} />);
    expect(screen.getByTestId(`topology-row-${studyId}`).textContent).toContain('Lighter');
    fireEvent.click(screen.getByRole('button', { name: 'Delete topology study Lighter' }));
    expect(dispatch).toHaveBeenCalledWith('delete_topology_study', { studyId });
  });

  it('creates a study from the selection with voxel, fraction and plane', () => {
    const { analysisId, boxId } = seed();
    useStore.getState().select([boxId]);
    render(<TopologyPanel analysisId={analysisId} />);
    const create = screen.getByTestId('topology-create') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('topology-voxel'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByTestId('topology-fraction'), { target: { value: '0.4' } });
    fireEvent.change(screen.getByTestId('topology-dimension'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('topology-plane'), { target: { value: 'XZ' } });
    fireEvent.change(screen.getByTestId('topology-name'), { target: { value: 'Plate' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(dispatch).toHaveBeenCalledWith('create_topology_study', {
      analysisId,
      name: 'Plate',
      designDomain: [boxId],
      dimension: 2,
      plane: 'XZ',
      voxel: 2.5,
      volumeFraction: 0.4,
    });
  });

  it('shows each setting with its source and dispatches only the changes', () => {
    const { analysisId, studyId } = seed();
    render(<TopologyPanel analysisId={analysisId} />);
    expect(screen.getByTestId('topology-source-penal').textContent).toContain('default');
    expect(screen.getByTestId('topology-source-penal').textContent).toContain('Andreassen');
    const apply = screen.getByTestId('topology-apply-settings') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('topology-setting-penal'), { target: { value: '4' } });
    fireEvent.click(apply);
    expect(dispatch).toHaveBeenCalledWith('set_topology_settings', { studyId, penal: 4 });
  });

  it('adds keep-out regions from the selection through set_topology_regions', () => {
    const { analysisId, studyId, boxId } = seed();
    useStore.getState().select([boxId]);
    render(<TopologyPanel analysisId={analysisId} />);
    fireEvent.click(screen.getByText('Regions'));
    fireEvent.click(screen.getByTestId('topology-keepOut-selection'));
    expect(dispatch).toHaveBeenCalledWith('set_topology_regions', { studyId, keepOut: [{ kind: 'entity', entityId: boxId }] });
  });

  it('disables the solve button with a reason while offline', () => {
    const { analysisId } = seed();
    render(<TopologyPanel analysisId={analysisId} />);
    expect((screen.getByTestId('topology-solve') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('topology-solve-reason').textContent).toContain('backend');
  });

  it('solves through topology_solve with progress when online', async () => {
    const { analysisId, studyId } = seed();
    useStore.setState({ liveStatus: 'connected' });
    let finish: (value: unknown) => void = () => undefined;
    mocks.post.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<TopologyPanel analysisId={analysisId} />);
    fireEvent.click(screen.getByTestId('topology-solve'));
    expect(mocks.post).toHaveBeenCalledWith('topology_solve', { studyId });
    expect(screen.getByTestId('topology-progress')).toBeTruthy();
    finish({ summary: 'topology_solve: 40 iterations', isError: false, affected: [], changed: true });
    await waitFor(() => expect(screen.getByTestId('topology-solve-summary').textContent).toContain('40 iterations'));
  });

  it('disables the solve button when the backend has no topology_solve tool', async () => {
    const { analysisId } = seed();
    useStore.setState({ liveStatus: 'connected' });
    mocks.post.mockResolvedValue({ summary: 'Unknown command: topology_solve', isError: true, affected: [], changed: false });
    render(<TopologyPanel analysisId={analysisId} />);
    fireEvent.click(screen.getByTestId('topology-solve'));
    await waitFor(() => expect((screen.getByTestId('topology-solve') as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId('topology-solve-reason').textContent).toContain('Unknown command');
  });

  it('renders the report: numbers, badges and the history plot', () => {
    const { analysisId } = seed();
    mocks.report = SOLVED;
    render(<TopologyPanel analysisId={analysisId} />);
    expect(screen.getByTestId('kpi-compliance').textContent).toContain('2.5');
    expect(screen.getByTestId('kpi-compliance').textContent).toContain('N*mm');
    expect(screen.getByTestId('kpi-iterations').textContent).toContain('converged');
    expect(screen.getByTestId('topology-badge-concept')).toBeTruthy();
    expect(screen.getByTestId('topology-badge-unverified')).toBeTruthy();
    expect(screen.getByTestId('topology-unverified-reasons').textContent).toContain('material yield');
    expect(screen.getByRole('img', { name: /Compliance and volume/ }).querySelectorAll('polyline')).toHaveLength(2);
  });

  it('shows no unverified badge for verified inputs and no numbers for a stale result', () => {
    const { analysisId } = seed();
    mocks.report = { ...SOLVED, unverified: false, unverifiedReasons: [] };
    const { unmount } = render(<TopologyPanel analysisId={analysisId} />);
    expect(screen.queryByTestId('topology-badge-unverified')).toBeNull();
    unmount();
    mocks.report = {
      state: 'stale',
      problem: { message: 'study changed' },
      concept: true,
      unverified: false,
      unverifiedReasons: [],
      result: null,
    };
    render(<TopologyPanel analysisId={analysisId} />);
    expect(screen.queryByTestId('kpi-compliance')).toBeNull();
    expect(screen.getByTestId('topology-problem').textContent).toContain('study changed');
  });

  it('commits the threshold slider once through set_topology_settings', () => {
    const { analysisId, studyId } = seed();
    mocks.report = SOLVED;
    render(<TopologyPanel analysisId={analysisId} />);
    const slider = screen.getByTestId('topology-threshold');
    fireEvent.change(slider, { target: { value: '0.3' } });
    fireEvent.change(slider, { target: { value: '0.35' } });
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('set_topology_settings', { studyId, threshold: 0.35 });
  });

  it('lists check items with code and remediation', () => {
    const { analysisId } = seed();
    mocks.check = {
      status: 'fail',
      items: [{ code: 'TOP_RESULT_MISSING', severity: 'error', message: 'no result', remediation: 'run topology_solve' }],
    };
    render(<TopologyPanel analysisId={analysisId} />);
    const items = screen.getByTestId('topology-check-items');
    expect(items.textContent).toContain('TOP_RESULT_MISSING');
    expect(items.textContent).toContain('run topology_solve');
    expect(screen.getByTestId('topology-check-status').textContent).toBe('fail');
  });

  it('previews the suggested rebuild loops on demand', () => {
    const { analysisId } = seed();
    mocks.rebuild = {
      plane: 'XY',
      lengthUnit: 'mm',
      droppedLoops: 1,
      loops: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
          orientation: 'outer',
        },
        {
          points: [
            [3, 3],
            [3, 6],
            [6, 6],
          ],
          orientation: 'hole',
        },
      ],
    };
    render(<TopologyPanel analysisId={analysisId} />);
    expect(screen.queryByTestId('topology-rebuild')).toBeNull();
    fireEvent.click(screen.getByTestId('topology-preview-rebuild'));
    expect(screen.getByTestId('topology-rebuild-caption').textContent).toContain('1 outer loop(s), 1 hole(s) on XY');
    expect(screen.getByRole('img', { name: 'Suggested rebuild loops' })).toBeTruthy();
  });
});
