// Pure reader of the `equipment_datasheet` answer (`data.review`, `data.codeResults`, `data.nozzles`) for the equipment data-sheet section.
// Defensive: a section the query could not compute arrives as `{ available: false, message }` and is shown as such, never dropped.

interface DatasheetIssue {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

interface DatasheetNozzle {
  readonly mark: string;
  readonly service: string | null;
  readonly dn: number | null;
  readonly rating: string | null;
}

export interface DatasheetView {
  readonly status: string;
  readonly reviewRequired: boolean;
  readonly reasons: readonly string[];
  readonly unverified: boolean;
  /** Check status (pass / warn / fail) or null when the check is unavailable. */
  readonly checkStatus: string | null;
  readonly issues: readonly DatasheetIssue[];
  /** Why a code-results section is missing (refused / not applicable), one message each. */
  readonly unavailable: readonly string[];
  readonly mawpMPa: number | null;
  readonly nozzles: readonly DatasheetNozzle[];
}

type Obj = Record<string, unknown>;
const asObj = (value: unknown): Obj => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : {});
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const rows = (value: unknown): Obj[] => (Array.isArray(value) ? value.map(asObj) : []);

function unavailableMessage(section: Obj, name: string): string | null {
  return section['available'] === false ? `${name}: ${text(section['message']) ?? 'not available'}` : null;
}

/** The view of a data-sheet answer, or null when the query did not return a sheet (legacy equipment, refusal). */
export function parseDatasheet(data: unknown): DatasheetView | null {
  const sheet = asObj(data);
  if (!('review' in sheet)) return null;
  const review = asObj(sheet['review']);
  const codeResults = asObj(sheet['codeResults']);
  const check = asObj(codeResults['check']);
  const thickness = asObj(codeResults['thickness']);
  const mawp = thickness['mawpMPa'];
  return {
    status: text(review['status']) ?? 'not_reviewed',
    reviewRequired: review['reviewRequired'] !== false,
    reasons: strings(review['reasons']),
    unverified: review['unverified'] === true,
    checkStatus: check['available'] === false ? null : text(check['status']),
    issues: rows(check['issues']).map((issue) => ({
      code: text(issue['code']) ?? '',
      severity: text(issue['severity']) ?? '',
      message: text(issue['message']) ?? '',
    })),
    unavailable: [unavailableMessage(check, 'Check'), unavailableMessage(thickness, 'Thickness')].flatMap((message) => message ?? []),
    mawpMPa: typeof mawp === 'number' ? mawp : null,
    nozzles: rows(sheet['nozzles']).map((row) => ({
      mark: text(row['mark']) ?? '',
      service: text(row['service']),
      dn: typeof row['dn'] === 'number' ? row['dn'] : null,
      rating: text(row['rating']),
    })),
  };
}
