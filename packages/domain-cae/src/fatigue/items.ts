/** Check / result items with stable codes (AF-11) shared by the fatigue and fracture commands. */

export type ItemSeverity = 'error' | 'fail' | 'warning' | 'info';

export interface Item {
  readonly code: string;
  readonly severity: ItemSeverity;
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

export const item = (code: string, severity: ItemSeverity, message: string, remediation: string, ids: readonly string[] = []): Item => ({
  code,
  severity,
  ids,
  message,
  remediation,
});

/** Overall status of a list of items: fail on any error / fail, warn on any warning, else pass. */
export const statusOfItems = (items: readonly Item[]): 'fail' | 'warn' | 'pass' =>
  items.some((entry) => entry.severity === 'error' || entry.severity === 'fail')
    ? 'fail'
    : items.some((entry) => entry.severity === 'warning')
      ? 'warn'
      : 'pass';

export const REVIEW_NOTE = 'Computed by llull, not approved: a qualified engineer must review before any certification decision.';
