/**
 * check_prototype roll-up (TECHNICAL_SPEC 5.7, spec 11 Q5): reviewer dispositions joined onto the items, the verdict and the owner summary.
 * @invariant an `accepted` disposition never changes an item status: an accepted fail reads "fail (accepted)" and still blocks the verdict
 * @invariant a disposition is stale when its inputsHash differs from the check's current hash, or its finding is no longer reported
 */

import { type CheckItem, type CheckStatus, findingKey, worstStatus } from '../../model/checkResult';
import type { Disposition } from '../../model/prototype';
import type { Accuracy } from '../../dynamics/accuracy';
import { hashText } from '../../lib/hash';
import { canonicalJson } from '../../lib/canonicalJson';
import { isRecord } from '../../lib/isRecord';

export type PrototypeCheckName = 'assembly' | 'mechanism' | 'motion_clearance' | 'dynamics';

export interface PrototypeItem extends CheckItem {
  /** Accuracy per value key (FR-FPR-70), physics outputs only; geometry checks state tolerances in provenance. */
  readonly accuracy?: Readonly<Record<string, Accuracy>>;
  readonly disposition?: Disposition & { readonly stale: boolean };
}

export interface PrototypeCheck {
  readonly check: PrototypeCheckName;
  readonly status: CheckStatus;
  readonly items: readonly PrototypeItem[];
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

export const isCheck = (data: unknown): data is PrototypeCheck =>
  isRecord(data) && typeof data['check'] === 'string' && Array.isArray(data['items']) && typeof data['inputsHash'] === 'string';

/** A check that did not run, with the reason as its one not_run item (an empty check is never a pass). */
export function skippedCheck(check: PrototypeCheckName, code: string, reason: string, remediation: string): PrototypeCheck {
  const item: PrototypeItem = {
    code,
    status: 'not_run',
    ids: [],
    findingKey: findingKey(check, code, []),
    values: {},
    remediation,
    unverified: true,
    note: reason,
  };
  return {
    check,
    status: 'not_run',
    items: [item],
    provenance: { method: `not run: ${reason}`, tolerances: {}, params: {} },
    inputsHash: hashText(canonicalJson({ check, skipped: code, reason })),
    unverified: true,
    reviewRequired: true,
  };
}

/** One check made of several sub-results (check_dynamics + timestep halving + reference comparison): items in order, one combined hash. */
export function mergeChecks(check: PrototypeCheckName, parts: readonly PrototypeCheck[]): PrototypeCheck {
  const items = parts.flatMap((part) => part.items);
  const engine = parts.find((part) => part.provenance.engine !== undefined)?.provenance.engine;
  return {
    check,
    status: items.length === 0 ? 'pass' : worstStatus(items.map((item) => item.status)),
    items,
    provenance: {
      method: parts.map((part) => part.provenance.method).join(' + '),
      ...(engine === undefined ? {} : { engine }),
      tolerances: Object.assign({}, ...parts.map((part) => part.provenance.tolerances)) as Record<string, number>,
      params: parts.map((part) => part.provenance.params),
    },
    inputsHash: parts.length === 1 ? (parts[0]?.inputsHash ?? '') : hashText(canonicalJson(parts.map((part) => part.inputsHash))),
    unverified: parts.some((part) => part.unverified),
    reviewRequired: true,
  };
}

/** The check with each item's disposition joined (stale when made on another inputsHash). */
export function withDispositions(check: PrototypeCheck, dispositions: Readonly<Record<string, Disposition>>): PrototypeCheck {
  return {
    ...check,
    items: check.items.map((item) => {
      const disposition = dispositions[item.findingKey];
      return disposition === undefined
        ? item
        : { ...item, disposition: { ...disposition, stale: disposition.inputsHash !== check.inputsHash } };
    }),
  };
}

/** Finding keys whose disposition is stale: made on another hash, or the finding is no longer reported. */
export function staleDispositions(checks: readonly PrototypeCheck[], dispositions: Readonly<Record<string, Disposition>>): string[] {
  const current = new Map(checks.flatMap((check) => check.items.map((item) => [item.findingKey, check.inputsHash] as const)));
  return Object.values(dispositions)
    .filter((disposition) => current.get(disposition.findingKey) !== disposition.inputsHash)
    .map((disposition) => disposition.findingKey)
    .sort();
}

export type Verdict = 'blocked' | 'ready_for_review';

/** blocked while any item fails (accepted or not, spec 11 Q5) or nothing could be checked (no parts, no kernel); a not_run item alone does not block. */
export function verdictOf(checks: readonly PrototypeCheck[]): Verdict {
  const fails = checks.some((check) => check.items.some((item) => item.status === 'fail'));
  const assembly = checks.find((check) => check.check === 'assembly');
  const nothing =
    assembly === undefined ||
    assembly.provenance.method.startsWith('not run') ||
    assembly.items.some((item) => item.code === 'FPR_NO_PARTS');
  return fails || nothing ? 'blocked' : 'ready_for_review';
}

const LABEL: Readonly<Record<PrototypeCheckName, string>> = {
  assembly: 'buildability',
  mechanism: 'mechanism',
  motion_clearance: 'clearance in motion',
  dynamics: 'dynamics and realism',
};

/** Largest stated relative band among the physics outputs, and whether any value is calibrated or has no band ("± ?"). */
function trustOf(checks: readonly PrototypeCheck[]): { count: number; largest: number | null; calibrated: boolean; unknown: boolean } {
  const all = checks.flatMap((check) => check.items.flatMap((item) => Object.values(item.accuracy ?? {})));
  const rels = all.flatMap((entry) => (entry.band !== null && 'rel' in entry.band ? [entry.band.rel] : []));
  return {
    count: all.length,
    largest: rels.length === 0 ? null : Math.max(...rels),
    calibrated: all.some((entry) => entry.origin === 'calibrated'),
    unknown: all.some((entry) => entry.band === null),
  };
}

export interface SummaryFacts {
  readonly parts: number;
  readonly dof: number | null;
  readonly durationS: number | null;
  readonly closestMm: number | null;
  readonly stale: number;
}

/** AF-36 owner summary: what was done, what passed (key numbers), what needs a human, how far to trust the numbers. */
export function ownerSummary(checks: readonly PrototypeCheck[], facts: SummaryFacts, verdict: Verdict): string {
  const items = checks.flatMap((check) => check.items);
  const fails = items.filter((item) => item.status === 'fail');
  const accepted = fails.filter((item) => item.disposition?.status === 'accepted').length;
  const warns = items.filter((item) => item.status === 'warn').length;
  // info (a touch, a calibration point) is never read as a pass
  const passed = checks.filter((check) => check.status === 'pass').map((check) => LABEL[check.check]);
  const notRun = checks.filter((check) => check.status === 'not_run').map((check) => LABEL[check.check]);
  const done =
    `Checked ${facts.parts} part(s)` +
    (facts.dof === null ? '' : `, a mechanism with ${facts.dof} degree(s) of freedom`) +
    (facts.durationS === null ? '' : `, ${Number(facts.durationS.toPrecision(3))} s of simulated motion`) +
    '.';
  const pass =
    passed.length === 0
      ? 'No check passed outright.'
      : `Passed: ${passed.join(', ')}${facts.closestMm === null ? '' : ` (closest approach in motion ${Number(facts.closestMm.toPrecision(3))} mm)`}.`;
  const human =
    fails.length + warns + facts.stale === 0 && notRun.length === 0
      ? 'Nothing is flagged for a human beyond the review itself.'
      : `Needs a human: ${fails.length} fail(s)${accepted > 0 ? ` (${accepted} accepted, still fails)` : ''}, ${warns} warning(s)` +
        `${facts.stale > 0 ? `, ${facts.stale} stale disposition(s)` : ''}${notRun.length > 0 ? `; not run: ${notRun.join(', ')}` : ''}.`;
  const trust = trustOf(checks);
  const trustParts = [
    ...(trust.calibrated ? ['some values are calibrated (matched by construction, not validation evidence)'] : []),
    ...(trust.largest === null ? [] : [`largest stated band ± ${Number((trust.largest * 100).toPrecision(3))} %`]),
    ...(trust.unknown ? ['some values have no stated band (± ?)'] : []),
    ...(trust.largest === null && !trust.unknown ? ['bands stated in absolute units only (see the items)'] : []),
  ];
  const trustText = trust.count === 0 ? 'No physics number carries an accuracy statement here.' : `Trust: ${trustParts.join('; ')}.`;
  return `${verdict === 'ready_for_review' ? 'Ready for review.' : 'Blocked.'} ${done} ${pass} ${human} ${trustText} Computed by llull, not approved — needs a qualified engineer.`;
}
