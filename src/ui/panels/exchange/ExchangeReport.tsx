// Aerospace 04 XCH review surface (presentation only): the validation badge, the sender / llull / delta / band table and the provenance section of an
// imported body. Every value comes from a command result (`verify_exchange_file`) or from `doc.exchange.provenance`; nothing is computed here.

import React from 'react';
import { classNames } from '@ui/classNames';
import { ReviewBanner } from '@ui/panels/ReviewBanner';
import { isRecord } from '@lib/isRecord';
import type { GvpBand, GvpComparison, ImportProvenance } from '@core/model/exchange';

const BAND_CLASS: Readonly<Record<GvpBand, string>> = {
  green: 'chip--success',
  yellow: 'chip--warning',
  red: 'chip--danger',
  'not-checkable': 'chip--agent',
};

const BAND_TEXT: Readonly<Record<GvpBand, string>> = {
  green: 'GVP green',
  yellow: 'GVP yellow',
  red: 'GVP red',
  'not-checkable': 'GVP not checkable',
};

export function ValidationBadge({ band }: { band: GvpBand }): React.ReactElement {
  return (
    <span
      className={classNames('chip', BAND_CLASS[band])}
      data-testid="validation-badge"
      data-band={band}
      title="Geometric validation properties: sender vs llull"
    >
      {BAND_TEXT[band]}
    </span>
  );
}

const fmt = (value: unknown): string => {
  if (typeof value === 'number') return Number(value.toPrecision(8)).toString();
  if (Array.isArray(value)) return `[${value.map(fmt).join(', ')}]`;
  return String(value);
};

export interface ComparisonRow {
  readonly property: string;
  readonly sender: unknown;
  readonly receiver: unknown;
  readonly delta: number;
  readonly band: GvpBand;
}

/** Sender / llull / delta / band rows (TR-XCH-22: the numbers, never a visual impression). */
export function ComparisonTable({ rows }: { rows: readonly ComparisonRow[] }): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <table className="exchange-table" aria-label="Validation property comparison">
      <thead>
        <tr>
          <th scope="col">Property</th>
          <th scope="col">Sender</th>
          <th scope="col">llull</th>
          <th scope="col">Delta</th>
          <th scope="col">Band</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.property}>
            <th scope="row">{row.property}</th>
            <td>{fmt(row.sender)}</td>
            <td>{fmt(row.receiver)}</td>
            <td>{row.delta.toExponential(2)}</td>
            <td>
              <ValidationBadge band={row.band} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const asRows = (comparisons: readonly GvpComparison[]): ComparisonRow[] => comparisons.map((entry) => ({ ...entry }));

/** The exchange section of the properties panel: where the body came from and how its validation properties compared. */
export function ExchangeProvenanceSection({ provenance }: { provenance: ImportProvenance }): React.ReactElement {
  const band = provenance.gvpCheck?.band ?? 'not-checkable';
  return (
    <div data-testid="exchange-provenance">
      <p className="exchange-line">
        <ValidationBadge band={band} /> <span>{provenance.format.toUpperCase()}</span>{' '}
        <span title={provenance.sha256}>{provenance.fileName || 'unnamed file'}</span>
      </p>
      <p className="exchange-line exchange-line--meta">
        Product <strong>{provenance.productName}</strong>
        {provenance.schemaName !== null && <> · {provenance.schemaName}</>} · file unit {provenance.sourceUnit}
      </p>
      <ComparisonTable rows={asRows(provenance.gvpCheck?.comparisons ?? [])} />
      {provenance.unverified.value && (
        <ReviewBanner
          reason={`Not verified against the sender (${provenance.unverified.reasons.join(', ')}). A qualified reviewer decides before delivery.`}
          unverified
        />
      )}
    </div>
  );
}

interface Issue {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly remediation: string;
}

export interface VerifyReport {
  readonly format: string;
  readonly band: GvpBand;
  readonly schemaName?: string | null;
  readonly unitFactor: number | null;
  readonly issues: readonly Issue[];
  readonly recomputed: readonly { product: string; band: GvpBand; comparisons: readonly ComparisonRow[] }[] | null;
  readonly reviewRequired: { readonly value: boolean; readonly reasons: readonly string[] };
}

/** `verify_exchange_file` data, or null when `data` is not one. */
export function parseVerifyReport(data: unknown): VerifyReport | null {
  if (!isRecord(data) || (data['format'] !== 'step' && data['format'] !== 'iges') || typeof data['band'] !== 'string') return null;
  if (!Array.isArray(data['issues']) || !isRecord(data['reviewRequired'])) return null;
  return data as unknown as VerifyReport;
}

/** The report of a verified file: badge, issues with their remediation, per-product comparison tables. */
export function VerifyReportCard({ report }: { report: VerifyReport }): React.ReactElement {
  return (
    <section className="exchange-card" role="region" aria-label="Exchange file report" data-testid="exchange-report">
      <p className="exchange-line">
        <ValidationBadge band={report.band} /> <strong>{report.format.toUpperCase()}</strong>
        {report.schemaName !== undefined && report.schemaName !== null && <span> {report.schemaName}</span>}
        {report.unitFactor !== null && <span> · 1 file unit = {report.unitFactor} mm</span>}
      </p>
      {report.issues.length > 0 && (
        <ul className="exchange-issues" aria-label="Issues">
          {report.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} data-severity={issue.severity}>
              <strong>{issue.code}</strong> {issue.message} <em>{issue.remediation}</em>
            </li>
          ))}
        </ul>
      )}
      {(report.recomputed ?? []).map((product) => (
        <div key={product.product}>
          <h3 className="exchange-product">
            {product.product} <ValidationBadge band={product.band} />
          </h3>
          <ComparisonTable rows={product.comparisons} />
        </div>
      ))}
      {report.reviewRequired.value && <ReviewBanner reason={`Review required: ${report.reviewRequired.reasons.join(', ')}.`} />}
    </section>
  );
}
