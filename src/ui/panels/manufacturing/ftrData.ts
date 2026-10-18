// Pure readers of the manufacturing query payloads (flat_pattern, check_sheet_metal / check_machining, hole_table). The UI never
// recomputes them; it only reads `data` defensively and sorts/formats for display.

import { isRecord } from '@lib/isRecord';
import type { ProvenanceEntry } from '@ui/panels/ProvenancePopover';

export interface FtrFindingView {
  readonly code: string;
  readonly severity: 'fail' | 'warn' | 'info';
  readonly ids: readonly string[];
  readonly value?: number;
  readonly limit?: number;
  readonly unit?: string;
  readonly source?: string;
  readonly remediation: string;
}

interface FtrMetaView {
  readonly unverified: boolean;
  readonly reviewRequired: boolean;
  readonly reviewReason?: string;
  readonly provenance: readonly ProvenanceEntry[];
}

export interface FtrCheckView extends FtrMetaView {
  readonly status: string;
  readonly findings: readonly FtrFindingView[];
  readonly rulesSkipped: readonly string[];
}

interface FlatBendView {
  readonly id: string;
  readonly angleDeg: number;
  readonly insideRadius: number;
  readonly direction: string;
  readonly ba: number;
  readonly k: string;
  readonly kSource: string;
}

export interface FlatPatternView extends FtrMetaView {
  readonly extents: readonly [number, number];
  readonly area: number;
  readonly outline: ReadonlyArray<readonly [number, number]>;
  readonly bends: readonly FlatBendView[];
  readonly unit: string;
}

export interface HoleRowView {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly kind: string;
  readonly diameter: number;
  /** Hole centre in part coordinates (hole_table `at`), when reported. */
  readonly at?: readonly [number, number, number];
  readonly cskAngleDeg?: number;
  readonly cskDiameter?: number;
  readonly depth: string;
  readonly thread?: string;
}

export type HoleSortKey = 'label' | 'x' | 'y' | 'kind' | 'diameter' | 'depth';

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

function provenanceEntries(value: unknown, unverifiedInputs: unknown): ProvenanceEntry[] {
  const entries: ProvenanceEntry[] = [];
  if (isRecord(value)) {
    if (isRecord(value['formulas']))
      for (const [name, formula] of Object.entries(value['formulas'])) entries.push({ label: `Formula ${name}`, value: String(formula) });
    if (isRecord(value['inputs']))
      for (const [name, input] of Object.entries(value['inputs'])) {
        if (!isRecord(input)) continue;
        const unit = str(input['unit']);
        const defaulted = input['defaulted'] === true ? ' (defaulted)' : '';
        entries.push({
          label: `Input ${name}`,
          value: `${String(input['value'])}${unit === undefined ? '' : ` ${unit}`}${defaulted} — ${str(input['source']) ?? 'no source'}`,
        });
      }
    for (const source of strings(value['sources'])) entries.push({ label: 'Source', value: source });
  }
  if (Array.isArray(unverifiedInputs))
    for (const input of unverifiedInputs.filter(isRecord))
      entries.push({
        label: `Unverified ${str(input['kind']) ?? 'input'}`,
        value: `${str(input['id']) ?? ''} — ${str(input['source']) ?? ''}`,
      });
  return entries;
}

function metaOf(data: Record<string, unknown>): FtrMetaView {
  const reviewReason = str(data['reviewReason']);
  return {
    unverified: data['unverified'] === true,
    reviewRequired: data['reviewRequired'] === true,
    ...(reviewReason === undefined ? {} : { reviewReason }),
    provenance: provenanceEntries(data['provenance'], data['unverifiedInputs']),
  };
}

export function parseCheck(data: unknown): FtrCheckView | null {
  if (!isRecord(data) || !Array.isArray(data['findings'])) return null;
  const findings = data['findings'].filter(isRecord).map((item): FtrFindingView => {
    const [value, limit, unit, source] = [num(item['value']), num(item['limit']), str(item['unit']), str(item['source'])];
    const severity = item['severity'] === 'fail' || item['severity'] === 'warn' ? item['severity'] : 'info';
    return {
      code: str(item['code']) ?? 'UNKNOWN',
      severity,
      ids: strings(item['ids']),
      ...(value === undefined ? {} : { value }),
      ...(limit === undefined ? {} : { limit }),
      ...(unit === undefined ? {} : { unit }),
      ...(source === undefined ? {} : { source }),
      remediation: str(item['remediation']) ?? '',
    };
  });
  const rulesSkipped = Array.isArray(data['rulesSkipped'])
    ? data['rulesSkipped'].filter(isRecord).map((r) => `${str(r['rule']) ?? '?'}: ${str(r['code']) ?? ''}`)
    : [];
  return { status: str(data['status']) ?? 'pass', findings, rulesSkipped, ...metaOf(data) };
}

export function parseFlatPattern(data: unknown): FlatPatternView | null {
  if (!isRecord(data) || !Array.isArray(data['extents'])) return null;
  const [width, height] = [num(data['extents'][0]), num(data['extents'][1])];
  if (width === undefined || height === undefined) return null;
  const outline = (Array.isArray(data['outline']) ? data['outline'] : []).flatMap((p): Array<readonly [number, number]> => {
    const [x, y] = Array.isArray(p) ? [num(p[0]), num(p[1])] : [undefined, undefined];
    return x === undefined || y === undefined ? [] : [[x, y]];
  });
  const bends = (Array.isArray(data['bends']) ? data['bends'] : []).filter(isRecord).map((bend): FlatBendView => {
    const k = bend['kFactor'];
    return {
      id: str(bend['id']) ?? '',
      angleDeg: num(bend['angleDeg']) ?? 0,
      insideRadius: num(bend['insideRadius']) ?? 0,
      direction: str(bend['direction']) ?? '',
      ba: num(bend['ba']) ?? 0,
      k: isRecord(k) ? String(k['value']) : '',
      kSource: isRecord(k) ? `K ${String(k['value'])} — ${str(k['source']) ?? ''}` : '',
    };
  });
  return { extents: [width, height], area: num(data['area']) ?? 0, outline, bends, unit: str(data['lengthUnit']) ?? '', ...metaOf(data) };
}

export function parseHoleRows(data: unknown): HoleRowView[] | null {
  if (!isRecord(data) || !Array.isArray(data['rows'])) return null;
  return data['rows'].filter(isRecord).map((row): HoleRowView => {
    const [angle, cskDiameter, depth, thread] = [num(row['cskAngleDeg']), num(row['cskDiameter']), num(row['depth']), str(row['thread'])];
    const raw: unknown[] = Array.isArray(row['at']) ? row['at'] : [];
    const [ax, ay, az] = raw;
    const at = typeof ax === 'number' && typeof ay === 'number' && typeof az === 'number' ? ([ax, ay, az] as const) : null;
    return {
      label: str(row['label']) ?? '',
      x: num(row['x']) ?? 0,
      y: num(row['y']) ?? 0,
      kind: str(row['subtype']) ?? 'simple',
      diameter: num(row['diameter']) ?? 0,
      ...(at === null ? {} : { at }),
      ...(angle === undefined ? {} : { cskAngleDeg: angle }),
      ...(cskDiameter === undefined ? {} : { cskDiameter }),
      depth: row['through'] === true ? 'through' : depth === undefined ? '' : String(depth),
      ...(thread === undefined ? {} : { thread }),
    };
  });
}

const depthValue = (row: HoleRowView): number => (row.depth === 'through' ? Number.POSITIVE_INFINITY : Number(row.depth) || 0);

/** Sorts a copy; `label` compares numerically on its digits (H2 before H10). */
export function sortHoleRows(rows: readonly HoleRowView[], key: HoleSortKey, ascending: boolean): HoleRowView[] {
  const sign = ascending ? 1 : -1;
  const compare = (a: HoleRowView, b: HoleRowView): number => {
    if (key === 'kind') return a.kind.localeCompare(b.kind) * sign;
    const [va, vb] =
      key === 'label'
        ? [Number(a.label.replace(/\D/g, '')), Number(b.label.replace(/\D/g, ''))]
        : key === 'depth'
          ? [depthValue(a), depthValue(b)]
          : [a[key], b[key]];
    return va === vb ? 0 : (va < vb ? -1 : 1) * sign;
  };
  return [...rows].sort(compare);
}

/** Countersink included-angle presets. Not sourced: always shown as unverified; the number the user types is what is sent. */
export const CSK_PRESET_ANGLES: readonly number[] = [82, 90, 100];
