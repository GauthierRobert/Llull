import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { sha256Hex } from '@lib/sha256';
import { buildGraph, selectRuns } from '../graph';
import { getPiping, refuse } from '../model';
import { writePcf } from '../pcf';

/**
 * @affects none (query: returns the same document; the PCF text is in `data.files[].content`)
 * @invariant one PCF per line, byte-deterministic for the same document; components in run order then route order with 1-based identifiers; SKEYs only where confirmed
 * @failure unknown line -> RTE_UNKNOWN_LINE; no routed run -> RTE_NO_RUNS; a run of the line that no longer derives -> its RTE_* code (nothing is exported);
 *   export-controlled materials without confirmation -> MAT_EXPORT_CONTROLLED
 */
export const exportPcf = defineCommand({
  name: 'export_pcf',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export routed pipe as PCF (Piping Component File, ISOGEN / Alias format; units mm) for isometric and fabrication tools: one file per pipe line (create_pipeline) with its line number as ' +
    'PIPELINE-REFERENCE, PIPING-SPEC, INSULATION-SPEC / TRACING-SPEC when set, and one record per derived part in run order: PIPE, ELBOW (BEND for a pipe bend), TEE, OLET, REDUCER-CONCENTRIC / ' +
    'REDUCER-ECCENTRIC, FLANGE, GASKET, BOLT, VALVE, CAP with END-POINT x y z bore endType (0.1 mm), CENTRE-POINT for elbows, bends and tees, BRANCH1-POINT for tees and olets, ' +
    'COMPONENT-IDENTIFIER 1..n, UNIQUE-COMPONENT-IDENTIFIER (the llull part id, e.g. run-4.1/pipe-2), ITEM-CODE and a MATERIALS block. SKEY is written only where the isometric key is confirmed ' +
    '(elbow butt weld ELBW / socket weld ELSW, tee TEBW, weld neck flange FLWN, eccentric reducer REBW); other components are written without one and listed in data.files[].missingSkey - add the key ' +
    'in your isometric tool. A stub-in has no PCF component (listed in skipped). Welds, supports and spools are not written (05 isometrics). Give lineIds, or omit for every routed line. ' +
    'Returns data = { files: [{ name, content, sha256, componentCount, countsByType, skipped, missingSkey, bolts, openEnds }], count, reviewRequired }; save it with llull export_pcf --save <dir> (one file per line). ' +
    'Refusals: RTE_UNKNOWN_LINE, RTE_NO_RUNS, the RTE_* code of a run that no longer derives (fix it first), MAT_EXPORT_CONTROLLED. Does not modify the document. Next: check_piping before handing the file over.',
  params: z.object({
    lineIds: z
      .array(z.string())
      .optional()
      .describe('Line ids to export (affected[0] of create_pipeline). Omit for every line that has a routed run.'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_pcf', 'data', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const piping = getPiping(doc);
    const unknown = (params.lineIds ?? []).filter((id) => piping.lines[id] === undefined);
    if (unknown.length > 0)
      return refuse(doc, 'export_pcf', 'RTE_UNKNOWN_LINE', `no pipe line ${unknown.map((id) => `"${id}"`).join(', ')}`, unknown, [
        'lineIds',
      ]);
    const wanted = (params.lineIds ?? piping.lineOrder).filter((id) => piping.runOrder.some((runId) => piping.runs[runId]?.lineId === id));
    if (wanted.length === 0)
      return refuse(doc, 'export_pcf', 'RTE_NO_RUNS', 'no routed run on the selected line(s): route_pipe first', params.lineIds ?? [], [
        'lineIds',
      ]);
    const selection = selectRuns(doc, wanted);
    const broken = selection.broken.find((entry) => wanted.includes(piping.runs[entry.runId]?.lineId ?? ''));
    if (broken !== undefined)
      return refuse(
        doc,
        'export_pcf',
        broken.failure.code,
        `run ${broken.runId} does not derive: ${broken.failure.message}`,
        [broken.runId, ...broken.failure.ids],
        [...broken.failure.paths],
        broken.failure.detail,
      );
    const graph = buildGraph(doc, selection.graphRuns);
    const files = wanted.map((lineId) => {
      const line = piping.lines[lineId];
      const runs = selection.graphRuns.filter((run) => run.lineId === lineId);
      const result = writePcf({ line: line as NonNullable<typeof line>, runs, project: doc.building?.project.name });
      const openEnds = graph.openEnds
        .filter((end) => end.lineId === lineId)
        .map((end) => ({ partId: end.partId, position: end.position, dn: end.dn }));
      return { ...result, sha256: sha256Hex(result.content), openEnds };
    });
    const components = files.reduce((sum, file) => sum + file.componentCount, 0);
    const missing = files.reduce((sum, file) => sum + file.missingSkey.length, 0);
    return report(
      doc,
      `export_pcf: ${files.length} PCF file(s) ${files.map((file) => file.name).join(', ')}, ${components} component(s)` +
        `${missing === 0 ? '' : `; ${missing} component(s) written without a SKEY (no confirmed isometric key)`}` +
        `${files.some((file) => file.skipped.length > 0) ? `; skipped ${files.flatMap((file) => file.skipped.map((entry) => entry.partId)).join(', ')} (no PCF component)` : ''}` +
        `${files.some((file) => file.openEnds.length > 0) ? `; open ends: ${files.reduce((sum, file) => sum + file.openEnds.length, 0)}` : ''}; review required.`,
      {
        files: files.map((file) => ({
          name: file.name,
          content: file.content,
          sha256: file.sha256,
          componentCount: file.componentCount,
          countsByType: file.countsByType,
          skipped: file.skipped,
          missingSkey: file.missingSkey,
          bolts: file.bolts,
          openEnds: file.openEnds,
        })),
        count: files.length,
        reviewRequired: {
          value: true,
          reasons: ['SKEY and BOLT attributes follow the unconfirmed subset of the PCF reference (docs/plant/05 pcf_keywords.json)'],
        },
      },
    );
  },
});
