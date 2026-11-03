/** `pipe_stress_report` (07 PST M4): the review document of a stress model as HTML or CSV text. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { sha256Hex } from '@lib/sha256';
import { analyzeStressModel } from '../analysis';
import { buildReportData } from '../report/reportData';
import { CSV_TABLES, reportCsv, reportHtml } from '../report/reportFiles';
import { analysisRefusal, isRefusal, modelOr } from './common';

/** A file-name safe form of an id. */
const slug = (id: string): string => id.replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * @affects none (query: returns the same document; the file text is in `data.text` for `--save`)
 * @invariant byte-deterministic: the same document gives the same text (no clock); the analysis is rerun from the current document so a stale record is shown as such (PST_RESULTS_STALE finding), never a silent pass; reviewRequired is always true; HTML text is escaped, CSV is RFC 4180 with the spreadsheet formula guard
 * @failure unknown model -> PST_MODEL_NOT_FOUND; the analysis' own refusal code (PST_CONDITIONS_MISSING, PST_UNSTABLE, PST_STRESS_NOT_FINITE ...) with the document unchanged
 */
export const pipeStressReport = defineCommand({
  name: 'pipe_stress_report',
  description:
    'Query: the review report of a pipe stress model, from the analysis of the CURRENT pipes and supports, as one HTML page or a CSV table in `data.text` (write it with `llull pipe_stress_report \'{"modelId":"PS1"}\' --save report.html`). ' +
    'Contents: model, code and edition, load cases with the governing ratio and PASS / FAIL, findings with codes and remediation, the unverified inputs (unsourced material or edition) and defaulted inputs, support loads (N, N.mm) per case, ' +
    'the station table (stress, allowable, ratio, result; MPa) and the approval status: approved (a human signed these exact results), stale (recorded or approved results were computed from other inputs: PST_RESULTS_STALE finding, re-run record_pipe_stress_results) or none. ' +
    'format html (default) is the whole report; format csv writes one `table`: stations (default), cases, supports or findings. `data` holds the summary (status, record, approval, cases, counts, hashes), `fileName`, `text`, `sha256`, `bytes`. ' +
    'The same analysis colours pipes in `render_view` with overlay "pipe_stress" (green below ratio 0.8, amber 0.8 to 1, red above 1). Read-only; reviewRequired is always true. Refused with the analysis code (PST_MODEL_NOT_FOUND, PST_CONDITIONS_MISSING, PST_UNSTABLE ...) when the model cannot be analysed.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    format: z.enum(['html', 'csv']).optional().describe('html (default): the whole report page. csv: one table in data.text.'),
    table: z
      .enum(CSV_TABLES)
      .optional()
      .describe(
        'csv only: stations (default; every stress station), cases (governing ratio per case), supports (support loads), findings.',
      ),
  }),
  run: (doc, { modelId, format = 'html', table = 'stations' }): CommandResult => {
    const model = modelOr(doc, 'pipe_stress_report', modelId);
    if (isRefusal(model)) return model;
    const analysis = analyzeStressModel(doc, model);
    if (!analysis.ok) return analysisRefusal(doc, 'pipe_stress_report', analysis);
    const data = buildReportData(model, analysis);
    const text = format === 'html' ? reportHtml(data) : reportCsv(data, table);
    const fileName = `${slug(model.id)}-stress-${format === 'html' ? 'report.html' : `${table}.csv`}`;
    const bytes = new TextEncoder().encode(text).length;
    const { stations, supportLoads, ...summary } = data;
    return report(
      doc,
      `pipe_stress_report: ${model.id} ${format}${format === 'csv' ? ` ${table}` : ''}, status ${data.status}, record ${data.record.status}, approval ${data.approval.status}, ${stations.length} station(s), ${supportLoads.length} support load(s), ${bytes} bytes; review required.`,
      {
        ...summary,
        stationCount: stations.length,
        supportLoadCount: supportLoads.length,
        failingStations: stations.filter((station) => !station.pass).length,
        format,
        ...(format === 'csv' ? { table } : {}),
        fileName,
        text,
        sha256: sha256Hex(text),
        bytes,
        reviewRequired: true,
      },
    );
  },
});
