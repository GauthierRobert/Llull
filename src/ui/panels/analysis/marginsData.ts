// Typed reader over the `data` of compute_margins (one row per load case x part / target x check). Returns null when the command refused
// (the caller shows its summary). Applied / allowable / location keys carry their unit (appliedMPa, allowablePsi, atMm): found by prefix.

import { isRecord } from '@lib/isRecord';

type FibreView = 'top' | 'bottom' | 'mid';

export interface MarginRowView {
  readonly rowId: string;
  readonly part: string;
  readonly region: string;
  readonly fibre: FibreView | null;
  readonly loadCase: string;
  readonly check: string;
  readonly criterion: string;
  readonly applied: number | null;
  readonly allowable: number | null;
  /** Stress unit of applied / allowable, from the key suffix (MPa, Pa, Psi ...). */
  readonly unit: string;
  readonly ms: number | null;
  readonly status: string;
  /** What to show for the status: `FAIL (accepted)` when the command says so, else the status. */
  readonly statusLabel: string;
  readonly disposition: string;
  readonly singular: boolean;
  readonly unverified: boolean;
}

export interface MarginsView {
  readonly minMs: number | null;
  readonly warnings: readonly string[];
  readonly reviewRequired: boolean;
  readonly singularScreening: string;
  readonly rows: readonly MarginRowView[];
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** The numeric column whose key is `prefix` + a unit suffix (appliedMPa), with that unit. */
function byPrefix(row: Record<string, unknown>, prefix: string): { readonly value: number | null; readonly unit: string } {
  for (const [key, value] of Object.entries(row)) {
    const unit = key.slice(prefix.length);
    if (key.startsWith(prefix) && /^[A-Z][A-Za-z]*$/.test(unit) && typeof value === 'number') return { value, unit };
  }
  return { value: null, unit: '' };
}

function parseRow(entry: unknown): MarginRowView[] {
  if (!isRecord(entry) || typeof entry['rowId'] !== 'string') return [];
  const applied = byPrefix(entry, 'applied');
  const allowable = byPrefix(entry, 'allowable');
  const fibre = entry['fibre'];
  const status = str(entry['status'], '?');
  return [
    {
      rowId: entry['rowId'],
      part: str(entry['part']),
      region: str(entry['region']),
      fibre: fibre === 'top' || fibre === 'bottom' || fibre === 'mid' ? fibre : null,
      loadCase: str(entry['loadCase']),
      check: str(entry['check']),
      criterion: str(entry['criterion']),
      applied: applied.value,
      allowable: allowable.value,
      unit: applied.unit || allowable.unit,
      ms: typeof entry['ms'] === 'number' ? entry['ms'] : null,
      status,
      statusLabel: str(entry['statusLabel']) || status,
      disposition: str(entry['disposition'], 'none'),
      singular: entry['singular'] === true,
      unverified: entry['unverified'] === true,
    },
  ];
}

export function parseMargins(data: unknown): MarginsView | null {
  if (!isRecord(data) || !Array.isArray(data['rows'])) return null;
  const warnings = Array.isArray(data['warnings']) ? data['warnings'].filter((w): w is string => typeof w === 'string') : [];
  return {
    minMs: typeof data['minMs'] === 'number' ? data['minMs'] : null,
    warnings,
    reviewRequired: data['reviewRequired'] === true,
    singularScreening: str(data['singularScreening']),
    rows: data['rows'].flatMap(parseRow),
  };
}

export function dispositionText(disposition: string): string {
  if (disposition === 'none') return '';
  return disposition === 'pending_human' ? 'pending human review' : disposition.replace(/_/g, ' ');
}

/** Panel tone of a margin status: FAIL bad, MARGINAL warn, PASS ok. */
export function statusToneOf(status: string): 'ok' | 'warn' | 'bad' {
  return status === 'FAIL' ? 'bad' : status === 'MARGINAL' ? 'warn' : 'ok';
}
