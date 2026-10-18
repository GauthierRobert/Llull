// Typed readers over the `data` of describe_analysis / check_analysis / render_fea_results. Each returns null when the
// command refused (the caller shows its summary) instead of re-deriving anything.

import type { AnalysisCase } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';

export interface AnalysisListItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly state: string;
}

export function parseAnalysisList(data: unknown): AnalysisListItem[] {
  if (!isRecord(data) || !Array.isArray(data['analyses'])) return [];
  return data['analyses'].flatMap((entry): AnalysisListItem[] => {
    if (!isRecord(entry)) return [];
    const { id, name, type, state } = entry;
    return typeof id === 'string' && typeof name === 'string' && typeof type === 'string' && typeof state === 'string'
      ? [{ id, name, type, state }]
      : [];
  });
}

export interface DescribeView {
  readonly analysisCase: AnalysisCase;
  readonly state: string;
  readonly problem: string | null;
}

export function parseDescribe(data: unknown): DescribeView | null {
  if (!isRecord(data) || !isRecord(data['case']) || typeof data['state'] !== 'string') return null;
  const analysisCase = data['case'];
  if (typeof analysisCase['id'] !== 'string' || !isRecord(analysisCase['constraints']) || !isRecord(analysisCase['loads'])) return null;
  const problem = data['problem'];
  return {
    analysisCase: analysisCase as unknown as AnalysisCase,
    state: data['state'],
    problem: isRecord(problem) && typeof problem['message'] === 'string' ? problem['message'] : null,
  };
}

interface CheckItemView {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly remediation: string;
}

export interface CheckView {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly items: readonly CheckItemView[];
}

export function parseCheck(data: unknown): CheckView | null {
  if (!isRecord(data) || !Array.isArray(data['items'])) return null;
  const status = data['status'];
  if (status !== 'pass' && status !== 'warn' && status !== 'fail') return null;
  const items = data['items'].flatMap((entry): CheckItemView[] => {
    if (!isRecord(entry) || typeof entry['code'] !== 'string' || typeof entry['message'] !== 'string') return [];
    return [
      {
        code: entry['code'],
        severity: entry['severity'] === 'error' ? 'error' : 'warning',
        message: entry['message'],
        remediation: typeof entry['remediation'] === 'string' ? entry['remediation'] : '',
      },
    ];
  });
  return { status, items };
}

interface ExtremeView {
  readonly value: number;
  readonly at: readonly number[];
}

export interface RenderView {
  readonly svg: string;
  readonly field: string;
  readonly unit: string;
  readonly lengthUnit: string;
  readonly min: ExtremeView;
  readonly max: ExtremeView;
  readonly deformationScale: number;
  readonly resultLabel: string;
}

function parseExtreme(value: unknown): ExtremeView | null {
  if (!isRecord(value) || typeof value['value'] !== 'number' || !Array.isArray(value['at'])) return null;
  return { value: value['value'], at: value['at'].filter((n): n is number => typeof n === 'number') };
}

export function parseRender(data: unknown): RenderView | null {
  if (!isRecord(data) || typeof data['svg'] !== 'string' || typeof data['field'] !== 'string' || typeof data['unit'] !== 'string')
    return null;
  const min = parseExtreme(data['min']);
  const max = parseExtreme(data['max']);
  if (min === null || max === null) return null;
  const resultSet = data['resultSet'];
  return {
    svg: data['svg'],
    field: data['field'],
    unit: data['unit'],
    lengthUnit: typeof data['lengthUnit'] === 'string' ? data['lengthUnit'] : '',
    min,
    max,
    deformationScale: typeof data['deformationScale'] === 'number' ? data['deformationScale'] : 0,
    resultLabel: isRecord(resultSet) && typeof resultSet['label'] === 'string' ? resultSet['label'] : '',
  };
}

export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

interface ProbeSeriesView {
  readonly probeId: string;
  readonly name: string;
  readonly quantity: string;
  readonly unit: string;
  readonly points: ReadonlyArray<{ readonly time: number; readonly value: number }>;
}

export interface ProbeHistoryView {
  readonly series: readonly ProbeSeriesView[];
  readonly svg: string | null;
}

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

/** probe_history data; null when the command refused. */
export function parseProbeHistory(data: unknown): ProbeHistoryView | null {
  if (!isRecord(data) || !Array.isArray(data['series'])) return null;
  const series = data['series'].flatMap((entry): ProbeSeriesView[] => {
    if (!isRecord(entry) || typeof entry['probeId'] !== 'string' || !Array.isArray(entry['points'])) return [];
    const points = entry['points'].flatMap((point) =>
      isRecord(point) && typeof point['time'] === 'number' && typeof point['value'] === 'number'
        ? [{ time: point['time'], value: point['value'] }]
        : [],
    );
    return [
      {
        probeId: entry['probeId'],
        name: text(entry['name'], entry['probeId']),
        quantity: text(entry['quantity'], ''),
        unit: text(entry['unit'], ''),
        points,
      },
    ];
  });
  return { series, svg: typeof data['svg'] === 'string' ? data['svg'] : null };
}

export interface EigenView {
  readonly label: string;
  readonly unit: string;
  readonly values: readonly number[];
}

/** Natural frequencies (modal) or buckling factors (buckling) recorded with the solved results; null for other cases. */
export function eigenOf(analysisCase: AnalysisCase): EigenView | null {
  const { results } = analysisCase;
  if (results?.frequenciesHz !== undefined) return { label: 'Natural frequencies', unit: 'Hz', values: results.frequenciesHz };
  if (results?.bucklingFactors !== undefined) return { label: 'Buckling factors', unit: '× applied load', values: results.bucklingFactors };
  return null;
}
