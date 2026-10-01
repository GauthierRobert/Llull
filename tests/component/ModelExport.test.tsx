import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads CadQuery code by default', () => {
    render(<ModelExport />);
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'export_step requires the llull Python bridge.' }), {
        status: 503,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ModelExport />);
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'step' } });
    fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /export the model/i }).title).toMatch(
        /Python bridge/,
      ),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/export\/step\?name=model$/);
    expect(downloads).toEqual([]);
    vi.unstubAllGlobals();
  });
});
