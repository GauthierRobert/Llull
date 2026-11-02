/**
 * Allowable displacement stress range and occasional limit (07 PST §5.6): f by edition, S_A by eq. (1a) / (1b), occasional factor.
 */

import { ruleRows, type RuleRow, type RuleSet } from './ruleSets';

export interface AllowableInput {
  readonly ScMPa: number;
  readonly ShMPa: number;
  readonly cycles: number;
  readonly sustainedStressMPa?: number | undefined;
  readonly ferrousLowStrength: boolean;
  readonly occasionalClass: 'default' | 'upTo10Percent' | 'upTo1Percent';
}

export interface Allowables {
  readonly fRaw: number;
  readonly fCap: number;
  readonly f: number;
  readonly limited: 'none' | 'cap' | 'floor';
  readonly SA1aMPa: number;
  readonly SA1bMPa: number | null;
  readonly SAMPa: number;
  readonly equation: '1a' | '1b';
  readonly occasionalFactor: number;
  readonly occasionalMPa: number;
  readonly rules: readonly RuleRow[];
}

/** Raw stress range reduction factor for N full-range cycles. */
export const rawF = (set: RuleSet, cycles: number): number => (set.fForm === 'n-1/3' ? 20 * cycles ** (-1 / 3) : 6 * cycles ** -0.2);

/**
 * @invariant f = min(raw, cap) then max(floor); eq. (1b) governs only when S_L is given and S_h > S_L (liberal form); both equations are returned
 */
export function computeAllowables(set: RuleSet, input: AllowableInput): Allowables {
  const fRaw = rawF(set, input.cycles);
  const fCap = input.ferrousLowStrength ? set.fCapLowStrength : 1;
  const capped = Math.min(fRaw, fCap);
  const f = Math.max(capped, set.fFloor);
  const limited = capped < fRaw ? 'cap' : f > capped ? 'floor' : 'none';
  const { ScMPa: sc, ShMPa: sh, sustainedStressMPa: sl } = input;
  const SA1a = f * (1.25 * sc + 0.25 * sh);
  const SA1b = sl === undefined ? null : f * (1.25 * (sc + sh) - sl);
  const useB = SA1b !== null && sl !== undefined && sh > sl;
  const occasionalFactor = set.occasionalFactors[input.occasionalClass];
  const formRow = set.code === 'B31.1' ? 'B311-F' : set.fForm === 'n-1/3' ? 'B313-F-2022' : 'B313-F-PRE2022';
  return {
    fRaw,
    fCap,
    f,
    limited,
    SA1aMPa: SA1a,
    SA1bMPa: SA1b,
    SAMPa: useB ? (SA1b as number) : SA1a,
    equation: useB ? '1b' : '1a',
    occasionalFactor,
    occasionalMPa: occasionalFactor * sh,
    rules: ruleRows(formRow, 'B313-SA-1A', ...(SA1b === null ? [] : ['B313-SA-1B']), set.code === 'B31.1' ? 'B311-OCC' : 'B313-OCC'),
  };
}
