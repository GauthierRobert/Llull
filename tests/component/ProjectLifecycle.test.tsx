/**
 * Component/integration tests for the project lifecycle UI: project title, save file name, New
 * project confirm flow, welcome-dialog structure option, auto-frame, status/measure feedback, and
 * HUD hiding for non-measurement data.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useLayoutStore, useStore, useToolStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { TopBar } from '@ui/components/TopBar';
import { ProjectIO } from '@ui/components/ProjectIO';
import { EmptyState } from '@ui/components/EmptyState';
import { MeasurementHUD } from '@ui/components/MeasurementHUD';
import { useAutoFrame } from '@ui/hooks/useAutoFrame';
import { projectFileStem, projectNameOf } from '@ui/components/projectName';
import * as download from '@ui/download';

function resetStores(): void {
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({ liveStatus: 'disconnected', lastSummary: null, lastMeasure: null });
  useSessionStore.setState({ dirty: false, restoredAt: null });
  useToolStore.setState({ viewMode: '3d', drawTool: 'none', modifyTool: 'none' });
}

const dispatch = (name: string, params: unknown): void =>
  useStore.getState().dispatch(name, params);

describe('project name', () => {
  beforeEach(resetStores);

  it('is null until set_project_info provides a name, then shown in the TopBar', () => {
    render(<TopBar />);
    expect(screen.getByText('Untitled')).toBeDefined();
    act(() => dispatch('set_project_info', { name: 'Plant A / Hall 1' }));
    expect(screen.getByText('Plant A / Hall 1')).toBeDefined();
    expect(projectNameOf(useStore.getState().document)).toBe('Plant A / Hall 1');
    expect(projectFileStem(useStore.getState().document, 'x')).toBe('Plant_A_Hall_1');
  });

  it('announces unsaved changes with an accessible name, independent of the visible word', () => {
    render(<TopBar />);
    expect(screen.queryByRole('status', { name: 'Unsaved changes' })).toBeNull();
    act(() => useSessionStore.getState().markDirty());
    expect(screen.getByRole('status', { name: 'Unsaved changes' })).toBeDefined();
  });

  it('falls back to the timestamp stem without a project name', () => {
    expect(projectFileStem(createEmptyDocument(), 'llull-1')).toBe('llull-1');
  });
});

describe('ProjectIO', () => {
  beforeEach(resetStores);
  afterEach(() => vi.restoreAllMocks());

  it('Save names the file after the project and clears the unsaved marker', () => {
    const save = vi.spyOn(download, 'downloadBlob').mockImplementation(() => undefined);
    act(() => dispatch('set_project_info', { name: 'My Hall' }));
    act(() => useSessionStore.getState().markDirty());
    render(<ProjectIO />);
    fireEvent.click(screen.getByRole('button', { name: /save project/i }));
    expect(save).toHaveBeenCalledWith(expect.any(Blob), 'My_Hall.json');
    expect(useSessionStore.getState().dirty).toBe(false);
  });

  it('New on an empty document clears immediately without asking', () => {
    render(<ProjectIO />);
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('New asks for confirmation on a non-empty document; cancel keeps it, confirm clears it', () => {
    act(() => dispatch('add_box', { size: [1, 1, 1] }));
    render(<ProjectIO />);
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    expect(screen.getByRole('dialog')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().document.order.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    fireEvent.click(screen.getByRole('button', { name: /clear and start new/i }));
    expect(useStore.getState().document.order.length).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('EmptyState — structure option', () => {
  beforeEach(() => {
    resetStores();
    useLayoutStore.setState({ sidebarTab: 'layers', sidebarOpen: true });
  });

  it('"Start a steel structure" switches the sidebar to the Building tab', () => {
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /start a steel structure/i }));
    expect(useLayoutStore.getState().sidebarTab).toBe('building');
  });

  it('"Steel hall template" adds the hall', () => {
    render(<EmptyState />);
    fireEvent.click(screen.getByRole('button', { name: /steel hall template/i }));
    expect(useStore.getState().document.order.length).toBeGreaterThan(0);
  });
});

describe('useAutoFrame', () => {
  beforeEach(resetStores);

  function Harness(): null {
    useAutoFrame();
    return null;
  }

  it('frames the camera once when the document goes from empty to non-empty, quietly', () => {
    render(<Harness />);
    const before = useStore.getState().document.camera;
    act(() => dispatch('add_box', { size: [5000, 5000, 5000], position: [20000, 20000, 0] }));
    const framed = useStore.getState().document.camera;
    expect(framed).not.toEqual(before);
    expect(useStore.getState().lastSummary).toMatch(/Added|box/i);

    act(() => dispatch('add_box', { size: [1, 1, 1] }));
    expect(useStore.getState().document.camera).toEqual(framed);
  });

  it('joins the framing to the undo step of the content: one Undo empties the model', () => {
    render(<Harness />);
    const before = useStore.getState().document.camera;
    act(() => dispatch('add_box', { size: [5000, 5000, 5000], position: [20000, 20000, 0] }));
    expect(useStore.getState().localOutbox.map((entry) => entry.name)).toEqual([
      'add_box',
      'fit_view',
    ]);
    act(() => useStore.getState().undo());
    expect(useStore.getState().document.order).toHaveLength(0);
    expect(useStore.getState().document.camera).toEqual(before);
    expect(useStore.getState().localOutbox).toHaveLength(0);
    act(() => useStore.getState().redo());
    expect(useStore.getState().document.order).toHaveLength(1);
    expect(useStore.getState().document.camera).not.toEqual(before);
    expect(useStore.getState().localOutbox[0]?.name).toBe('add_box');
    act(() => useStore.getState().undo());
    expect(useStore.getState().document.order).toHaveLength(0);
    expect(useStore.getState().localOutbox).toHaveLength(0);
  });

  it('does not frame while connected to a live server (the camera is shared)', () => {
    useStore.setState({ liveStatus: 'connected' });
    render(<Harness />);
    const before = useStore.getState().document.camera;
    const snapshot = execute(useStore.getState().document, 'add_box', { size: [1, 1, 1] }).document;
    act(() => useStore.setState({ document: snapshot }));
    expect(useStore.getState().document.camera).toEqual(before);
    expect(useStore.getState().localOutbox).toHaveLength(0);
  });
});

describe('status and measurement feedback', () => {
  beforeEach(resetStores);

  it('read-only commands update the status bar summary', () => {
    act(() => dispatch('add_box', { size: [1, 1, 1] }));
    const mutating = useStore.getState().lastSummary;
    act(() => dispatch('measure_bounding_box', {}));
    expect(useStore.getState().lastSummary).not.toBe(mutating);
    expect(useStore.getState().lastMeasure?.command).toBe('measure_bounding_box');
  });

  it('fit_view shows a short status instead of camera internals', () => {
    act(() => dispatch('add_box', { size: [1, 1, 1] }));
    act(() => dispatch('fit_view', { direction: 'iso' }));
    expect(useStore.getState().lastSummary).toBe('View fitted');
  });

  it('mutating commands never set lastMeasure, and the HUD hides unknown data', () => {
    act(() => dispatch('add_box', { size: [1, 1, 1] }));
    expect(useStore.getState().lastMeasure).toBeNull();
    useStore.setState({ lastMeasure: { command: 'add_equipment', data: { ids: ['a'] } } });
    render(<MeasurementHUD />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});
