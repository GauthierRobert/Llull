import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { type SubdivisionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { CageEditBar } from '@ui/viewport/3d/cage/CageEditBar';
import { cancelGesture, commitGesture, updateGesture } from '@ui/viewport/3d/cage/gestureActions';
import { DEFAULT_FALLOFF } from '@ui/viewport/3d/cage/gestureCommands';

const built = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 1 });
const id = built.affected[0] as string;
const cage = built.document.entities[id] as SubdivisionEntity;
const vertex = cage.elementIds.vertices[0] as string;

describe('cage edit gestures commit exactly one command', () => {
  const dispatch = vi.fn();
  beforeEach(() => {
    dispatch.mockClear();
    useStore.setState({ document: { ...built.document, selection: [id] }, dispatch });
    useDirectEditStore.setState({
      entityId: id,
      tool: 'select',
      selection: { vertices: [vertex], edges: [], faces: [] },
      falloff: DEFAULT_FALLOFF,
      gesture: null,
      preview: null,
      lastCommit: null,
    });
  });

  it('dispatches once on commit, remembers it for Copy as CLI and clears the gesture', () => {
    updateGesture({ kind: 'translate', delta: [0.5, 0, 0] });
    updateGesture({ kind: 'translate', delta: [0.75, 0, 0] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(commitGesture()).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('edit_subdivision_cage', { id, vertices: [vertex], translate: [0.75, 0, 0] });
    expect(useDirectEditStore.getState().lastCommit?.name).toBe('edit_subdivision_cage');
    expect(useDirectEditStore.getState().gesture).toBeNull();
  });
  it('cancel dispatches nothing', () => {
    updateGesture({ kind: 'translate', delta: [0.5, 0, 0] });
    cancelGesture();
    expect(commitGesture()).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('an idle gesture commits nothing', () => {
    updateGesture({ kind: 'translate', delta: [0, 0, 0] });
    expect(commitGesture()).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('CageEditBar', () => {
  beforeEach(() => {
    useStore.setState({ document: { ...built.document, selection: [id] } });
    useDirectEditStore.getState().exit();
    useDirectEditStore.setState({ lastCommit: null });
  });

  it('offers Edit cage for a selected subdivision solid and enters edit mode', () => {
    render(<CageEditBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit cage' }));
    expect(useDirectEditStore.getState().entityId).toBe(id);
    expect(screen.getByRole('button', { name: 'Face' })).toBeTruthy();
  });
  it('Tab enters edit mode', () => {
    render(<CageEditBar />);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(useDirectEditStore.getState().entityId).toBe(id);
  });
  it('switches element mode and toggles the loop-cut tool', () => {
    useDirectEditStore.getState().enter(id);
    render(<CageEditBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Edge' }));
    expect(useDirectEditStore.getState().elementMode).toBe('edge');
    fireEvent.click(screen.getByRole('button', { name: 'Loop cut' }));
    expect(useDirectEditStore.getState().tool).toBe('loop_cut');
  });
  it('Copy as CLI is disabled until a gesture was committed, then copies the exact line', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useDirectEditStore.getState().enter(id);
    const { rerender } = render(<CageEditBar />);
    const button = screen.getByRole('button', { name: /Copy as CLI/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    useDirectEditStore.getState().setLastCommit({ name: 'loop_cut_cage', params: { id, edge: 'e:a|b', cuts: 1 } });
    rerender(<CageEditBar />);
    fireEvent.click(screen.getByRole('button', { name: /Copy as CLI/ }));
    expect(writeText).toHaveBeenCalledWith(`llull exec loop_cut_cage '{"id":"${id}","edge":"e:a|b","cuts":1}' --app`);
  });
  it('sets the falloff radius', () => {
    useDirectEditStore.getState().enter(id);
    render(<CageEditBar />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0.8' } });
    expect(useDirectEditStore.getState().falloff.radius).toBe(0.8);
  });
});
