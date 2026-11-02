/** Findings shared by the checks of every equipment template (`check_equipment`): the issue record, its severity and the element check result. */

import type { EquipmentElement } from '@aec/building/types';
import { remediationOf } from '../model';
import type { CodeFinding } from './asme';

export type IssueSeverity = 'fail' | 'warning';

export interface EquipmentIssue {
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

export interface ElementCheck {
  readonly issues: EquipmentIssue[];
  /** True when a code thickness / MAWP was computed for this equipment (pressure equipment: the result needs a qualified review). */
  readonly reviewRequired: boolean;
  /** Why a review is required (names the standard); the vessel path leaves it to the command. */
  readonly reviewReason?: string;
  /** What the check does not cover (named, so a clean result is not read as a full design review). */
  readonly notChecked?: readonly string[];
}

export interface Found {
  readonly severity: IssueSeverity;
  readonly finding: CodeFinding;
}

/** Codes of a thickness-calculation refusal that a check reports as a warning (the part cannot be judged by the MVP formulas). */
export const COVERAGE_CODES: readonly string[] = [
  'EQP_DESIGN_DATA_MISSING',
  'EQP_ALLOWABLE_MISSING',
  'EQP_FORMULA_OUT_OF_RANGE',
  'EQP_HEAD_NOT_COVERED',
  'EQP_PARAM_INVALID',
  'EQP_API650_ONE_FOOT_LIMIT',
  'EQP_MATERIAL_NOT_IN_TABLE',
  'EQP_COURSES_MISMATCH',
];

/** The issues of `found` for `element` (message prefixed with the tag, remediation from the code table). */
export const issuesOf = (element: EquipmentElement, found: readonly Found[]): EquipmentIssue[] =>
  found.map(({ severity, finding }) => ({
    code: finding.code,
    severity,
    ids: [element.id],
    paths: finding.paths,
    message: `${element.mark}: ${finding.message}`,
    remediation: remediationOf(finding.code),
  }));

export const warning = (code: string, message: string, ...paths: string[]): Found => ({
  severity: 'warning',
  finding: { code, message, paths },
});
