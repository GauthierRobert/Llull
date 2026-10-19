import { isRecord } from '@lib/isRecord';

/** The fields every structural check row shares (frames, bracing, foundations, runways). */
export interface ReportRow {
  readonly key: string;
  readonly elementId: string;
  readonly label: string;
  readonly utilisation: number;
  /** False when the command reports the row as failing / not analysed whatever its utilisation. */
  readonly ok: boolean;
  /** Shown instead of the utilisation when the check is not a ratio (pipe span vs allowed). */
  readonly detail: string;
}

export function isFailing(row: ReportRow): boolean {
  return row.utilisation > 1 || !row.ok;
}

/** check_pipe_supports: one row per pipe, ratio = largest span / allowed span. */
function toPipeRows(pipes: ReadonlyArray<unknown>): ReportRow[] {
  return pipes.flatMap((pipe: unknown, index): ReportRow[] => {
    if (!isRecord(pipe) || typeof pipe.largestSpanM !== 'number') return [];
    const allowed = typeof pipe.allowedSpanM === 'number' ? pipe.allowedSpanM : 0;
    const id = typeof pipe.id === 'string' ? pipe.id : '';
    const name = [pipe.line, pipe.mark].find((part) => typeof part === 'string' && part !== '');
    const dn = typeof pipe.dn === 'number' ? ` · DN${pipe.dn}` : '';
    return [
      {
        key: `${index}:${id}`,
        elementId: id,
        label: `${typeof name === 'string' ? name : id}${dn}`,
        utilisation: allowed > 0 ? pipe.largestSpanM / allowed : 0,
        ok: pipe.ok !== false,
        detail: `span ${pipe.largestSpanM.toFixed(1)} / ${allowed.toFixed(1)} m`,
      },
    ];
  });
}

export function toWarnings(data: unknown): string[] {
  const warnings: unknown = isRecord(data) ? data.warnings : undefined;
  return Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === 'string') : [];
}

/** Every row of a check result (the KPIs and the model colouring use all of them; the list shows the worst). */
export function allRows(data: unknown): ReportRow[] {
  if (isRecord(data) && Array.isArray(data.pipes)) return toPipeRows(data.pipes);
  const rows: unknown = isRecord(data) ? (data.rows ?? data.members) : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown, index): ReportRow[] => {
    if (!isRecord(row) || typeof row.utilisation !== 'number') return [];
    const text = (key: string): string => {
      const value = row[key];
      return typeof value === 'string' ? value : '';
    };
    const label = [text('mark') || text('column'), text('kind') || text('check'), text('frame')].filter((part) => part !== '').join(' · ');
    return [
      {
        key: `${index}:${text('elementId')}`,
        elementId: text('elementId') || text('id'),
        label,
        utilisation: row.utilisation,
        ok: row.ok !== false,
        detail: '',
      },
    ];
  });
}

/** The `limit` most utilised rows of a check result, worst first. */
export function worstRows(data: unknown, limit = 12): ReportRow[] {
  return allRows(data)
    .sort((a, b) => b.utilisation - a.utilisation)
    .slice(0, limit);
}
