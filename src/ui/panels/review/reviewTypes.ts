// Review-tab result types, mirroring PHY-21 TECHNICAL_SPEC §3.4 (check result envelope) and §3.3 (Disposition), as returned by
// check_prototype (core types are not imported: the tab also reads results saved by an older llull).

import { isRecord } from '@lib/isRecord';

/** `info` never counts against a check (a touch, a calibration point): it is never shown as a pass. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_run' | 'info';
export type CheckName = 'assembly' | 'mechanism' | 'motion_clearance' | 'dynamics';
export type DispositionStatus = 'not_reviewed' | 'relevant' | 'irrelevant' | 'accepted';

export const CHECK_NAMES: readonly CheckName[] = ['assembly', 'mechanism', 'motion_clearance', 'dynamics'];
export const DISPOSITION_STATUSES: readonly DispositionStatus[] = ['not_reviewed', 'relevant', 'irrelevant', 'accepted'];

export interface Accuracy {
  readonly band: { readonly rel: number } | { readonly abs: number; readonly unit: string } | null;
  readonly basis: string;
  readonly origin: 'input' | 'calibrated' | 'predicted' | 'verification';
  readonly validationLevel: 0 | 1 | 2 | 3 | 4;
  readonly comparison?: {
    readonly referenceId: string;
    readonly s: number;
    readonly d: number;
    readonly e: number;
    readonly uVal: number | null;
  };
  readonly warnings: readonly string[];
}

interface ItemDisposition {
  readonly status: DispositionStatus;
  readonly comment: string;
  readonly by: 'agent' | 'human';
  readonly stale: boolean;
}

interface CheckThreshold {
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly grade: 'A' | 'B' | 'C';
  readonly defaulted: boolean;
}

export interface CheckItem {
  readonly code: string;
  readonly status: CheckStatus;
  readonly ids: readonly string[];
  readonly findingKey: string;
  readonly values: Readonly<Record<string, number>>;
  readonly accuracy?: Readonly<Record<string, Accuracy>>;
  readonly threshold?: CheckThreshold;
  readonly witness?: {
    readonly pointsMm: ReadonlyArray<readonly [number, number, number]>;
    readonly timeS?: number;
    readonly crankDeg?: number;
  };
  readonly remediation: string;
  readonly unverified?: boolean;
  readonly disposition?: ItemDisposition;
}

export interface CheckResult {
  readonly check: CheckName;
  readonly status: CheckStatus;
  readonly items: readonly CheckItem[];
  readonly provenance: {
    readonly method: string;
    readonly kernel?: string;
    readonly engine?: string;
    readonly tolerances: Readonly<Record<string, number>>;
    readonly params: unknown;
  };
  readonly inputsHash: string;
  readonly unverified: boolean;
  readonly reviewRequired: true;
}

/** `check_prototype` data: the four checks plus the roll-up text. */
export interface PrototypeReview {
  readonly verdict?: string;
  readonly ownerSummary?: string;
  /** Finding keys whose disposition was made on other inputs (or whose finding is gone): listed for re-review. */
  readonly staleDispositions?: readonly string[];
  /** Simulated seconds of the review run (null when the motion checks were skipped). */
  readonly durationS?: number | null;
  readonly checks: readonly CheckResult[];
}

const STATUSES: readonly unknown[] = ['pass', 'warn', 'fail', 'not_run', 'info'];

function isCheckResult(value: unknown): value is CheckResult {
  return (
    isRecord(value) &&
    CHECK_NAMES.some((name) => name === value['check']) &&
    STATUSES.includes(value['status']) &&
    Array.isArray(value['items']) &&
    isRecord(value['provenance'])
  );
}

/** `check_prototype` result data → typed review, or null when the shape is not recognised. */
export function parsePrototypeReview(data: unknown): PrototypeReview | null {
  if (!isRecord(data) || !Array.isArray(data['checks']) || !data['checks'].every(isCheckResult)) return null;
  const verdict = data['verdict'];
  const ownerSummary = data['ownerSummary'];
  const stale: unknown = data['staleDispositions'];
  const durationS = data['durationS'];
  return {
    checks: data['checks'],
    ...(typeof verdict === 'string' ? { verdict } : {}),
    ...(typeof ownerSummary === 'string' ? { ownerSummary } : {}),
    ...(typeof durationS === 'number' || durationS === null ? { durationS } : {}),
    ...(Array.isArray(stale) && stale.every((key) => typeof key === 'string') ? { staleDispositions: stale } : {}),
  };
}
