import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelExport } from '@ui/components/ModelExport';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

describe('ModelExport', () => {
  let downloads: string[];

  beforeEach(() => {
    downloads = [];
    const doc = execute(createEmptyDocument(), 'add_box', { size: [10, 20, 30] }).document;
    useStore.setState({ document: doc });
    // jsdom has no object URLs.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:model'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('offers 3MF only inside the desktop app, where the desktop owns the dialog and the path (no argument crosses the bridge)', async () => {
    const { unmount } = render(<ModelExport />);
    expect(screen.queryByRole('option', { name: /3MF/ })).toBeNull();
    unmount();
    const exportThreeMf = vi.fn().mockResolvedValue({ ok: true, message: 'C:/out/plate.3mf (1234 bytes)' });
    Object.defineProperty(window, 'llull', { value: { exportThreeMf }, configurable: true });
    try {
      render(<ModelExport />);
      fireEvent.change(screen.getByLabelText('Export format'), { target: { value: '3mf' } });
      fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('C:/out/plate.3mf (1234 bytes)'));
      expect(exportThreeMf).toHaveBeenCalledTimes(1);
      expect(exportThreeMf).toHaveBeenCalledWith();
      expect(downloads).toEqual([]);
      exportThreeMf.mockResolvedValue({ ok: false, message: 'Export cancelled' });
      fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Export cancelled'));
    } finally {
      Reflect.deleteProperty(window, 'llull');
    }
  });
  it('downloads a binary STL mesh by default', () => {
    render(<ModelExport />);
    fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
    expect(downloads).toEqual(['model.stl']);
    expect(screen.getByRole('status').textContent).toMatch(/export_stl/);
  });
  it('downloads CadQuery code when that format is chosen', () => {
    render(<ModelExport />);
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'cadquery' } });
    fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
    expect(downloads).toEqual(['model.py']);
  });
  it('downloads an OpenSCAD file when that format is chosen', () => {
    render(<ModelExport />);
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'openscad' } });
    fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
    expect(downloads).toEqual(['model.scad']);
  });
  it('fetches STEP from the server and reports a failure without downloading', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'export_step requires the llull Python bridge.' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ModelExport />);
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'step' } });
    fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
    await vi.waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Python bridge/));
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/export\/step\?name=model$/);
    expect(downloads).toEqual([]);
    vi.unstubAllGlobals();
  });
});
