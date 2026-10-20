// Readiness checklist model (FR-FPR-50): which stable finding codes (spec §7.1) feed which row, worst-status roll-up, and the unit/threshold text.
// Pure presentation derivation over the check envelope; no document access.

import type { Accuracy, CheckItem, CheckName, CheckResult, CheckStatus } from './reviewTypes';

/** Check status plus `stale` (the document changed after the run). */
export type DisplayStatus = CheckStatus | 'stale';

export const STATUS_GLYPH: Readonly<Record<DisplayStatus, string>> = {
  pass: '✔',
  warn: '▲',
  fail: '✖',
  not_run: '○',
  stale: '◌',
  info: 'ℹ',
};
export const STATUS_WORD: Readonly<Record<DisplayStatus, string>> = {
  pass: 'pass',
  warn: 'warn',
  fail: 'fail',
  not_run: 'not run',
  stale: 'stale',
  info: 'info',
};

interface RowSpec {
  readonly id: string;
  readonly label: string;
  readonly check: CheckName;
  /** Finding codes the row owns; absent = every item of the check. */
  readonly codes?: readonly string[];
  /** Solver self-checks are grouped apart from "Matches reality" so verification is never read as validation. */
  readonly group: 'checks' | 'selfchecks';
}

const ROW_SPECS: readonly RowSpec[] = [
  {
    id: 'solid',
    label: 'Parts are solid',
    check: 'assembly',
    codes: ['FPR_PART_INVALID', 'FPR_PART_EMPTY', 'FPR_PART_DISCONNECTED', 'FPR_PART_SHEET'],
    group: 'checks',
  },
  {
    id: 'interference',
    label: 'No interference',
    check: 'assembly',
    codes: ['FPR_PAIR_HARD', 'FPR_PAIR_CONTAINED', 'FPR_PAIR_TOUCH', 'FPR_PAIR_CLEARANCE', 'FPR_PAIR_ALLOWED'],
    group: 'checks',
  },
  { id: 'wall', label: 'Wall thickness', check: 'assembly', codes: ['FPR_WALL_THIN'], group: 'checks' },
  { id: 'connected', label: 'Connected', check: 'assembly', codes: ['FPR_PART_FLOATING', 'FPR_PART_RESTING_ONLY'], group: 'checks' },
  {
    id: 'joints',
    label: 'Joints realised',
    check: 'assembly',
    codes: ['FPR_JOINT_NOT_REALISED', 'FPR_JOINT_REALISED', 'FPR_KERNEL_UNSUPPORTED'],
    group: 'checks',
  },
  { id: 'dof', label: 'Moves (DOF)', check: 'mechanism', group: 'checks' },
  { id: 'clearance', label: 'Clearance in motion', check: 'motion_clearance', group: 'checks' },
  {
    id: 'realistic',
    label: 'Realistic inputs',
    check: 'dynamics',
    codes: ['FPR_MASS_DEFAULTED', 'FPR_UNREALISTIC', 'FPR_OUTSIDE_VALIDATED_RANGE'],
    group: 'checks',
  },
  {
    id: 'reality',
    label: 'Matches reality',
    check: 'dynamics',
    codes: ['FPR_REFERENCE_MISMATCH', 'FPR_REFERENCE_MATCH', 'FPR_CALIBRATION_FAILED', 'FPR_NO_LOSSES'],
    group: 'checks',
  },
  {
    id: 'loops',
    label: 'Loops closed',
    check: 'dynamics',
    codes: ['FPR_LOOP_PRISMATIC', 'FPR_LOOP_OPEN', 'FPR_REDUNDANT_CONSTRAINT', 'FPR_LOOP_DRIFT'],
    group: 'selfchecks',
  },
  { id: 'energy', label: 'Cycle energy', check: 'dynamics', codes: ['FPR_ENERGY_CLOSURE'], group: 'selfchecks' },
  { id: 'timestep', label: 'Timestep', check: 'dynamics', codes: ['FPR_TIMESTEP_SENSITIVE'], group: 'selfchecks' },
];

export interface ChecklistRowModel {
  readonly id: string;
  readonly label: string;
  readonly group: RowSpec['group'];
  readonly check: CheckName;
  readonly status: DisplayStatus;
  readonly items: readonly CheckItem[];
  /** The most severe item: its value and threshold headline the row. */
  readonly headline: CheckItem | null;
}

const SEVERITY: Readonly<Record<CheckStatus, number>> = { info: -1, pass: 0, not_run: 1, warn: 2, fail: 3 };

function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst), 'pass');
}

export function severityOf(status: CheckStatus): number {
  return SEVERITY[status];
}

function rowStatus(result: CheckResult | undefined, items: readonly CheckItem[]): CheckStatus {
  if (result === undefined) return 'not_run';
  // a check that did not run at all reports one partless not_run item (its reason); a single unrun finding only affects its own row
  if (result.status === 'not_run' && result.items.every((item) => item.status === 'not_run' && item.ids.length === 0)) return 'not_run';
  if (items.length === 0) return 'pass';
  // calibration points and touches are information: the row says so instead of turning green
  if (items.every((item) => item.status === 'info')) return 'info';
  // an unrun item (kernel lacks the axis) keeps the row "not run" unless something worse is known
  return worstStatus(items.map((item) => item.status));
}

/** One row per readiness check; `stale` greys every row (◌) because the numbers no longer match the document. */
export function buildChecklist(checks: readonly CheckResult[], stale: boolean): ChecklistRowModel[] {
  return ROW_SPECS.map((spec) => {
    const result = checks.find((c) => c.check === spec.check);
    const items = (result?.items ?? []).filter((item) => spec.codes === undefined || spec.codes.includes(item.code));
    const status = rowStatus(result, items);
    const headline = items.reduce<CheckItem | null>(
      (worst, item) => (worst === null || SEVERITY[item.status] > SEVERITY[worst.status] ? item : worst),
      null,
    );
    return { id: spec.id, label: spec.label, group: spec.group, check: spec.check, status: stale ? 'stale' : status, items, headline };
  });
}

/** Roll-up light over every check, after stale. */
export function overallStatus(checks: readonly CheckResult[], stale: boolean): DisplayStatus {
  if (stale) return 'stale';
  return checks.length === 0 ? 'not_run' : worstStatus(checks.map((c) => c.status));
}

/** An accepted disposition is recorded but never turns a fail into a pass: it reads "fail (accepted)". */
export function itemStatusLabel(item: CheckItem): string {
  const word = STATUS_WORD[item.status];
  if (item.status !== 'pass' && item.disposition?.status === 'accepted')
    return `${word} (accepted${item.disposition.stale ? ', stale' : ''})`;
  return word;
}

const UNIT_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['Mm3', 'mm³'],
  ['Mm2', 'mm²'],
  ['Mm', 'mm'],
  ['Nm', 'N·m'],
  ['Pa', 'Pa'],
  ['Kg', 'kg'],
  ['Deg', '°'],
  ['Rpm', 'rpm'],
  ['Pct', '%'],
  ['S', 's'],
  ['N', 'N'],
];

/** `overlapVolumeMm3` → { label: 'overlap volume', unit: 'mm³' }. */
export function describeValueKey(key: string): { label: string; unit: string } {
  const suffix = UNIT_SUFFIXES.find(([ending]) => key.endsWith(ending) && key.length > ending.length);
  const stem = suffix === undefined ? key : key.slice(0, key.length - suffix[0].length);
  const label = stem.replace(/([A-Z])/g, ' $1').toLowerCase();
  return { label, unit: suffix?.[1] ?? '' };
}

const formatNumber = (value: number): string => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(3))));

export function formatValue(key: string, value: number): string {
  const { unit } = describeValueKey(key);
  return unit === '' ? formatNumber(value) : `${formatNumber(value)} ${unit}`;
}

/** The item's first value as "overlap volume 12.5 mm³", or null. */
export function headlineValue(item: CheckItem): string | null {
  const first = Object.entries(item.values)[0];
  if (first === undefined) return null;
  return `${describeValueKey(first[0]).label} ${formatValue(first[0], first[1])}`;
}

/** The accuracy of the item's headline value (its first value with one), or null when the item states none. */
export function headlineAccuracy(item: CheckItem): Accuracy | null {
  const accuracy = item.accuracy ?? {};
  const key = Object.keys(item.values).find((candidate) => accuracy[candidate] !== undefined);
  return (key === undefined ? Object.values(accuracy)[0] : accuracy[key]) ?? null;
}

/** "≥ 0.794 mm (cnc_metal, Xometry; default)" style threshold text, or null. */
export function formatThreshold(item: CheckItem): string | null {
  const t = item.threshold;
  if (t === undefined) return null;
  return `limit ${formatNumber(t.value)} ${t.unit} (${t.source}, grade ${t.grade}${t.defaulted ? ', default' : ''})`;
}

/** Plain-language title of a finding code, for badges and highlights on the model. */
const FINDING_TITLES: Readonly<Record<string, string>> = {
  FPR_PART_INVALID: 'Invalid solid',
  FPR_PART_EMPTY: 'Empty part',
  FPR_PART_DISCONNECTED: 'Part in pieces',
  FPR_PART_SHEET: 'Open surface, not a solid',
  FPR_PAIR_HARD: 'Parts overlap',
  FPR_PAIR_CONTAINED: 'Part inside another',
  FPR_PAIR_TOUCH: 'Parts touch',
  FPR_PAIR_CLEARANCE: 'Too close',
  FPR_PAIR_ALLOWED: 'Overlap allowed',
  FPR_WALL_THIN: 'Wall too thin',
  FPR_PART_FLOATING: 'Floating part',
  FPR_PART_RESTING_ONLY: 'Only resting, not fixed',
  FPR_JOINT_NOT_REALISED: 'Joint not realised',
  FPR_MASS_DEFAULTED: 'Mass assumed',
  FPR_UNREALISTIC: 'Unrealistic input',
  FPR_OUTSIDE_VALIDATED_RANGE: 'Outside validated range',
  FPR_REFERENCE_MISMATCH: 'Differs from reference',
  FPR_CALIBRATION_FAILED: 'Calibration failed',
  FPR_NO_LOSSES: 'No losses modelled',
  FPR_MECH_LOCKED: 'Mechanism locked',
  FPR_MECH_UNDERCONSTRAINED: 'Free motion not driven',
  FPR_MECH_OK: 'Mobility matches the drives',
  FPR_MECH_NONE: 'No mechanism',
  FPR_MOTION_INTERFERENCE: 'Parts collide in motion',
  FPR_MOTION_CLEARANCE_LOW: 'Too close in motion',
  FPR_MOTION_TOUCH: 'Parts touch in motion',
  FPR_MOTION_ALLOWED: 'Contact allowed',
  FPR_MOTION_UNDERSAMPLED: 'Motion undersampled',
  FPR_NO_MOTION: 'Nothing moves to check',
  FPR_LOOP_PRISMATIC: 'Prismatic joint inside a loop',
  FPR_LOOP_OPEN: 'Loop does not close',
  FPR_REDUNDANT_CONSTRAINT: 'Redundant constraint',
  FPR_LOOP_DRIFT: 'Loop drifts open in the run',
  FPR_ENERGY_CLOSURE: 'Energy does not balance',
  FPR_TIMESTEP_SENSITIVE: 'Result depends on the timestep',
  FPR_SPHERICAL_TREE: 'Spherical joint chain unsupported',
  FPR_JOINT_DANGLING: 'Joint connects nothing',
};

/** The title of `code`, else the checklist row it belongs to, else the code itself. */
export function findingTitle(code: string): string {
  return FINDING_TITLES[code] ?? ROW_SPECS.find((spec) => spec.codes?.includes(code))?.label ?? code;
}
