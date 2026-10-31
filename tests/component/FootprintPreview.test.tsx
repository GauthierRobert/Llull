// 03 WRP footprint / knurl preview (spec §14.17): the param form of emboss_on_face / add_knurl asks the read-only preview query for the typed params (debounced) and the answer
// is drawn as a ghost; the document is never changed. The answer is mapped to line segments from the query alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getCommand } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { useFootprintPreviewStore } from '@ui/store/footprintPreviewStore';
import { CommandParamForm } from '@ui/components/commandPalette/CommandParamForm';
import { FootprintPreviewLayer } from '@ui/viewport/3d/preview/FootprintPreviewLayer';
import { FOOTPRINT_DEBOUNCE_MS } from '@ui/preview/useFootprintPreview';
import { footprintPreviewCommand, parseFootprint, polylineSegments } from '@ui/preview/footprintPreview';
import { resetOfflineStore } from '../helpers/storeTestHelpers';
import { cylinder, FACE, rectangleOn, useFakeKernel } from '../unit/wrap/support';

describe('footprint preview mapping', () => {
  it('only emboss_on_face and add_knurl have a preview command', () => {
    expect(footprintPreviewCommand('emboss_on_face')).toBe('preview_emboss_on_face');
    expect(footprintPreviewCommand('add_knurl')).toBe('preview_add_knurl');
    expect(footprintPreviewCommand('add_box')).toBeNull();
  });

  it('a footprint answer gives outlines and holes; a knurl answer its lines; damaged entries and other data are left out', () => {
    const square = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 0, 0],
    ];
    const view = parseFootprint('preview_emboss_on_face', {
      footprint: [{ hole: false, points: square }, { hole: true, points: square }, { hole: false, points: [[0, 'x', 0]] }, null],
      method: 'develop',
    });
    expect(view?.outlines).toHaveLength(1);
    expect(view?.holes).toHaveLength(1);
    const knurl = parseFootprint('preview_add_knurl', { lines: [{ points: square }, {}], teeth: 12, pitch: 2.5, thinned: true });
    expect(knurl).toMatchObject({ kind: 'knurl', holes: [] });
    expect(knurl?.outlines).toHaveLength(1);
    expect(parseFootprint('preview_emboss_on_face', null)).toBeNull();
    expect(parseFootprint('preview_emboss_on_face', {})).toBeNull();
    expect(parseFootprint('other', { lines: [] })).toBeNull();
  });

  it('closed loops join the last point to the first, open lines do not', () => {
    const line = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ] as const;
    expect(polylineSegments([line.map((p) => [...p]) as never], false)).toHaveLength(2 * 6);
    expect(polylineSegments([line.map((p) => [...p]) as never], true)).toHaveLength(3 * 6);
  });
});

describe('the param form drives the preview', () => {
  useFakeKernel();
  beforeEach(() => {
    vi.useFakeTimers();
    resetOfflineStore();
    useFootprintPreviewStore.getState().clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const scene = (): Record<string, unknown> => {
    const base = cylinder();
    const rect = rectangleOn(base.doc, 30, 10);
    useStore.setState({ document: rect.doc });
    return { id: base.id, face: FACE, profileIds: [rect.id], mode: 'emboss', depth: 1, placement: { method: 'develop' } };
  };
  const form = (name: string, params: Record<string, unknown>, preview = true): React.ReactElement => (
    <CommandParamForm
      command={getCommand(name)!}
      initialParams={params}
      preview={preview}
      onBack={() => undefined}
      onSubmit={() => undefined}
    />
  );

  it('valid params give, after the debounce, the ghost and a status line; the document is untouched; leaving the form clears the ghost', async () => {
    const params = scene();
    const before = JSON.stringify(useStore.getState().document);
    const { unmount } = render(form('emboss_on_face', params));
    await act(async () => {
      vi.advanceTimersByTime(FOOTPRINT_DEBOUNCE_MS + 50);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const state = useFootprintPreviewStore.getState();
    expect(state.status, state.summary).toBe('ready');
    expect(state.view?.kind).toBe('footprint');
    expect(state.view?.outlines).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('develop chart');
    expect(JSON.stringify(useStore.getState().document)).toBe(before);
    // an edit is debounced: the previous answer stays until the typed params have settled, then the new one replaces it
    const first = useFootprintPreviewStore.getState().view;
    fireEvent.change(screen.getByLabelText(/^depth/i), { target: { value: '2' } });
    await act(async () => {
      vi.advanceTimersByTime(FOOTPRINT_DEBOUNCE_MS / 2);
    });
    expect(useFootprintPreviewStore.getState().view).toBe(first);
    await act(async () => {
      vi.advanceTimersByTime(FOOTPRINT_DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useFootprintPreviewStore.getState().view).not.toBe(first);
    expect(screen.getByRole('status').textContent).toContain('volume +630');
    unmount();
    expect(useFootprintPreviewStore.getState().status).toBe('idle');
  });

  it('a refusal of the preview query is shown as unavailable with its reason and draws nothing', async () => {
    const params = { ...scene(), face: 99 };
    render(form('emboss_on_face', params));
    await act(async () => {
      vi.advanceTimersByTime(FOOTPRINT_DEBOUNCE_MS + 50);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useFootprintPreviewStore.getState().status).toBe('refused');
    expect(useFootprintPreviewStore.getState().view).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Preview unavailable');
  });

  it('a form without preview, and another command, keep the store idle', async () => {
    const params = scene();
    render(form('emboss_on_face', params, false));
    await act(async () => {
      vi.advanceTimersByTime(FOOTPRINT_DEBOUNCE_MS + 50);
    });
    expect(useFootprintPreviewStore.getState().status).toBe('idle');
    cleanup();
    render(form('add_box', { size: [1, 1, 1] }));
    await act(async () => {
      vi.advanceTimersByTime(FOOTPRINT_DEBOUNCE_MS + 50);
    });
    expect(useFootprintPreviewStore.getState().status).toBe('idle');
  });

  it('the layer draws a group while there is a view and nothing otherwise', () => {
    const { container } = render(<FootprintPreviewLayer />);
    expect(container.innerHTML).toBe('');
    act(() =>
      useFootprintPreviewStore.getState().set('ready', 'ok', {
        kind: 'footprint',
        outlines: [
          [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
            [0, 0, 0],
          ],
        ],
        holes: [],
      }),
    );
    expect(container.querySelector('footprint-preview, [name="footprint-preview"]')).not.toBeNull();
    act(() => useFootprintPreviewStore.getState().clear());
    expect(container.innerHTML).toBe('');
  });
});
