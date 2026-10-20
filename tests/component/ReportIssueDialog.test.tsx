import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createEmptyDocument } from '@core/model/types';
import { useStore } from '@ui/store';
import { useFailureStore } from '@ui/report/failureStore';
import { ReportIssueDialog } from '@ui/components/ReportIssueDialog';
import { StatusBar } from '@ui/components/StatusBar';
import * as download from '@ui/download';

const failure = {
  name: 'fillet_edges',
  params: { radius: 2, confirmation: { signedBy: 'Alice' }, path: 'C:\\Users\\alice\\part.step' },
  summary: 'fillet_edges failed: kaboom; document unchanged.',
  at: Date.parse('2026-10-19T12:00:00.000Z'),
};

function seedStore(liveStatus: 'connecting' | 'connected'): void {
  const document = { ...createEmptyDocument(), featureHistory: [{ id: 'step-1', name: 'add_box', params: { size: [1, 2, 3] } }] };
  useStore.setState({ document, liveStatus, lastSummary: failure.summary });
}

beforeEach(() => {
  seedStore('connecting');
  useFailureStore.setState({ failure, dialogOpen: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useFailureStore.setState({ failure: null, dialogOpen: false });
});

const textOf = (name: RegExp): string => (screen.getByRole('textbox', { name }) as HTMLTextAreaElement | HTMLInputElement).value;

describe('ReportIssueDialog', () => {
  it('shows exactly what would be included, redacted, and makes no network call', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<ReportIssueDialog />);
    expect(screen.getByRole('dialog', { name: 'Report this problem' })).toBeInTheDocument();
    expect(textOf(/^Title/)).toContain('fillet_edges');
    const body = textOf(/^Description/);
    expect(body).toContain('kaboom');
    expect(body).toContain('`fillet_edges`');
    expect(body).toContain('"radius": 2');
    expect(body).not.toContain('Alice');
    expect(body).not.toContain('alice');
    expect(body).toMatch(/llull \S+ · /);
    const plan = JSON.parse(textOf(/^Reproducer/)) as { actions: { command: string }[] };
    expect(plan.actions.map((a) => a.command)).toEqual(['add_box', 'fillet_edges']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prefers the backend crash report when online', async () => {
    const report = {
      time: '2026-10-19T12:00:01.000Z',
      commandLog: {
        replayFrom: 'empty',
        commands: [{ name: 'add_cylinder', params: {} }],
        failing: { name: 'fillet_edges', params: { radius: 2 } },
      },
    };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(report) });
    vi.stubGlobal('fetch', fetchSpy);
    seedStore('connected');
    render(<ReportIssueDialog />);
    await waitFor(() => expect(textOf(/^Reproducer/)).toContain('add_cylinder'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/\/crashes\/latest$/);
    expect(screen.getByText(/from the local crash report/)).toBeInTheDocument();
  });

  it('unticking the attachment leaves the reproducer out of the draft link and the copy', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ReportIssueDialog />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Include the reproducer/ }));
    expect(screen.getByRole('textbox', { name: /^Reproducer/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub issue draft' }));
    const [url, target] = open.mock.calls[0] ?? [];
    expect(String(url).startsWith('https://github.com/GauthierRobert/Llull/issues/new?')).toBe(true);
    expect(target).toBe('_blank');
    expect(new URL(String(url)).searchParams.get('body')).not.toContain('add_box');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(writeText.mock.calls[0]?.[0]).not.toContain('add_box');
  });

  it('edited text is what the link carries; Save downloads the (edited) reproducer file', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const save = vi.spyOn(download, 'downloadText').mockImplementation(() => undefined);
    render(<ReportIssueDialog />);
    fireEvent.change(screen.getByRole('textbox', { name: /^Title/ }), { target: { value: 'My title' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Description/ }), { target: { value: 'my words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub issue draft' }));
    const params = new URL(String(open.mock.calls[0]?.[0])).searchParams;
    expect(params.get('title')).toBe('My title');
    expect(params.get('body')).toContain('my words');
    fireEvent.click(screen.getByRole('button', { name: 'Save reproducer…' }));
    expect(save).toHaveBeenCalledWith(expect.stringContaining('"add_box"'), 'llull-reproducer.json', 'application/json');
  });

  it('warns when the link had to be shortened', () => {
    useFailureStore.setState({ failure: { ...failure, params: { blob: 'x'.repeat(20_000) } } });
    render(<ReportIssueDialog />);
    fireEvent.change(screen.getByRole('textbox', { name: /^Reproducer/ }), { target: { value: 'y'.repeat(30_000) } });
    expect(screen.getByRole('status')).toHaveTextContent(/attach the file/);
  });

  it('closes on Escape', () => {
    render(<ReportIssueDialog />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(useFailureStore.getState().dialogOpen).toBe(false);
  });
});

describe('Report offer in the status bar', () => {
  it('appears for an internal failure and opens the dialog', () => {
    useFailureStore.setState({ dialogOpen: false });
    render(<StatusBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Report this…' }));
    expect(useFailureStore.getState().dialogOpen).toBe(true);
  });

  it('is gone once the status text moves on', () => {
    render(<StatusBar />);
    act(() => useStore.setState({ lastSummary: 'Created box-1' }));
    expect(screen.queryByRole('button', { name: 'Report this…' })).toBeNull();
  });

  it('is only recorded for internal failures, never for user errors or unsupported notices', () => {
    useFailureStore.setState({ failure: null });
    useStore.setState({ liveStatus: 'disconnected' });
    useStore.getState().dispatch('add_box', { size: 'nope' });
    expect(useFailureStore.getState().failure).toBeNull();
  });
});
