/**
 * Agent-first result envelope of the PHY-21 prototype checks (TECHNICAL_SPEC 3.4): every query returns `CheckResult` in `data`.
 * Lengths are millimetres, volumes mm3 (keys carry their unit), regardless of the document unit.
 */

import type { Vec3 } from './vectors';

/** `info` never counts against a check; `not_run` is never a pass. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_run' | 'info';

export interface CheckThreshold {
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly grade: 'A' | 'B' | 'C';
  /** True when the value was picked by the tool (a process table, a default tolerance), not given by the caller. */
  readonly defaulted: boolean;
}

export interface CheckItem {
  /** Stable `FPR_*` code. */
  readonly code: string;
  readonly status: CheckStatus;
  /** Entities / instances / joints concerned (sorted). */
  readonly ids: readonly string[];
  /** `${check}:${code}:${sorted ids}` — stable across runs. */
  readonly findingKey: string;
  readonly values: Readonly<Record<string, number>>;
  readonly threshold?: CheckThreshold;
  readonly witness?: { readonly pointsMm: readonly Vec3[]; readonly timeS?: number; readonly crankDeg?: number };
  readonly remediation: string;
  /** Declared intent that turned an overlap into an allowed pair. */
  readonly intent?: { readonly id: string; readonly kind: string; readonly reason: string; readonly declaredBy: string };
  /** The numbers are approximate or depend on an assumption stated in `note`. */
  readonly unverified?: boolean;
  readonly note?: string;
}

interface CheckProvenance {
  readonly method: string;
  readonly kernel?: string;
  readonly engine?: string;
  readonly tolerances: Readonly<Record<string, number>>;
  readonly params: unknown;
}

export interface CheckResult {
  readonly check: 'assembly' | 'motion_clearance';
  /** Worst item: fail > not_run > warn > pass > info. */
  readonly status: CheckStatus;
  readonly items: readonly CheckItem[];
  readonly provenance: CheckProvenance;
  readonly inputsHash: string;
  /** Some item could not be verified (`not_run`, approximate). */
  readonly unverified: boolean;
  readonly reviewRequired: true;
}

const RANK: Readonly<Record<CheckStatus, number>> = { info: 0, pass: 1, warn: 2, not_run: 3, fail: 4 };

/** Worst status of `statuses` (`pass` when empty). */
export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((worst, status) => (RANK[status] > RANK[worst] ? status : worst), 'pass');
}

export function findingKey(check: string, code: string, ids: readonly string[]): string {
  return `${check}:${code}:${[...ids].sort().join(',')}`;
}
