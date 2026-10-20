/** Aerospace 04 XCH review surface: badge, comparison table, provenance in the properties panel, report overlay, import / verify / export controls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useStore } from '@ui/store';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { ExchangeReportHUD } from '@ui/components/ExchangeReportHUD';
import { ExchangeImport } from '@ui/components/ExchangeImport';
import { ModelExport } from '@ui/components/ModelExport';
import { ComparisonTable, ExchangeProvenanceSection, ValidationBadge, parseVerifyReport } from '@ui/panels/exchange/ExchangeReport';
import type { ImportProvenance } from '@core/model/exchange';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';

const comparisons = [
  { property: 'volume' as const, sender: 1000, receiver: 1500, delta: 0.5, band: 'red' as const },
  {
    property: 'centroid' as const,
    sender: [1, 2, 3] as [number, number, number],
    receiver: [1, 2, 3.5] as [number, number, number],
    delta: 0.5,
    band: 'yellow' as const,
  },
];

const provenance = (extra: Partial<ImportProvenance> = {}): ImportProvenance => ({
  format: 'step',
  schemaName: 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF',
  fileName: 'bracket.stp',
  sha256: 'abc123',
  productName: 'Bracket',
  sourceUnit: 'in',
  gvpCheck: { band: 'red', comparisons, policy: { greenRel: 1e-3, yellowRel: 1e-2, greenCentroidPerDiag: 1e-3, yellowCentroidMm: 1 } },
  unverified: { value: true, reasons: ['import_gvp_red'] },
  ...extra,
});

describe('exchange report parts', () => {
  it('renders the badge per band and the sender / llull / delta / band rows', () => {
    const { rerender } = render(<ValidationBadge band="green" />);
    expect(screen.getByTestId('validation-badge').getAttribute('data-band')).toBe('green');
    rerender(<ValidationBadge band="not-checkable" />);
    expect(screen.getByTestId('validation-badge').textContent).toBe('GVP not checkable');
    rerender(<ComparisonTable rows={comparisons} />);
    const table = screen.getByRole('table', { name: /validation property comparison/i });
    expect(within(table).getByText('[1, 2, 3.5]')).toBeDefined();
    expect(within(table).getAllByText('5.00e-1')).toHaveLength(2);
    expect(
      within(table)
        .getAllByTestId('validation-badge')
        .map((badge) => badge.getAttribute('data-band')),
    ).toEqual(['red', 'yellow']);
    rerender(<ComparisonTable rows={[]} />);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the provenance of an imported body with its review banner', () => {
    render(<ExchangeProvenanceSection provenance={provenance()} />);
    expect(screen.getByText('bracket.stp')).toBeDefined();
    expect(screen.getByText(/file unit in/)).toBeDefined();
    expect(screen.getByTestId('review-required').textContent).toMatch(/import_gvp_red/);
    expect(screen.getAllByTestId('validation-badge').map((badge) => badge.getAttribute('data-band'))).toEqual(['red', 'red', 'yellow']);
  });

  it('shows a verified body without a banner and a file without name or check as not checkable', () => {
    const { unmount } = render(<ExchangeProvenanceSection provenance={provenance({ unverified: { value: false, reasons: [] } })} />);
    expect(screen.queryByTestId('review-required')).toBeNull();
    unmount();
    render(<ExchangeProvenanceSection provenance={{ ...provenance({ fileName: '', schemaName: null }), gvpCheck: undefined as never }} />);
    expect(screen.getByText('unnamed file')).toBeDefined();
    expect(screen.getAllByTestId('validation-badge')[0]?.getAttribute('data-band')).toBe('not-checkable');
  });

  it('parses verify_exchange_file data and refuses anything else', () => {
    expect(parseVerifyReport({ format: 'step', band: 'green', issues: [], reviewRequired: { value: false, reasons: [] } })).not.toBeNull();
    expect(parseVerifyReport({ format: 'jt', band: 'green', issues: [], reviewRequired: {} })).toBeNull();
    expect(parseVerifyReport({ format: 'step', band: 'green' })).toBeNull();
    expect(parseVerifyReport(null)).toBeNull();
  });
});

describe('PropertiesPanel exchange section', () => {
  beforeEach(() => resetStore());

  it('appears for a selected body that has provenance and not for others', () => {
    const imported = localDispatch('add_box', { size: [1, 1, 1] }).affected[0] as string;
    const other = localDispatch('add_box', { size: [2, 2, 2] }).affected[0] as string;
    act(() => useStore.setState((state) => ({ document: { ...state.document, exchange: { provenance: { [imported]: provenance() } } } })));
    useStore.getState().select([imported]);
    const { unmount } = render(<PropertiesPanel />);
    expect(screen.getByTestId('exchange-provenance')).toBeDefined();
    unmount();
    useStore.getState().select([other]);
    render(<PropertiesPanel />);
    expect(screen.queryByTestId('exchange-provenance')).toBeNull();
  });
});

describe('ExchangeReportHUD', () => {
  beforeEach(() => resetStore());

  it('shows the last verify_exchange_file report with its issues and dismisses it', () => {
    const data = {
      format: 'step',
      band: 'red',
      schemaName: 'AP242',
      unitFactor: 25.4,
      issues: [{ code: 'XCH_GVP_RED', severity: 'fail', message: 'volume off', remediation: 'do not deliver' }],
      recomputed: [{ product: 'Bracket', band: 'red', comparisons }],
      reviewRequired: { value: true, reasons: ['gvp_red'] },
    };
    act(() => useStore.setState({ lastMeasure: { command: 'verify_exchange_file', data } }));
    render(<ExchangeReportHUD />);
    const region = screen.getByRole('region', { name: /exchange file report/i });
    expect(within(region).getByText('XCH_GVP_RED')).toBeDefined();
    expect(within(region).getByText(/1 file unit = 25.4 mm/)).toBeDefined();
    expect(within(region).getByText('Bracket')).toBeDefined();
    expect(within(region).getByTestId('review-required')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /dismiss exchange report/i }));
    expect(useStore.getState().lastMeasure).toBeNull();
  });

  it('renders nothing for other measurements or malformed data', () => {
    act(() => useStore.setState({ lastMeasure: { command: 'mass_properties', data: { volume: 1 } } }));
    const { container, rerender } = render(<ExchangeReportHUD />);
    expect(container.firstChild).toBeNull();
    act(() => useStore.setState({ lastMeasure: { command: 'verify_exchange_file', data: { nope: true } } }));
    rerender(<ExchangeReportHUD />);
    expect(container.firstChild).toBeNull();
    act(() =>
      useStore.setState({
        lastMeasure: {
          command: 'verify_exchange_file',
          data: {
            format: 'iges',
            band: 'not-checkable',
            unitFactor: null,
            issues: [],
            recomputed: null,
            reviewRequired: { value: false, reasons: [] },
          },
        },
      }),
    );
    rerender(<ExchangeReportHUD />);
    expect(screen.getByRole('region', { name: /exchange file report/i })).toBeDefined();
  });
});

describe('ExchangeImport', () => {
  const dispatch = vi.fn();
  beforeEach(() => {
    resetStore();
    dispatch.mockReset();
    useStore.setState({ dispatch });
  });

  const pick = async (label: RegExp, file: File): Promise<void> => {
    fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
  };

  it('imports a STEP file as exact solids with its sha256 and an IGES file with import_iges', async () => {
    render(<ExchangeImport />);
    await pick(/step or iges file to import/i, new File(['ISO-10303-21;'], 'part.stp'));
    expect(dispatch).toHaveBeenLastCalledWith(
      'import_step_exact',
      expect.objectContaining({ text: 'ISO-10303-21;', fileName: 'part.stp', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      { selectAffected: true },
    );
    dispatch.mockClear();
    await pick(/step or iges file to import/i, new File(['iges text'], 'part.IGS'));
    expect(dispatch.mock.calls[0]?.[0]).toBe('import_iges');
  });

  it('verifies a file through the read-only command without importing it', async () => {
    render(<ExchangeImport />);
    await pick(/step or iges file to verify/i, new File(['ISO-10303-21;'], 'part.stp'));
    expect(dispatch).toHaveBeenCalledWith('verify_exchange_file', { text: 'ISO-10303-21;', fileName: 'part.stp' });
  });
});

describe('ModelExport: exact formats', () => {
  let downloads: string[];
  beforeEach(() => {
    downloads = [];
    resetStore();
    localDispatch('add_box', { size: [10, 20, 30] });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:model'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const exportAs = async (value: string): Promise<void> => {
    render(<ModelExport />);
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
  };
  const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

  it('downloads AP242 built by the server command, with a timestamp for the header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        reply({
          summary: 'export_step_ap242: 1 exact solid(s) → STEP AP242',
          affected: [],
          isError: false,
          data: { step: 'ISO-10303-21;' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await exportAs('ap242');
    await waitFor(() => expect(downloads).toEqual(['model.stp']));
    expect(screen.getByRole('status').textContent).toMatch(/STEP AP242/);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/command$/);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      name: string;
      params: { timestamp: string; fileName: string };
    };
    expect(body.name).toBe('export_step_ap242');
    expect(body.params.fileName).toBe('model.stp');
    expect(body.params.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
  });

  it('downloads IGES and reports a refusal or a missing server without a file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply({ summary: 'export_iges: 1 exact solid(s)', affected: [], isError: false, data: { iges: 'IGES' } })),
    );
    await exportAs('iges');
    await waitFor(() => expect(downloads).toEqual(['model.igs']));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          reply({ summary: 'export_step_ap242: XCH_WRITER_UNAVAILABLE — no writer; no-op.', affected: [], isError: true }),
        ),
    );
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'ap242' } });
    fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/XCH_WRITER_UNAVAILABLE/));
    expect(downloads).toEqual(['model.igs']);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    fireEvent.click(screen.getByRole('button', { name: /export the model/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/needs the llull desktop app or server/));
  });
});
