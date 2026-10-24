import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { commandError, exportRefusal, rejection } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import { getPiping, refuse } from '../model';
import { selectRuns } from '../graph';

/**
 * @affects none (query: returns the same document; the STEP text is in `data.step`)
 * @invariant the solids are the exact B-rep the kernel builds from the display geometry of the derived parts (the same revolved profiles the viewport and
 *   export_ifc use), written by export_step_ap242 with its validation properties and self-check; broken runs are never exported
 * @failure no kernel -> refused by execute (kernel_info); a kernel without a STEP writer -> XCH_WRITER_UNAVAILABLE; unknown line / run -> RTE_UNKNOWN_LINE / RTE_UNKNOWN_RUN;
 *   nothing routed -> RTE_NO_RUNS; a run that no longer derives -> its RTE_* code
 */
export const exportPipeStep = defineCommand({
  name: 'export_pipe_step',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Export routed pipe (route_pipe, add_branch, auto_route_pipe) as exact STEP solids for CAD, fabrication or stress tools: every derived part - pipe pieces, elbows and bends, tees, olets, reducers, ' +
    'flanges, gaskets, valves with their stem and operator - is built by the geometry kernel as an exact B-rep (a revolved profile, so cylinders and torus segments are analytic surfaces, not facets) and written ' +
    'through export_step_ap242 (AP242 by default, product names carry the part id and the line number, validation properties and self-check included). Give lineIds or runIds, or omit both for every routed run; ' +
    'a run that no longer derives is refused (repair it first). Needs the exact kernel (kernel_info): the mesh kernel refuses with XCH_WRITER_UNAVAILABLE and nothing is written. Returns the export_step_ap242 data ' +
    '(step, schema, solidCount, entityIds, skipped, gvp, selfCheck, provenance, reviewRequired) plus runs and lineIds; save the text with llull export_pipe_step --save pipe.stp. Refusals: RTE_UNKNOWN_LINE, ' +
    'RTE_UNKNOWN_RUN, RTE_NO_RUNS, the RTE_* code of a broken run, XCH_* from the STEP writer, MAT_EXPORT_CONTROLLED. Does not modify the document. For a mesh-only check without a kernel use export_pcf or export_ifc.',
  params: z.object({
    lineIds: z.array(z.string()).optional().describe('Line ids whose runs to export (affected[0] of create_pipeline).'),
    runIds: z.array(z.string()).optional().describe('Run ids to export (affected[0] of route_pipe). Combined with lineIds as a union.'),
    schema: z.enum(['ap242', 'ap214', 'ap203']).optional().describe("STEP application protocol: 'ap242' (default), 'ap214' or 'ap203'."),
    includeValidationProperties: z
      .boolean()
      .optional()
      .describe('Write and self-check the geometric validation properties (volume, area, centre) of every product. Default true.'),
    fileName: z.string().optional().describe('File name recorded in the Part 21 header and used by --save. Default pipe.stp.'),
    timestamp: z.string().optional().describe('ISO 8601 time recorded in the header. Default 1970-01-01T00:00:00 (reproducible bytes).'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_pipe_step', 'step', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const piping = getPiping(doc);
    const unknownLines = (params.lineIds ?? []).filter((id) => piping.lines[id] === undefined);
    if (unknownLines.length > 0)
      return refuse(
        doc,
        'export_pipe_step',
        'RTE_UNKNOWN_LINE',
        `no pipe line ${unknownLines.map((id) => `"${id}"`).join(', ')}`,
        unknownLines,
        ['lineIds'],
      );
    const unknownRuns = (params.runIds ?? []).filter((id) => piping.runs[id] === undefined);
    if (unknownRuns.length > 0)
      return refuse(
        doc,
        'export_pipe_step',
        'RTE_UNKNOWN_RUN',
        `no pipe run ${unknownRuns.map((id) => `"${id}"`).join(', ')}`,
        unknownRuns,
        ['runIds'],
      );
    const all = params.lineIds === undefined && params.runIds === undefined;
    const runIds = piping.runOrder.filter(
      (id) => all || (params.runIds ?? []).includes(id) || (params.lineIds ?? []).includes(piping.runs[id]?.lineId ?? ''),
    );
    if (runIds.length === 0)
      return refuse(doc, 'export_pipe_step', 'RTE_NO_RUNS', 'no routed run selected: route_pipe first', [], ['lineIds']);
    const broken = selectRuns(doc).broken.find((entry) => runIds.includes(entry.runId));
    if (broken !== undefined)
      return refuse(
        doc,
        'export_pipe_step',
        broken.failure.code,
        `run ${broken.runId} does not derive: ${broken.failure.message}`,
        [broken.runId, ...broken.failure.ids],
        [...broken.failure.paths],
        broken.failure.detail,
      );
    const entityIds = runIds.flatMap((id) => piping.entityIds[id] ?? []);
    if (entityIds.length === 0)
      return refuse(doc, 'export_pipe_step', 'RTE_NO_RUNS', `the selected run(s) ${runIds.join(', ')} have no solid geometry`, runIds, [
        'runIds',
      ]);
    const exported = execute(
      doc,
      'export_step_ap242',
      {
        entityIds,
        ...(params.schema === undefined ? {} : { schema: params.schema }),
        ...(params.includeValidationProperties === undefined ? {} : { includeValidationProperties: params.includeValidationProperties }),
        fileName: params.fileName ?? 'pipe.stp',
        ...(params.timestamp === undefined ? {} : { timestamp: params.timestamp }),
        ...(params.confirmExportControlled === undefined ? {} : { confirmExportControlled: params.confirmExportControlled }),
      },
      ctx,
    );
    if (exported.data === undefined)
      return rejection(
        doc,
        exported.summary.replace('export_step_ap242', 'export_pipe_step'),
        exported.error ??
          commandError('XCH_EXPORT_FAILED', 'Run on the desktop backend or with --kernel occt-native; see the summary.', runIds),
      );
    const lineIds = [...new Set(runIds.map((id) => piping.runs[id]?.lineId ?? ''))];
    return {
      document: doc,
      summary: `export_pipe_step: runs ${runIds.join(', ')} (lines ${lineIds.join(', ')}): ${exported.summary.replace('export_step_ap242: ', '')}`,
      affected: [],
      data: { ...(exported.data as Record<string, unknown>), name: params.fileName ?? 'pipe.stp', runs: runIds, lineIds },
    };
  },
});
