/** The verification ladder every host-produced record command shares (05 §4.1): fetch -> unverified fallback -> stale -> recompute -> compare. */

import type { CommandResult } from '@core/commands/types';
import { differingKeys, type Fetched } from './trust';

export type Verified<A, S> =
  | { readonly outcome: 'refused'; readonly result: CommandResult }
  | { readonly outcome: 'unverified' }
  | { readonly outcome: 'verified'; readonly artifact: A; readonly expected: S };

/**
 * @invariant order: sha256 mismatch refuses; absent artifact without a usable given summary refuses `notFoundCode`, with one yields
 *   `unverified`; then `staleMessage`, the recomputed summary (a string is a refusal message) and the given summary comparison
 */
export function verifyAndRecord<A, S extends object>(args: {
  readonly fetched: Fetched<A>;
  readonly summary: object | undefined;
  /** The given summary carries the artifact hash and a text input hash, so it can be kept flagged unverified. */
  readonly keepable: boolean;
  readonly mismatchCode: string;
  readonly notFoundCode: string;
  readonly stale: (artifact: A) => { readonly code: string; readonly message: string } | null;
  readonly recompute: (artifact: A) => S | string;
  readonly fail: (code: string, message: string) => CommandResult;
}): Verified<A, S> {
  const { fetched, summary, fail } = args;
  const refused = (code: string, message: string): Verified<A, S> => ({ outcome: 'refused', result: fail(code, message) });
  if ('code' in fetched) {
    if (fetched.code.endsWith('_SUMMARY_MISMATCH')) return refused(args.mismatchCode, fetched.message);
    return args.keepable ? { outcome: 'unverified' } : refused(args.notFoundCode, fetched.message);
  }
  const { artifact } = fetched;
  const stale = args.stale(artifact);
  if (stale !== null) return refused(stale.code, stale.message);
  const expected = args.recompute(artifact);
  if (typeof expected === 'string') return refused(args.mismatchCode, expected);
  const differing = summary === undefined ? [] : differingKeys(summary, expected);
  if (differing.length > 0)
    return refused(args.mismatchCode, `the summary differs from the one recomputed from the artifact in: ${differing.join(', ')}`);
  return { outcome: 'verified', artifact, expected };
}
