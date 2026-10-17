// Pure readers/filters for the material record inspector: `get_material` payload -> rows, library badges, value filters.

import { isRecord } from '@lib/isRecord';
import { significantNumber } from '@lib/compactNumber';
import type { ExportMarking, LicenceFlag } from '@core/model/materialLibrary';
import type { ProvenanceEntry } from '@ui/panels/ProvenancePopover';

export interface MaterialValueRow {
  readonly id: string;
  readonly property: string;
  readonly unit: string;
  readonly value: string;
  readonly basis: string;
  readonly direction: string;
  readonly condition: string;
  readonly preferred: boolean;
  readonly unverified: boolean;
  readonly provenance: readonly ProvenanceEntry[];
}

export interface MaterialRecordView {
  readonly legacy: boolean;
  readonly unresolved: string | null;
  readonly densityLine: string;
  readonly values: readonly MaterialValueRow[];
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const LICENCE_TEXT: Readonly<Record<LicenceFlag, string>> = {
  'public-domain-us-gov': 'Public domain (US Gov)',
  'licensed-no-redistribution': 'Licensed, no redistribution',
  'company-proprietary': 'Company proprietary',
  'vendor-catalogue': 'Vendor catalogue',
  legacy: 'Legacy',
};

export const licenceText = (licence: LicenceFlag): string => LICENCE_TEXT[licence];

export function markingText(marking: ExportMarking): string {
  if (marking.regime === 'EAR') return `EAR ${marking.eccn}`;
  if (marking.regime === 'ITAR') return marking.category === undefined ? 'ITAR' : `ITAR ${marking.category}`;
  return marking.regime === 'none' ? 'No marking' : 'EAR99';
}

export const isControlled = (marking: ExportMarking): boolean => marking.regime === 'ITAR' || marking.regime === 'EAR';

function valueRow(raw: Record<string, unknown>): MaterialValueRow {
  const provenance = isRecord(raw['provenance']) ? raw['provenance'] : {};
  const entries: ProvenanceEntry[] = ['sourceId', 'citation', 'locator', 'url', 'accessed', 'note']
    .filter((key) => typeof provenance[key] === 'string')
    .map((key) => ({ label: key, value: text(provenance[key]) }));
  const reasons = Array.isArray(raw['unverifiedReasons']) ? raw['unverifiedReasons'].filter((r): r is string => typeof r === 'string') : [];
  for (const reason of reasons) entries.push({ label: 'Unverified because', value: reason });
  const rawValue = raw['value'];
  return {
    id: text(raw['id']),
    property: text(raw['property']),
    unit: text(raw['unit']),
    value: typeof rawValue === 'number' ? String(rawValue) : `(${text(raw['form'], 'table')})`,
    basis: text(raw['basis'], 'unspecified'),
    direction: text(raw['direction'], 'isotropic'),
    condition: isRecord(raw['condition']) ? JSON.stringify(raw['condition']) : '',
    preferred: raw['preferred'] === true,
    unverified: raw['unverified'] === true,
    provenance: entries,
  };
}

export function parseMaterialRecord(data: unknown): MaterialRecordView | null {
  if (!isRecord(data) || !Array.isArray(data['values'])) return null;
  const density = isRecord(data['density']) ? data['density'] : {};
  const densityLine =
    density['available'] === true
      ? `${typeof density['kgPerM3'] === 'number' ? significantNumber(density['kgPerM3'], 5) : '?'} kg/m³ — basis ${text(density['basis'], 'unspecified')}${density['unverified'] === true ? ' (unverified)' : ''}`
      : 'Density not available';
  const unresolved = isRecord(data['unresolved']) ? text(data['unresolved']['reason'], 'unresolved') : null;
  return { legacy: data['legacy'] === true, unresolved, densityLine, values: data['values'].filter(isRecord).map(valueRow) };
}

export interface ValueFilter {
  readonly basis: string;
  readonly direction: string;
}

/** 'all' keeps every row; otherwise the exact basis / direction. */
export function filterValues(rows: readonly MaterialValueRow[], filter: ValueFilter): MaterialValueRow[] {
  return rows.filter(
    (r) => (filter.basis === 'all' || r.basis === filter.basis) && (filter.direction === 'all' || r.direction === filter.direction),
  );
}

export const distinct = (rows: readonly MaterialValueRow[], key: 'basis' | 'direction'): string[] =>
  [...new Set(rows.map((r) => r[key]))].sort();
