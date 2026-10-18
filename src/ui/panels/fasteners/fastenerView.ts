// Pure readers for the fastener panels: select_fastener preview, bill_of_materials sections, and the insert params the dialog sends.

import { isRecord } from '@lib/isRecord';

interface SelectionReason {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

export interface SelectionPreview {
  readonly ok: boolean;
  readonly partNumber: string;
  readonly lengthIn: number | null;
  readonly gripDash: string;
  readonly washers: readonly string[];
  readonly reasons: readonly SelectionReason[];
  readonly warnings: readonly string[];
  /** Rules left at their default, with their source (shown so a default is never mistaken for a requirement). */
  readonly defaultedRules: readonly string[];
}

interface StandardPartRow {
  readonly partNumber: string;
  readonly family: string;
  readonly count: number;
  readonly mass: string;
  readonly representative: boolean;
}

interface MaterialMassRow {
  readonly materialId: string;
  readonly solidCount: number;
  readonly massKg: number;
  readonly unverified: boolean;
}

export interface BomView {
  readonly standardParts: readonly StandardPartRow[];
  readonly materials: readonly MaterialMassRow[];
  readonly unassignedSolidCount: number;
  /** Sum of the components' masses (rows with a density only). */
  readonly totalMassKg: number;
  /** Component names / ids whose mass is unknown (a solid without a density). */
  readonly rowsWithoutDensity: readonly string[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);

export function parseSelection(data: unknown): SelectionPreview | null {
  if (!isRecord(data) || typeof data['ok'] !== 'boolean') return null;
  const lengthIn = data['lengthIn'];
  const warnings = records(data['warnings']).map((w) => text(w['message']) || text(w['code']));
  return {
    ok: data['ok'],
    partNumber: text(data['partNumber']),
    lengthIn: typeof lengthIn === 'number' ? lengthIn : null,
    gripDash: text(data['gripDash']),
    washers: records(data['washers']).map((w) => text(w['partNumber'])),
    reasons: records(data['reasons']).map((r) => ({
      code: text(r['code']),
      message: text(r['message']),
      remediation: text(r['remediation']),
    })),
    warnings,
    defaultedRules: records(data['rules'])
      .filter((r) => r['defaulted'] === true)
      .map((r) => `${text(r['rule']) || text(r['name']) || 'rule'} — ${text(r['source'])}`),
  };
}

function massText(value: unknown): string {
  if (!isRecord(value)) return '';
  return `${String(value['value'])} ${text(value['unit'])}`.trim();
}

export function parseBom(data: unknown): BomView | null {
  if (!isRecord(data) || !Array.isArray(data['rows'])) return null;
  return {
    standardParts: records(data['standardParts']).map((row) => ({
      partNumber: text(row['partNumber']),
      family: text(row['family']),
      count: count(row['count']),
      mass: massText(row['totalMass']),
      representative: isRecord(row['representative']) || row['representative'] === true,
    })),
    materials: records(data['materials']).map((row) => ({
      materialId: text(row['materialId']),
      solidCount: count(row['solidCount']),
      massKg: count(row['totalMassKg']),
      unverified: row['unverified'] === true,
    })),
    unassignedSolidCount: count(data['unassignedSolidCount']),
    totalMassKg: count(data['totalMassKg']),
    rowsWithoutDensity: Array.isArray(data['rowsWithoutDensity'])
      ? data['rowsWithoutDensity'].filter((id): id is string => typeof id === 'string')
      : [],
  };
}

export interface InsertDraft {
  readonly family: string;
  readonly diameterDash: string;
  readonly stack: string;
  readonly unit: string;
  readonly nut: string;
  readonly washer: string;
  readonly useSelection: boolean;
  readonly axisPoint: string;
  readonly holeMode: string;
}

/** The params shared by select_fastener (preview) and insert_fastener_stack (confirm); null while the draft is incomplete. */
export function selectionParams(
  draft: InsertDraft,
  selection: readonly string[],
  numbers: { stack: number | undefined; axisPoint: number[] | null },
): Record<string, unknown> | null {
  if (draft.family === '' || draft.diameterDash === '') return null;
  const common = {
    family: draft.family,
    diameterDash: draft.diameterDash,
    ...(draft.nut === '' ? {} : { nut: draft.nut }),
    ...(draft.washer === '' ? {} : { washer: draft.washer }),
  };
  if (draft.useSelection) {
    if (selection.length === 0 || numbers.axisPoint?.length !== 3) return null;
    return { ...common, stackIds: [...selection], axisPoint: numbers.axisPoint };
  }
  if (numbers.stack === undefined || numbers.stack <= 0) return null;
  return {
    ...common,
    stack: { value: numbers.stack, unit: draft.unit },
    ...(numbers.axisPoint?.length === 3 ? { axisPoint: numbers.axisPoint } : {}),
  };
}

interface LayoutItemView {
  readonly code: string;
  readonly severity: string;
  readonly stackIds: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

export interface LayoutView {
  readonly status: string;
  readonly items: readonly LayoutItemView[];
}

export function parseLayout(data: unknown): LayoutView | null {
  if (!isRecord(data) || !Array.isArray(data['items'])) return null;
  return {
    status: text(data['status']) || 'pass',
    items: records(data['items']).map((item) => ({
      code: text(item['code']),
      severity: text(item['severity']),
      stackIds: Array.isArray(item['stackIds']) ? item['stackIds'].filter((id): id is string => typeof id === 'string') : [],
      message: text(item['message']),
      remediation: text(item['remediation']),
    })),
  };
}
