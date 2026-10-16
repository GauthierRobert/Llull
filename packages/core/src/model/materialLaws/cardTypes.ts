/** Shared types of the solver card writers (PHY-02 §6). */

import type { MaterialModel, SetSlot } from '../materialModel';
import type { PropertyRecord } from '../propertyModelEval';
import type { MatlIssue } from './issues';

export interface CardRequest {
  readonly record: PropertyRecord;
  readonly slots: Readonly<Partial<Record<SetSlot, MaterialModel>>>;
  /** Card name (`*MATERIAL,NAME=`). */
  readonly name: string;
  /** Nastran material id. */
  readonly mid: number;
  /** Temperatures (K) the parameters are written at; empty = a single row without temperature. */
  readonly temperaturesK: readonly number[];
}

export interface CardOutput {
  readonly lines: readonly string[];
  /** Non-blocking findings (e.g. MATL_INCOMPRESSIBLE_DEFAULT). */
  readonly warnings: readonly MatlIssue[];
  /** Names of the named defaults the writer applied. */
  readonly usedDefaults: readonly string[];
  /** Property models read while evaluating parameters, with the reasons their values are unverified. */
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: boolean;
}
