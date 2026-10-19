// Typed readers over the `data` of topology_report / check_topology / suggest_rebuild, and the drawing helpers of the history plot.
// Reading only: nothing here builds or changes a document.

import type { TopologyHistoryRow } from '@core/model/topology';
import { isRecord } from '@lib/isRecord';
import { parseCheck, type CheckView } from './analysisData';

export interface TopologyResultView {
  readonly compliance: number;
  readonly complianceUnit: string;
  readonly iterations: number;
  readonly status: string;
  readonly volumeFraction: number;
  readonly grey: number;
  readonly history: readonly TopologyHistoryRow[];
}

export interface TopologyReportView {
  readonly state: string;
  readonly problem: string | null;
  readonly concept: boolean;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly result: TopologyResultView | null;
}

const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function parseHistory(value: unknown): TopologyHistoryRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): TopologyHistoryRow[] => {
    if (!isRecord(row)) return [];
    const it = numberOf(row['it']);
    const compliance = numberOf(row['compliance']);
    const volume = numberOf(row['volume']);
    return it === null || compliance === null || volume === null ? [] : [{ it, compliance, volume, change: numberOf(row['change']) ?? 0 }];
  });
}

function parseResult(raw: unknown): TopologyResultView | null {
  const compliance = isRecord(raw) ? numberOf(raw['compliance']) : null;
  if (!isRecord(raw) || compliance === null) return null;
  return {
    compliance,
    complianceUnit: typeof raw['complianceUnit'] === 'string' ? raw['complianceUnit'] : '',
    iterations: numberOf(raw['iterations']) ?? 0,
    status: typeof raw['status'] === 'string' ? raw['status'] : '',
    volumeFraction: numberOf(raw['volumeFraction']) ?? 0,
    grey: numberOf(raw['grey']) ?? 0,
    history: parseHistory(raw['history']),
  };
}

export function parseTopologyReport(data: unknown): TopologyReportView | null {
  if (!isRecord(data) || typeof data['state'] !== 'string') return null;
  const problem = data['problem'];
  const reasons = data['unverifiedReasons'];
  return {
    state: data['state'],
    problem: isRecord(problem) && typeof problem['message'] === 'string' ? problem['message'] : null,
    concept: data['concept'] !== false,
    unverified: data['unverified'] === true,
    unverifiedReasons: Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === 'string') : [],
    result: parseResult(data['result']),
  };
}

/** check_topology answers in the analysis check shape; its items carry codes (TOP_*) and remediation. */
export function parseTopologyCheck(data: unknown): CheckView | null {
  return parseCheck(data);
}

export interface RebuildLoop {
  readonly points: readonly (readonly [number, number])[];
  readonly orientation: 'outer' | 'hole';
}

export interface RebuildView {
  readonly loops: readonly RebuildLoop[];
  readonly plane: string;
  readonly lengthUnit: string;
  readonly droppedLoops: number;
}

export function parseRebuild(data: unknown): RebuildView | null {
  if (!isRecord(data) || !Array.isArray(data['loops'])) return null;
  const loops = data['loops'].flatMap((loop): RebuildLoop[] => {
    if (!isRecord(loop) || !Array.isArray(loop['points'])) return [];
    const points = loop['points'].flatMap((point): [number, number][] => {
      const x = Array.isArray(point) ? numberOf(point[0]) : null;
      const y = Array.isArray(point) ? numberOf(point[1]) : null;
      return x === null || y === null ? [] : [[x, y]];
    });
    return points.length < 3 ? [] : [{ points, orientation: loop['orientation'] === 'hole' ? 'hole' : 'outer' }];
  });
  return {
    loops,
    plane: typeof data['plane'] === 'string' ? data['plane'] : '',
    lengthUnit: typeof data['lengthUnit'] === 'string' ? data['lengthUnit'] : '',
    droppedLoops: numberOf(data['droppedLoops']) ?? 0,
  };
}

interface PlotSize {
  readonly width: number;
  readonly height: number;
}

const PAD = 4;

/** SVG `points` of `values` scaled to fill the plot (a flat series sits mid-height). */
function scaledPoints(values: readonly number[], { width, height }: PlotSize): string {
  const low = Math.min(...values);
  const span = Math.max(...values) - low;
  const step = values.length > 1 ? (width - 2 * PAD) / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const fraction = span > 0 ? (value - low) / span : 0.5;
      return `${(PAD + index * step).toFixed(1)},${(height - PAD - fraction * (height - 2 * PAD)).toFixed(1)}`;
    })
    .join(' ');
}

/** One polyline per series, each scaled to its own range; null when there is nothing to draw. */
export function historyPlot(history: readonly TopologyHistoryRow[], size: PlotSize): { compliance: string; volume: string } | null {
  if (history.length < 2) return null;
  return {
    compliance: scaledPoints(
      history.map((row) => row.compliance),
      size,
    ),
    volume: scaledPoints(
      history.map((row) => row.volume),
      size,
    ),
  };
}

/** `viewBox` framing every loop with y flipped (plane-local y is up, SVG y is down); null without loops. */
export function loopsViewBox(loops: readonly RebuildLoop[]): string | null {
  const points = loops.flatMap((loop) => loop.points);
  if (points.length === 0) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const margin = Math.max(width, height) * 0.05;
  return [Math.min(...xs) - margin, -(Math.max(...ys) + margin), width + 2 * margin, height + 2 * margin]
    .map((n) => n.toFixed(4))
    .join(' ');
}

/** SVG path `d` of one closed loop, y flipped like `loopsViewBox`. */
export function loopPath(loop: RebuildLoop): string {
  return `${loop.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0]} ${-point[1]}`).join(' ')} Z`;
}
