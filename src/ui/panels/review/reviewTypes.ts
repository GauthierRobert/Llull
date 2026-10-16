// Review-tab result types, mirroring PHY-21 TECHNICAL_SPEC §3.4 (check result envelope) and §3.3 (Disposition). Defined locally until
// check_prototype / set_review_disposition exist in the registry; the shapes are the contract, so wiring later is a no-op.

import { isRecord } from '@lib/isRecord';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_run';
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
  readonly checks: readonly CheckResult[];
}

const STATUSES: readonly unknown[] = ['pass', 'warn', 'fail', 'not_run'];

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
  return {
    checks: data['checks'],
    ...(typeof verdict === 'string' ? { verdict } : {}),
    ...(typeof ownerSummary === 'string' ? { ownerSummary } : {}),
  };
}
