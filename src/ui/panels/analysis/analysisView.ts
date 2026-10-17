// Pure readers and labels for the Analysis panel: the recorded case data (set-up, mesh / results summaries) and the payloads of the
// read-only analysis queries (check_analysis / check_thermal, compute_margins, check_temperature_limits, fea_report). Nothing is
// recomputed here; `data` is read defensively and formatted for display.

import { isRecord } from '@lib/isRecord';
import type { AnalysisCase, AnalysisType, FeaLoad, ThermalBc, UnitSystem } from '@core/model/analysis';

export type StatusWord = 'pass' | 'warn' | 'fail';

export const ANALYSIS_TYPE_LABELS: Readonly<Record<AnalysisType, string>> = {
  static: 'Static structural',
  modal: 'Modal',
  buckling: 'Buckling',
  heat_steady: 'Steady thermal',
  heat_transient: 'Transient thermal',
  thermo_static: 'Thermo-static',
  coupled_temperature_displacement: 'Coupled thermo-mechanical',
};

export const isThermalCase = (type: AnalysisType): boolean => type === 'heat_steady' || type === 'heat_transient';

/** Force and stress units of a case unit system (loads are given in it). */
export function unitLabels(system: UnitSystem): { force: string; stress: string; length: string } {
  if (system === 'N-m-kg-s') return { force: 'N', stress: 'Pa', length: 'm' };
  if (system === 'lbf-in-slinch-s') return { force: 'lbf', stress: 'psi', length: 'in' };
  return { force: 'N', stress: 'MPa', length: 'mm' };
}

const format = (value: number, digits = 3): string => value.toLocaleString('en-US', { maximumSignificantDigits: digits });

export function formatNumber(value: number, digits = 3): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1e5 || Math.abs(value) < 1e-3) return value.toExponential(digits - 1);
  return format(value, digits);
}

/** "60 N along +X", "|F| 64.2 N" or "0.2 MPa" for one load. */
export function loadValue(load: FeaLoad, system: UnitSystem): string {
  const units = unitLabels(system);
  if (load.kind === 'pressure') return `${formatNumber(load.magnitude ?? 0)} ${units.stress}`;
  const vector = load.vector ?? [0, 0, 0];
  const magnitude = Math.hypot(...vector);
  const axisIndex = vector.findIndex((component) => Math.abs(component) === magnitude);
  const axisWord = axisIndex < 0 ? '' : ` along ${(vector[axisIndex] ?? 0) < 0 ? '−' : '+'}${'XYZ'[axisIndex] ?? ''}`;
  const unit = load.kind === 'gravity' ? `${units.length}/s²` : units.force;
  return `${formatNumber(magnitude)} ${unit}${axisWord}`;
}

const quantity = (q: { value: number; unit: string }): string => `${formatNumber(q.value)} ${q.unit}`;

export function thermalBcValue(bc: ThermalBc): string {
  switch (bc.kind) {
    case 'temperature':
    case 'surface_flux':
    case 'concentrated_flux':
      return quantity(bc.value);
    case 'heat_generation':
      return `${quantity(bc.value)} (${bc.mode})`;
    case 'film':
      return 'value' in bc.filmCoefficient
        ? `h ${quantity(bc.filmCoefficient)}, sink ${quantity(bc.sinkTemperature)}`
        : `h(T) table, sink ${quantity(bc.sinkTemperature)}`;
    case 'radiation':
      return `ε ${typeof bc.emissivity === 'number' ? formatNumber(bc.emissivity) : 'from property'}, sink ${quantity(bc.sinkTemperature)}`;
  }
}

export const THERMAL_BC_LABELS: Readonly<Record<ThermalBc['kind'], string>> = {
  temperature: 'Temperature',
  surface_flux: 'Heat flux',
  heat_generation: 'Heat generation',
  concentrated_flux: 'Point heat',
  film: 'Convection',
  radiation: 'Radiation',
};

/** What the panel says about a case from its recorded summaries alone (the artifacts may sit in a server store). */
export type CaseProgress = 'setup' | 'meshed' | 'solved';

export function caseProgress(analysis: AnalysisCase): CaseProgress {
  if (analysis.results !== undefined) return 'solved';
  return analysis.meshSummary !== undefined ? 'meshed' : 'setup';
}

export const PROGRESS_LABELS: Readonly<Record<CaseProgress, string>> = { setup: 'Set-up', meshed: 'Meshed', solved: 'Solved' };

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const statusWord = (value: unknown): StatusWord =>
  value === 'pass' || value === 'PASS' ? 'pass' : value === 'fail' || value === 'FAIL' ? 'fail' : 'warn';

interface CheckItemView {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly remediation: string;
}

export interface CheckView {
  readonly status: StatusWord;
  readonly state: string;
  readonly items: readonly CheckItemView[];
  readonly reviewReason?: string;
}

/** check_analysis / check_thermal payload. */
export function parseCheck(data: unknown): CheckView | null {
  if (!isRecord(data) || !Array.isArray(data['items'])) return null;
  const items = data['items']
    .filter(isRecord)
    .map(
      (item): CheckItemView => ({
        code: text(item['code']) ?? 'UNKNOWN',
        severity: item['severity'] === 'error' ? 'error' : 'warning',
        message: text(item['message']) ?? '',
        remediation: text(item['remediation']) ?? '',
      }),
    );
  const reason = text(data['reviewReason']);
  return {
    status: statusWord(data['status']),
    state: text(data['state']) ?? '',
    items,
    ...(reason === undefined ? {} : { reviewReason: reason }),
  };
}

interface MarginRowView {
  readonly rowId: string;
  readonly loadCase: string;
  readonly category: string;
  readonly check: string;
  readonly applied: number;
  readonly allowable: number;
  readonly allowableLabel: string;
  readonly factor: number;
  readonly ms: number;
  readonly status: StatusWord;
  readonly unverified: boolean;
}

export interface MarginsView {
  readonly rows: readonly MarginRowView[];
  readonly minMs: number | undefined;
  readonly factorsText: string;
}

/** compute_margins payload. Stress fields carry the unit in their name (appliedMPa, allowablePa …). */
export function parseMargins(data: unknown): MarginsView | null {
  if (!isRecord(data) || !Array.isArray(data['rows'])) return null;
  const pick = (row: Record<string, unknown>, prefix: string): number =>
    num(Object.entries(row).find(([key]) => key.startsWith(prefix) && key !== prefix)?.[1]) ?? Number.NaN;
  const rows = data['rows'].filter(isRecord).map((row): MarginRowView => {
    const allowable = isRecord(row['allowable']) ? row['allowable'] : {};
    return {
      rowId: text(row['rowId']) ?? '',
      loadCase: text(row['loadCase']) ?? '',
      category: text(row['category']) ?? '',
      check: text(row['check']) ?? '',
      applied: pick(row, 'applied'),
      allowable: pick(row, 'allowable'),
      allowableLabel: [text(allowable['property']), text(allowable['basis'])].filter((part) => part !== undefined).join(' · '),
      factor: num(row['factorApplied']) ?? 1,
      ms: num(row['ms']) ?? Number.NaN,
      status: statusWord(row['status']),
      unverified: row['unverified'] === true,
    };
  });
  const factors = isRecord(data['factors']) ? data['factors'] : {};
  const named = (key: string): string => {
    const factor = factors[key];
    return isRecord(factor) && typeof factor['value'] === 'number' ? `${key} ${factor['value']}` : '';
  };
  const extras = Array.isArray(factors['extra'])
    ? factors['extra'].filter(isRecord).map((extra) => `${text(extra['name']) ?? 'extra'} ${num(extra['value']) ?? ''}`)
    : [];
  return {
    rows,
    minMs: num(data['minMs']),
    factorsText: [named('ultimate'), named('yield'), ...extras].filter((part) => part !== '').join(' · '),
  };
}

export interface LimitRowView {
  readonly rowId: string;
  readonly name: string;
  readonly bound: string;
  readonly limit: string;
  readonly computed: string;
  readonly marginK: number | undefined;
  readonly status: StatusWord;
}

/** check_temperature_limits payload. */
export function parseTemperatureLimits(data: unknown): readonly LimitRowView[] | null {
  if (!isRecord(data) || !Array.isArray(data['rows'])) return null;
  const q = (value: unknown): string =>
    isRecord(value) && typeof value['value'] === 'number' && typeof value['unit'] === 'string'
      ? quantity({ value: value['value'], unit: value['unit'] })
      : '—';
  return data['rows']
    .filter(isRecord)
    .map(
      (row): LimitRowView => ({
        rowId: text(row['rowId']) ?? '',
        name: text(row['name']) ?? '',
        bound: text(row['bound']) ?? '',
        limit: q(row['limit']),
        computed: q(row['computed']),
        marginK: num(row['marginK']),
        status: statusWord(row['status']),
      }),
    );
}

export interface ProbeValueView {
  readonly probeId: string;
  readonly name: string;
  readonly unit: string;
  readonly values: readonly { readonly loadCase: string; readonly value: number }[];
}

/** fea_report probes (static cases). */
export function parseProbeValues(data: unknown): readonly ProbeValueView[] | null {
  if (!isRecord(data) || !Array.isArray(data['probes'])) return null;
  return data['probes']
    .filter(isRecord)
    .map(
      (probe): ProbeValueView => ({
        probeId: text(probe['probeId']) ?? '',
        name: text(probe['name']) ?? '',
        unit: text(probe['unit']) ?? '',
        values: Array.isArray(probe['values'])
          ? probe['values']
              .filter(isRecord)
              .map((entry) => ({ loadCase: text(entry['loadCase']) ?? '', value: num(entry['value']) ?? Number.NaN }))
          : [],
      }),
    );
}
