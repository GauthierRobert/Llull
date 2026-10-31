import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getCommand } from '@core/commands/registry';
import { execute } from '@core/commands/registry';
import { derivedEntityIds } from '@core/plugins/host';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { useStore } from '@ui/store';
import { useFeatureSessionStore } from '@ui/store/featureSessionStore';
import { usePreviewStore } from '@ui/store/previewStore';
import { useGhostStore } from '@ui/store/ghostStore';
import { createPreviewController, PREVIEW_DEBOUNCE_MS, type PreviewController } from '@ui/preview/previewController';
import { runPreview, type PreviewOutcome } from '@ui/preview/runPreview';
import { CommandParamForm } from '@ui/components/commandPalette/CommandParamForm';
import { ValueBox } from '@ui/viewport/3d/manipulators/ValueBox';
import { FeatureStartBar } from '@ui/viewport/3d/manipulators/FeatureStartBar';
import { useFeatureSession } from '@ui/viewport/3d/manipulators/useFeatureSession';

const OK: PreviewOutcome = { ok: true, summary: 'ok', entities: [], replacedIds: [] };

describe('preview controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(): { controller: PreviewController; run: Mock; dispatch: Mock; onOutcome: Mock } {
    const run = vi.fn((_doc, _name: string, _params: unknown) => OK);
    const dispatch = vi.fn();
    const onOutcome = vi.fn();
    const controller = createPreviewController({ getDocument: createEmptyDocument, run, dispatch, onOutcome });
    return { controller, run, dispatch, onOutcome };
  }

  it('debounces: only the last request of a burst runs, and it never dispatches', () => {
    const { controller, run, dispatch, onOutcome } = setup();
    controller.request('extrude_profile', { depth: 1 });
    controller.request('extrude_profile', { depth: 2 });
    controller.request('extrude_profile', { depth: 3 });
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[2]).toEqual({ depth: 3 });
    expect(onOutcome).toHaveBeenCalledWith(OK);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cancels a stale request and clears the ghost', () => {
    const { controller, run, dispatch, onOutcome } = setup();
    controller.request('extrude_profile', { depth: 1 });
    controller.cancel();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenLastCalledWith(null);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('commit dispatches exactly once, drops the pending run and clears the ghost', () => {
    const { controller, run, dispatch, onOutcome } = setup();
    controller.request('fillet_edge', { radius: 1 });
    controller.commit('fillet_edge', { radius: 2 }, { selectAffected: true });
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('fillet_edge', { radius: 2 }, { selectAffected: true });
    expect(onOutcome).toHaveBeenLastCalledWith(null);
  });
});

function profileAndBody(): { doc: CadDocument; rectId: string; boxId: string } {
  const rect = execute(createEmptyDocument(), 'draw_rectangle', { width: 10, height: 10 });
  const box = execute(rect.document, 'add_box', { size: [10, 10, 4], position: [0, 0, -2] });
  return { doc: box.document, rectId: rect.affected[0] as string, boxId: box.affected[0] as string };
}

describe('runPreview', () => {
  it('does not touch the document and reports what it would create', () => {
    const { doc, rectId } = profileAndBody();
    const before = JSON.stringify(doc);
    const outcome = runPreview(doc, 'extrude_profile', { id: rectId, depth: 5 });
    expect(outcome.ok).toBe(true);
    expect(outcome.entities.map((e) => e.kind)).toEqual(['extrusion']);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('turns a refusal into the command summary', () => {
    const { doc, rectId } = profileAndBody();
    const outcome = runPreview(doc, 'extrude_profile', { id: rectId, depth: -1 });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('depth');
  });
});

describe('palette form preview', () => {
  const dispatch = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    dispatch.mockClear();
    usePreviewStore.getState().setOutcome(null);
  });
  afterEach(() => vi.useRealTimers());

  it('ghosts the result while typing, never dispatches, and clears on submit', () => {
    const { doc, rectId } = profileAndBody();
    useStore.setState({ document: { ...doc, selection: [rectId] }, dispatch });
    const onSubmit = vi.fn();
    render(<CommandParamForm command={getCommand('extrude_profile')!} preview onBack={() => undefined} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/^Depth/), { target: { value: '5' } });
    act(() => void vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1));
    expect(usePreviewStore.getState().outcome?.entities.map((e) => e.kind)).toEqual(['extrusion']);
    expect(screen.getByRole('status').textContent).toContain('Preview');
    expect(dispatch).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.submit(screen.getByRole('form', { name: /parameters/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(usePreviewStore.getState().outcome).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('shows the refusal in the dialog instead of crashing (kernel command without a kernel)', () => {
    const { doc, boxId } = profileAndBody();
    useStore.setState({ document: { ...doc, selection: [boxId] }, dispatch });
    render(<CommandParamForm command={getCommand('shell_solid')!} preview onBack={() => undefined} onSubmit={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/^Thickness(\*)?$/), { target: { value: '1' } });
    act(() => void vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1));
    expect(usePreviewStore.getState().outcome?.ok).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('Preview unavailable');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps the plain dialog (no preview) when the prop is off', () => {
    const { doc, rectId } = profileAndBody();
    useStore.setState({ document: { ...doc, selection: [rectId] }, dispatch });
    render(<CommandParamForm command={getCommand('extrude_profile')!} onBack={() => undefined} onSubmit={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/^Depth/), { target: { value: '5' } });
    act(() => void vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1));
    expect(usePreviewStore.getState().outcome).toBeNull();
  });

  it('fades the entities a command would replace through the ghost store', () => {
    usePreviewStore.getState().setOutcome({ ok: true, summary: '', entities: [], replacedIds: ['box-1.1'] });
    expect(useGhostStore.getState().ghostedIds.has('box-1.1')).toBe(true);
    usePreviewStore.getState().setOutcome(null);
    expect(useGhostStore.getState().ghostedIds.has('box-1.1')).toBe(false);
  });
});

describe('ValueBox', () => {
  function setup(): { onChange: Mock; onCommit: Mock; onCancel: Mock; input: HTMLInputElement } {
    const handlers = { onChange: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
    render(<ValueBox label="Distance" unit="mm" value={4} {...handlers} />);
    return { ...handlers, input: screen.getByLabelText('Distance (mm)') as HTMLInputElement };
  }

  it('shows the value, reports typed numbers, ignores junk', () => {
    const { input, onChange } = setup();
    expect(input.value).toBe('4');
    fireEvent.change(input, { target: { value: '7.5' } });
    expect(onChange).toHaveBeenLastCalledWith(7.5);
    fireEvent.change(input, { target: { value: '7.' } });
    fireEvent.change(input, { target: { value: 'x' } });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('Enter commits and Escape cancels', () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

function SessionHarness(): React.ReactElement {
  const { plan, commit, cancel } = useFeatureSession();
  return (
    <div>
      <output data-testid="mode">{plan?.mode ?? 'none'}</output>
      <button onClick={commit}>commit</button>
      <button onClick={cancel}>cancel</button>
    </div>
  );
}

describe('feature drag session', () => {
  const dispatch = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    dispatch.mockClear();
    usePreviewStore.getState().setOutcome(null);
    useFeatureSessionStore.getState().end();
  });
  afterEach(() => vi.useRealTimers());

  it('offers Extrude for a sketch profile and starts a session without touching the document', () => {
    const { doc, rectId } = profileAndBody();
    useStore.setState({ document: { ...doc, selection: [rectId] }, dispatch });
    render(<FeatureStartBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Extrude' }));
    expect(useFeatureSessionStore.getState().session).toMatchObject({ kind: 'extrude', targetId: rectId });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('offers Fillet and Shell for a solid and nothing for a multi-selection', () => {
    const { doc, boxId, rectId } = profileAndBody();
    useStore.setState({ document: { ...doc, selection: [boxId] }, dispatch });
    const { unmount } = render(<FeatureStartBar />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Fillet', 'Shell']);
    unmount();
    useStore.setState({ document: { ...doc, selection: [boxId, rectId] }, dispatch });
    render(<FeatureStartBar />);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('offers nothing for plugin-derived geometry (a building element is read-only)', () => {
    const doc = execute(createEmptyDocument(), 'add_portal_frame_building', {}).document;
    const derivedSolid = [...derivedEntityIds(doc)].find((id) => doc.entities[id]?.kind === 'mesh');
    if (derivedSolid === undefined) throw new Error('the portal frame derived no solid');
    useStore.setState({ document: { ...doc, selection: [derivedSolid] }, dispatch });
    render(<FeatureStartBar />);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('previews live while the value changes, then commits ONE build_project on release', () => {
    const { doc, rectId, boxId } = profileAndBody();
    useStore.setState({ document: { ...doc, selection: [rectId] }, dispatch });
    useFeatureSessionStore.getState().start('extrude', rectId, 2);
    render(<SessionHarness />);
    expect(screen.getByTestId('mode').textContent).toBe('join');

    act(() => void vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1));
    expect(usePreviewStore.getState().outcome?.ok).toBe(true);

    act(() => useFeatureSessionStore.getState().setValue(-3));
    expect(screen.getByTestId('mode').textContent).toBe('cut');
    act(() => void vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1));
    expect(usePreviewStore.getState().tone).toBe('cut');
    expect(dispatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('commit'));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [name, params] = dispatch.mock.calls[0] as [string, { actions: Array<{ command: string; params: Record<string, unknown> }> }];
    expect(name).toBe('build_project');
    expect(params.actions.map((a) => a.command)).toEqual(['extrude_profile', 'boolean']);
    expect(params.actions[1]?.params).toEqual({ op: 'subtract', a: boxId, b: '$tool' });
    expect(useFeatureSessionStore.getState().session).toBeNull();
    expect(usePreviewStore.getState().outcome).toBeNull();
  });

  it('cancel discards the ghost and dispatches nothing', () => {
    const { doc, rectId } = profileAndBody();
    useStore.setState({ document: { ...doc, selection: [rectId] }, dispatch });
    useFeatureSessionStore.getState().start('extrude', rectId, 2);
    render(<SessionHarness />);
    act(() => void vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1));
    fireEvent.click(screen.getByText('cancel'));
    expect(dispatch).not.toHaveBeenCalled();
    expect(useFeatureSessionStore.getState().session).toBeNull();
    expect(usePreviewStore.getState().outcome).toBeNull();
  });

  it('keeps the session open and dispatches nothing when the dry run was refused', () => {
    const { doc, boxId } = profileAndBody();
    useStore.setState({ document: { ...doc, selection: [boxId] }, dispatch });
    useFeatureSessionStore.getState().start('fillet', boxId, 0.5);
    render(<SessionHarness />);
    act(() => void vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1));
    expect(usePreviewStore.getState().outcome?.ok).toBe(false);
    fireEvent.click(screen.getByText('commit'));
    expect(dispatch).not.toHaveBeenCalled();
    expect(useFeatureSessionStore.getState().session).not.toBeNull();
  });
});
