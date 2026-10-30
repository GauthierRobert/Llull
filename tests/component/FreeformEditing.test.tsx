import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getCommand } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import { useGhostStore } from '@ui/store/ghostStore';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { usePreviewStore } from '@ui/store/previewStore';
import { useRemotePreviewStore } from '@ui/store/remotePreviewStore';
import { endRemotePreview } from '@ui/preview/remote/remotePreviewSession';
import { FaceEditBar } from '@ui/viewport/3d/faceEdit/FaceEditBar';
import { cancelFaceDrag, commitFaceDrag, updateFaceDrag } from '@ui/viewport/3d/faceEdit/faceEditActions';
import { NurbsNetBar } from '@ui/viewport/3d/nurbsNet/NurbsNetBar';
import { cancelPoleDrag, commitPoleDrag, updatePoleDrag } from '@ui/viewport/3d/nurbsNet/netActions';
import { CommandParamForm } from '@ui/components/commandPalette/CommandParamForm';
import { allPaletteItems } from '@ui/components/commandPalette/paletteItems';
import { dispatchEntity, resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';

const answer = (summary: string): Record<string, unknown> => ({
  ok: true,
  summary,
  replacedIds: ['mesh-old'],
  entities: [
    { id: 'mesh-new', kind: 'mesh', color: '#888888', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangleCount: 1, truncated: false },
  ],
});

function stubFetch(hold = false): {
  calls: Array<{ body: { name: string; params: unknown }; signal: AbortSignal }>;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const calls: Array<{ body: { name: string; params: unknown }; signal: AbortSignal }> = [];
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string) as { name: string; params: unknown }, signal: init.signal as AbortSignal });
    if (hold)
      return new Promise<Response>((_resolve, reject) =>
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted'))),
      );
    return Promise.resolve(new Response(JSON.stringify(answer(`preview ${calls.length}`)), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('face handle drag: backend preview, one command on release', () => {
  let dispatch: ReturnType<typeof vi.fn<(name: string, params?: unknown) => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
    dispatch = vi.fn<(name: string, params?: unknown) => void>();
    useStore.setState({ dispatch });
    useFaceEditStore.setState({
      active: true,
      op: 'push_pull',
      entityId: 'box-1',
      pick: { point: [1, 0.5, 2], normal: [0, 0, 1], lever: 2 },
      region: [0, 1],
      hover: null,
      value: null,
    });
  });
  afterEach(() => {
    endRemotePreview();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useFaceEditStore.getState().stop();
  });

  it('coalesces a drag into one /preview request, shows its ghost and never dispatches', async () => {
    const { calls } = stubFetch();
    for (const value of [0.5, 1, 1.5]) {
      updateFaceDrag(value);
      await vi.advanceTimersByTimeAsync(15);
    }
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ name: 'push_pull_face', params: { id: 'box-1', faceNear: [1, 0.5, 2], distance: 1.5 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(useRemotePreviewStore.getState().status).toBe('ready');
    expect(useRemotePreviewStore.getState().meshes.map((mesh) => mesh.id)).toEqual(['mesh-new']);
    expect(useGhostStore.getState().ghostedIds.has('mesh-old')).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a stale answer is dropped when a newer request supersedes it', async () => {
    const { calls } = stubFetch(true);
    updateFaceDrag(1);
    await vi.advanceTimersByTimeAsync(100);
    updateFaceDrag(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
  });

  it('release dispatches exactly one command, clears the ghost and aborts the request in flight', async () => {
    const { calls } = stubFetch(true);
    updateFaceDrag(1);
    await vi.advanceTimersByTimeAsync(100);
    updateFaceDrag(2);
    expect(commitFaceDrag()).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('push_pull_face', { id: 'box-1', faceNear: [1, 0.5, 2], distance: 2 });
    expect(calls[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(1);
    expect(useRemotePreviewStore.getState().status).toBe('idle');
    expect(useGhostStore.getState().ghostedIds.size).toBe(0);
  });

  it('an offset drag previews move_faces with preview: true and commits it without', async () => {
    const { calls } = stubFetch();
    useFaceEditStore.setState({ op: 'offset' });
    updateFaceDrag(1.5);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.name).toBe('move_faces');
    expect(calls[0]?.body.params).toMatchObject({ id: 'box-1', mode: 'offset', distance: 1.5, preview: true });
    expect(commitFaceDrag()).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [name, params] = dispatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('move_faces');
    expect(params).toMatchObject({ id: 'box-1', mode: 'offset', distance: 1.5 });
    expect(params).not.toHaveProperty('preview');
  });

  it('cancel dispatches nothing and keeps the pick', async () => {
    stubFetch();
    updateFaceDrag(1);
    cancelFaceDrag();
    expect(commitFaceDrag()).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(useRemotePreviewStore.getState().status).toBe('idle');
  });

  it('shows a backend refusal and an unreachable backend without touching the document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false, summary: 'face is not planar', entities: [], replacedIds: [] }), { status: 200 }),
        ),
      ),
    );
    updateFaceDrag(1);
    await vi.advanceTimersByTimeAsync(120);
    expect(useRemotePreviewStore.getState().status).toBe('refused');
    expect(useRemotePreviewStore.getState().summary).toBe('face is not planar');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    updateFaceDrag(2);
    await vi.advanceTimersByTimeAsync(120);
    expect(useRemotePreviewStore.getState().status).toBe('unavailable');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('FaceEditBar', () => {
  beforeEach(() => {
    resetStore();
    useFaceEditStore.getState().stop();
  });
  afterEach(cleanup);

  it('offers Edit faces for a selected exact solid and switches the operation', () => {
    const { id } = dispatchEntity('add_box', { size: [2, 2, 2] });
    act(() => useStore.getState().select([id]));
    render(<FaceEditBar />);
    fireEvent.click(screen.getByText('Edit faces'));
    expect(useFaceEditStore.getState().active).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
    expect(useFaceEditStore.getState().op).toBe('draft');
    expect(screen.getByRole('button', { name: 'Draft' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Click a face');
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(useFaceEditStore.getState().active).toBe(false);
  });

  it('renders nothing for a curve', () => {
    const { id } = dispatchEntity('create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    act(() => useStore.getState().select([id]));
    const { container } = render(<FaceEditBar />);
    expect(container.firstChild).toBeNull();
  });
});

describe('control net overlay and pole drag', () => {
  let curveId: string;
  beforeEach(() => {
    resetStore();
    useNurbsNetStore.setState({ visible: false, hover: null, drag: null });
    usePreviewStore.getState().setOutcome(null);
    curveId = dispatchEntity('create_nurbs_curve', {
      degree: 2,
      poles: [
        [0, 0, 0],
        [1, 2, 0],
        [2, 0, 0],
      ],
    }).id;
    act(() => useStore.getState().select([curveId]));
  });
  afterEach(cleanup);

  it('the Poles chip toggles the overlay for the selected curve', () => {
    render(<NurbsNetBar />);
    const chip = screen.getByRole('button', { name: 'Show poles' });
    fireEvent.click(chip);
    expect(useNurbsNetStore.getState().visible).toBe(true);
    expect(screen.getByRole('button', { name: 'Hide poles' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Drag a pole');
  });

  it('shows no chip for a solid', () => {
    const { id } = dispatchEntity('add_box', { size: [1, 1, 1] });
    act(() => useStore.getState().select([id]));
    const { container } = render(<NurbsNetBar />);
    expect(container.firstChild).toBeNull();
  });

  it('previews a dragged pole without editing the document and commits one edit_nurbs', () => {
    const dispatch = vi.fn();
    useStore.setState({ dispatch });
    const before = useStore.getState().document;
    updatePoleDrag(curveId, 1, [0, 1, 0]);
    updatePoleDrag(curveId, 1, [0, 1.5, 0]);
    expect(useStore.getState().document).toBe(before);
    expect(usePreviewStore.getState().outcome?.ok).toBe(true);
    expect(useNurbsNetStore.getState().drag?.preview?.kind).toBe('nurbs_curve');
    expect(commitPoleDrag()).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('edit_nurbs', { id: curveId, operation: 'move_poles', indices: [1], delta: [0, 1.5, 0] });
    expect(usePreviewStore.getState().outcome).toBeNull();
    expect(useNurbsNetStore.getState().drag).toBeNull();
  });

  it('cancelling a pole drag dispatches nothing', () => {
    const dispatch = vi.fn();
    useStore.setState({ dispatch });
    updatePoleDrag(curveId, 1, [0, 1, 0]);
    cancelPoleDrag();
    expect(commitPoleDrag()).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('palette and parameter gathering for the freeform commands', () => {
  afterEach(cleanup);

  it('lists the mode actions and labels the direct-editing commands', () => {
    const items = allPaletteItems();
    for (const id of ['action:edit-faces', 'action:edit-cage', 'action:toggle-control-net'])
      expect(items.some((item) => item.id === id)).toBe(true);
    expect(items.find((item) => item.id === 'command:move_faces')?.label).toBe('Move faces (direct)…');
    expect(items.find((item) => item.id === 'command:edit_nurbs')?.label).toBe('Edit NURBS curve poles…');
  });

  it('the mode actions explain what to select when nothing fits', () => {
    resetStore();
    const edit = allPaletteItems().find((item) => item.id === 'action:edit-faces');
    act(() => (edit?.kind === 'action' ? edit.run() : undefined));
    expect(useFaceEditStore.getState().active).toBe(false);
    expect(useStore.getState().lastSummary).toContain('Select one exact solid');
    const { id } = localDispatch('add_box', { size: [1, 1, 1] }).affected.map((affected) => ({ id: affected }))[0] as { id: string };
    act(() => useStore.getState().select([id]));
    act(() => (edit?.kind === 'action' ? edit.run() : undefined));
    expect(useFaceEditStore.getState().active).toBe(true);
    useFaceEditStore.getState().stop();
  });

  it('the move_faces form shows the parameters of the chosen mode and submits only those', () => {
    const command = getCommand('move_faces');
    if (command === undefined) throw new Error('move_faces is not registered');
    const onSubmit = vi.fn();
    render(<CommandParamForm command={command} onBack={() => undefined} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/^Mode/), { target: { value: 'offset' } });
    expect(screen.queryByLabelText(/^Vector/)).toBeNull();
    expect(screen.getByLabelText(/^Distance/)).toBeDefined();
    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: 'box-1' } });
    fireEvent.change(screen.getByLabelText(/^Distance/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/^Mode/), { target: { value: 'translate' } });
    expect(screen.getByLabelText(/^Vector/)).toBeDefined();
    expect(screen.queryByLabelText(/^Distance/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Mode/), { target: { value: 'offset' } });
    fireEvent.submit(screen.getByRole('form', { name: /parameters/ }));
    expect(onSubmit).toHaveBeenCalledWith({ id: 'box-1', mode: 'offset', distance: 2 });
  });
});
