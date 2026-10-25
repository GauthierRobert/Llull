import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { sha256Hex } from '@lib/sha256';
import { buildGraph, selectRuns } from '../../piping/graph';
import { getPiping, refuse } from '../../piping/model';
import { isoIssue, refuseIso } from '../codes';
import { legacyLines, legacyNetwork } from '../legacyNetwork';
import type { IsoIssue, PcfLineData, PcfUnit, PcfUnits, PipingNetwork } from '../model';
import { GENERATED_UNITS, dataOfNetwork, missingSkeyIds, networkOf, summarise } from '../pcf/pcfMap';
import { writePcfText } from '../pcf/pcfWrite';
import { routeNetwork, type RouteNetwork } from '../routeNetwork';
import { getFabrication } from '../state';

const OWNER = { route: 'routed line', pcf: 'imported line', legacy: 'legacy pipe line' } as const;

interface Entry {
  readonly kind: 'route' | 'pcf' | 'legacy';
  readonly id: string;
  /** The PIPELINE-REFERENCE and file name. */
  readonly key: string;
}

const ALL = (unit: PcfUnit): PcfUnits => ({ bore: unit, coords: unit, boltDia: unit, boltLength: unit });

/** The units a line is written in: the `units` param for every field, else the ones a stored line was read in, else mm. */
function effectiveUnits(source: Source, requested: 'mm' | 'inch' | undefined): PcfUnits {
  if (requested !== undefined) return ALL(requested === 'inch' ? 'INCH' : 'MM');
  return source.network.source === 'pcf' ? source.data.units : GENERATED_UNITS;
}

/** A stored line with verbatim content (extra attributes, unknown records) cannot change a unit it declared. */
function unitsConflict(data: PcfLineData, units: PcfUnits): boolean {
  const verbatim = data.unknownRecords.length > 0 || data.components.some((component) => component.extra !== undefined);
  const declared = data.units;
  const changed =
    declared.bore !== units.bore ||
    declared.coords !== units.coords ||
    (declared.boltDia !== undefined && declared.boltDia !== units.boltDia) ||
    (declared.boltLength !== undefined && declared.boltLength !== units.boltLength);
  return verbatim && changed;
}

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
    const entries = (id: string): Entry[] => [
      ...(piping.lines[id] === undefined ? [] : [{ kind: 'route' as const, id, key: piping.lines[id]?.lineNumber ?? id }]),
      ...(stored[id] === undefined ? [] : [{ kind: 'pcf' as const, id, key: id }]),
      ...(legacy.has(id) ? [{ kind: 'legacy' as const, id, key: id }] : []),
    ];
    const wanted: Entry[] =
      params.lineIds === undefined
        ? [
            ...piping.lineOrder.filter(hasRun).flatMap((id) => entries(id).filter((entry) => entry.kind === 'route')),
            ...Object.keys(stored)
              .sort()
              .flatMap((id) => entries(id).filter((entry) => entry.kind === 'pcf')),
            ...[...legacy.keys()].flatMap((id) => entries(id).filter((entry) => entry.kind === 'legacy')),
          ]
        : [...new Set(params.lineIds)].flatMap(entries);
    const unknown = (params.lineIds ?? []).filter((id) => entries(id).length === 0);
    if (unknown.length > 0)
      return refuseIso(doc, 'export_pcf', 'ISO_LINE_NOT_FOUND', `no pipe line ${unknown.map((id) => `"${id}"`).join(', ')}`, unknown, [
        'lineIds',
      ]);
    const noRun = wanted.filter((entry) => entry.kind === 'route' && !hasRun(entry.id)).map((entry) => entry.id);
    if (wanted.length === 0 || noRun.length > 0)
      return refuseIso(
        doc,
        'export_pcf',
        'ISO_NO_PIPING',
        wanted.length === 0 ? 'the document has no piping' : `no routed run on line ${noRun.join(', ')}: route_pipe first`,
        noRun,
        ['lineIds'],
      );
    const clash = wanted.find((entry, index) => wanted.findIndex((other) => other.key === entry.key) !== index);
    if (clash !== undefined) {
      const owners = wanted.filter((entry) => entry.key === clash.key);
      return refuseIso(
        doc,
        'export_pcf',
        'ISO_LINE_DUPLICATE',
        `PIPELINE-REFERENCE "${clash.key}" is used by ${owners.map((entry) => `${OWNER[entry.kind]} ${entry.id}`).join(' and ')}: one file per line would overwrite the other`,
        owners.map((entry) => entry.id),
        ['lineIds'],
      );
    }
    const routedWanted = wanted.filter((entry) => entry.kind === 'route').map((entry) => entry.id);
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
    const sources = wanted.flatMap((entry): Source[] => {
      const line = piping.lines[entry.id];
      if (entry.kind === 'route' && line !== undefined) {
        const route = routeNetwork({
          line,
          runs: selection.graphRuns.filter((run) => run.lineId === entry.id),
          project: doc.building?.project.name,
        });
        return [{ network: route.network, data: dataOfNetwork(route.network), route }];
      }
      const data = stored[entry.id];
      if (entry.kind === 'pcf' && data !== undefined) return [{ network: networkOf(data), data }];
      const network = entry.kind === 'legacy' ? legacyNetwork(doc, entry.id) : null;
      return network === null ? [] : [{ network, data: dataOfNetwork(network) }];
    });
    const errors = sources.flatMap((source) => source.network.warnings.filter((warning) => warning.severity === 'error'));
    const firstError = errors[0];
    if (firstError !== undefined)
      return refuseIso(
        doc,
        'export_pcf',
        firstError.code,
        `${firstError.message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`,
        errors.flatMap((error) => error.ids),
        errors.flatMap((error) => error.paths),
      );
    const effective = sources.map((source) => effectiveUnits(source, params.units));
    const conflict = sources.find((source, index) => unitsConflict(source.data, effective[index] as PcfUnits));
    if (conflict !== undefined)
      return refuseIso(
        doc,
        'export_pcf',
        'ISO_PCF_UNITS_VERBATIM',
        `line ${conflict.data.lineId} keeps attributes or records verbatim that may carry lengths in the units it was read in; writing it in other units would mislabel them`,
        [conflict.data.lineId],
        ['units'],
      );
    const missingIds = sources.flatMap((source) => missingSkeyIds(source.data.components));
    if (params.strictSkey === true && missingIds.length > 0)
      return refuseIso(doc, 'export_pcf', 'ISO_SKEY_MISSING', `${missingIds.length} component(s) have no confirmed SKEY`, missingIds, [
        'strictSkey',
      ]);
    const files = sources.map((source, index) => {
      const written = writePcfText(source.data, { units: effective[index] as PcfUnits, includeMaterials: params.includeMaterials ?? true });
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
        units: effective[index],
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
