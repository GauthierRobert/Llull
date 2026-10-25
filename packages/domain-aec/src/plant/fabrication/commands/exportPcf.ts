import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { sha256Hex } from '@lib/sha256';
import { buildGraph, selectRuns } from '../../piping/graph';
import { getPiping, refuse } from '../../piping/model';
import { isoIssue, refuseIso } from '../codes';
import { legacyLines, legacyNetwork } from '../legacyNetwork';
import type { IsoIssue, PcfLineData, PipingNetwork } from '../model';
import { dataOfNetwork, missingSkeyIds, networkOf, summarise } from '../pcf/pcfMap';
import { writePcfText } from '../pcf/pcfWrite';
import { routeNetwork, type RouteNetwork } from '../routeNetwork';
import { getFabrication } from '../state';

const GENERATED_HEADER = { 'ISOGEN-FILES': 'ISOGEN.FLS', 'UNITS-WEIGHT': 'KGS' } as const;

interface Source {
  readonly network: PipingNetwork;
  readonly data: PcfLineData;
  readonly route?: RouteNetwork;
}

/**
 * @affects none (query: returns the same document; the PCF text is in `data.files[].content`)
 * @invariant one PCF per line, byte-deterministic for the same document; components in flow order (run order then route order for a routed line) with 1-based identifiers;
 *   SKEYs only where confirmed; a legacy pipe gets derived long-radius elbows (flagged); an imported line is written back from its stored data
 * @failure unknown line -> ISO_LINE_NOT_FOUND; nothing to export (or a routed line without a run) -> ISO_NO_PIPING; a run that no longer derives -> its RTE_* code (nothing is exported);
 *   strictSkey with a component lacking a SKEY -> ISO_SKEY_MISSING; export-controlled materials without confirmation -> MAT_EXPORT_CONTROLLED
 */
export const exportPcf = defineCommand({
  name: 'export_pcf',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export pipe lines as PCF (Piping Component File, ISOGEN / Alias format) for isometric and fabrication tools: one file per pipe line with its line number as PIPELINE-REFERENCE, PIPING-SPEC, ' +
    'INSULATION-SPEC / TRACING-SPEC when set, and one record per component in flow order: PIPE, ELBOW (BEND for a pipe bend), TEE, OLET, REDUCER-CONCENTRIC / REDUCER-ECCENTRIC, FLANGE, GASKET, BOLT, VALVE, ' +
    'CAP with END-POINT x y z bore endType (0.1 mm, or 4 decimals in inches), CENTRE-POINT for elbows, bends and tees, BRANCH1-POINT for tees and olets, COMPONENT-IDENTIFIER 1..n, ' +
    'UNIQUE-COMPONENT-IDENTIFIER (the llull part id, e.g. run-4.1/pipe-2), ITEM-CODE and a MATERIALS block. Three kinds of line are exported: routed lines (create_pipeline + route_pipe), ' +
    'lines imported with import_pcf (written back from the stored data, unknown records included) and legacy pipes (add_pipe_run: elbows are derived at every interior point from the long-radius B16.9 ' +
    'centre-to-end, flagged in data.files[].warnings as ISO_LEGACY_FITTINGS_DERIVED, and the line ends are ISO_OPEN_END warnings). SKEY is written only where the isometric key is confirmed ' +
    '(elbow butt weld ELBW / socket weld ELSW, tee TEBW, weld neck flange FLWN, eccentric reducer REBW); other components are written without one and listed in data.files[].missingSkey - add the key ' +
    'in your isometric tool, or pass strictSkey to refuse instead. A stub-in has no PCF component (listed in skipped). Welds, supports and spools are not written yet (05 isometrics M2+). ' +
    'Give lineIds (a routed line id, a PCF line number or a legacy line number), or omit for every line. units mm (default) or inch. ' +
    'Returns data = { files: [{ name, content, sha256, componentCount, countsByType, source, skipped, missingSkey, bolts, openEnds, warnings }], count, reviewRequired }; save it with llull export_pcf --save <dir> (one file per line). ' +
    'Refusals: ISO_LINE_NOT_FOUND, ISO_NO_PIPING, ISO_SKEY_MISSING (strictSkey), the RTE_* code of a run that no longer derives (fix it first), MAT_EXPORT_CONTROLLED. Does not modify the document. Next: check_piping before handing the file over; import_pcf reads it back.',
  params: z.object({
    lineIds: z
      .array(z.string())
      .optional()
      .describe(
        'Lines to export: routed line ids (affected[0] of create_pipeline), imported PCF line numbers, legacy pipe line numbers. Omit for every line that has piping.',
      ),
    units: z
      .enum(['mm', 'inch'])
      .optional()
      .describe(
        'Units written to UNITS-BORE / UNITS-CO-ORDS and used for the numbers: mm (one decimal) or inch (four decimals; the bore is converted by value, not to NPS).',
      ),
    includeMaterials: z.boolean().optional().describe('Write the MATERIALS block (item codes and descriptions). Default true.'),
    strictSkey: z
      .boolean()
      .optional()
      .describe(
        'Refuse (ISO_SKEY_MISSING) when a component has no confirmed isometric key instead of writing it without and listing it in missingSkey. Default false.',
      ),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_pcf', 'data', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const piping = getPiping(doc);
    const stored = getFabrication(doc).pcfLines;
    const legacy = legacyLines(doc);
    const hasRun = (lineId: string): boolean => piping.runOrder.some((runId) => piping.runs[runId]?.lineId === lineId);
    const routed = piping.lineOrder.filter(hasRun);
    const everything = [
      ...routed,
      ...Object.keys(stored)
        .sort()
        .filter((id) => !routed.includes(id)),
      ...[...legacy.keys()].filter((id) => !routed.includes(id) && stored[id] === undefined),
    ];
    const wanted = [...new Set(params.lineIds ?? everything)];
    const unknown = wanted.filter((id) => piping.lines[id] === undefined && stored[id] === undefined && !legacy.has(id));
    if (unknown.length > 0)
      return refuseIso(doc, 'export_pcf', 'ISO_LINE_NOT_FOUND', `no pipe line ${unknown.map((id) => `"${id}"`).join(', ')}`, unknown, [
        'lineIds',
      ]);
    const noRun = wanted.filter((id) => piping.lines[id] !== undefined && !hasRun(id));
    if (wanted.length === 0 || noRun.length > 0)
      return refuseIso(
        doc,
        'export_pcf',
        'ISO_NO_PIPING',
        wanted.length === 0 ? 'the document has no piping' : `no routed run on line ${noRun.join(', ')}: route_pipe first`,
        noRun,
        ['lineIds'],
      );
    const routedWanted = wanted.filter((id) => piping.lines[id] !== undefined);
    const selection = selectRuns(doc, routedWanted);
    const broken = selection.broken.find((entry) => routedWanted.includes(piping.runs[entry.runId]?.lineId ?? ''));
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
    const sources = wanted.map((lineId): Source => {
      const line = piping.lines[lineId];
      if (line !== undefined) {
        const route = routeNetwork({
          line,
          runs: selection.graphRuns.filter((run) => run.lineId === lineId),
          project: doc.building?.project.name,
        });
        return { network: route.network, data: dataOfNetwork(route.network, GENERATED_HEADER), route };
      }
      const data = stored[lineId];
      if (data !== undefined) return { network: networkOf(data), data };
      const network = legacyNetwork(doc, lineId) as PipingNetwork;
      return { network, data: dataOfNetwork(network, GENERATED_HEADER) };
    });
    const missingIds = sources.flatMap((source) => missingSkeyIds(source.data.components));
    if (params.strictSkey === true && missingIds.length > 0)
      return refuseIso(doc, 'export_pcf', 'ISO_SKEY_MISSING', `${missingIds.length} component(s) have no confirmed SKEY`, missingIds, [
        'strictSkey',
      ]);
    const files = sources.map((source) => {
      const written = writePcfText(source.data, { units: params.units ?? 'mm', includeMaterials: params.includeMaterials ?? true });
      const warnings: IsoIssue[] = [
        ...source.network.warnings,
        ...written.truncatedLines.map((line) =>
          isoIssue(
            'ISO_PCF_LINE_TRUNCATED',
            'warning',
            `line ${line} of ${source.data.lineId}.pcf was cut to 1024 characters`,
            [],
            [`line ${line}`],
          ),
        ),
      ];
      const summary = summarise(source.data.components);
      return {
        name: `${source.data.lineId.replace(/[^A-Za-z0-9._-]/g, '_')}.pcf`,
        content: written.content,
        sha256: sha256Hex(written.content),
        componentCount: summary.componentCount,
        countsByType: summary.countsByType,
        source: source.network.source,
        skipped: source.route?.skipped ?? [],
        missingSkey: missingSkeyIds(source.data.components),
        bolts: source.route?.bolts ?? [],
        openEnds: graph.openEnds
          .filter((end) => piping.lines[end.lineId]?.lineNumber === source.data.lineId)
          .map((end) => ({ partId: end.partId, position: end.position, dn: end.dn })),
        warnings,
      };
    });
    const components = files.reduce((sum, file) => sum + file.componentCount, 0);
    const reasons = [
      'SKEY and BOLT attributes follow the unconfirmed subset of the PCF reference (docs/plant/05 pcf_keywords.json)',
      ...(files.some((file) => file.source === 'legacy')
        ? ['legacy pipe: elbows are derived from the polyline, not placed by a spec']
        : []),
    ];
    const codes = [...new Set(files.flatMap((file) => file.warnings.map((warning) => warning.code)))];
    return report(
      doc,
      `export_pcf: ${files.length} PCF file(s) ${files.map((file) => file.name).join(', ')}, ${components} component(s)` +
        `${missingIds.length === 0 ? '' : `; ${missingIds.length} component(s) written without a SKEY (no confirmed isometric key)`}` +
        `${files.some((file) => file.skipped.length > 0) ? `; skipped ${files.flatMap((file) => file.skipped.map((entry) => entry.partId)).join(', ')} (no PCF component)` : ''}` +
        `${files.some((file) => file.openEnds.length > 0) ? `; open ends: ${files.reduce((sum, file) => sum + file.openEnds.length, 0)}` : ''}` +
        `${codes.length === 0 ? '' : `; warnings: ${codes.join(', ')}`}; review required.`,
      { files, count: files.length, reviewRequired: { value: true, reasons } },
    );
  },
});
