/**
 * `import_pcf as route` (plant 05 ISO M5, OQ-ISO-07): the imported line becomes a routed line - plan the centreline from the file, execute it with the 02 RTE commands, then
 * compare what the spec built with what the file said. The routed line follows the SPEC (flange sets with gaskets, catalogue centre-to-ends), so its dimensions can differ
 * from the file's: the difference is measured and reported (`ISO_ROUTE_DIMENSIONS_CHANGED`), never hidden. Pure apart from the nested commands.
 */

import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { getBuilding } from '../../../building/model';
import { isoIssue, refuseIso } from '../codes';
import { isLineRead, loadLine } from '../lineNetwork';
import type { IsoIssue, NetworkComponent, PcfLineData } from '../model';
import { summarise } from '../pcf/pcfMap';
import { composeRoute, isComposed } from './compose';
import { planRoute } from './plan';

export interface RouteImportArgs {
  readonly file: PcfLineData;
  /** The line number the routed line gets (PIPELINE-REFERENCE or lineIdOverride). */
  readonly lineNumber: string;
  readonly preview: boolean;
  readonly spec: string | undefined;
  readonly service: string;
  readonly supports: boolean;
  readonly valveType: string;
  /** Data of the file (counts, pipe lengths, BOM) the import reports for every mode. */
  readonly base: Record<string, unknown>;
  readonly warnings: readonly IsoIssue[];
}

/** Types whose count the comparison reports; gaskets and bolt sets are rebuilt by the spec with each flange. */
const COMPARED = ['PIPE', 'ELBOW', 'BEND', 'TEE', 'OLET', 'REDUCER-CONCENTRIC', 'FLANGE', 'VALVE'] as const;

function comparison(imported: readonly NetworkComponent[], routed: readonly NetworkComponent[]): Record<string, unknown> {
  const [before, after] = [summarise(imported), summarise(routed)];
  const countDelta = Object.fromEntries(
    COMPARED.flatMap((type) => {
      const delta = (after.countsByType[type] ?? 0) - (before.countsByType[type] ?? 0);
      return delta === 0 ? [] : [[type, delta]];
    }),
  );
  return {
    imported: { countsByType: before.countsByType, totalPipeLengthMm: before.totalPipeLengthMm },
    routed: { countsByType: after.countsByType, totalPipeLengthMm: after.totalPipeLengthMm },
    pipeLengthDeltaMm: Number((after.totalPipeLengthMm - before.totalPipeLengthMm).toFixed(6)),
    countDelta,
    rebuiltBySpec: {
      GASKET: (after.countsByType['GASKET'] ?? 0) - (before.countsByType['GASKET'] ?? 0),
      BOLT: (after.countsByType['BOLT'] ?? 0) - (before.countsByType['BOLT'] ?? 0),
    },
  };
}

export function importAsRoute(doc: CadDocument, args: RouteImportArgs, ctx: ExecutionContext | undefined): CommandResult {
  const { file } = args;
  const spec = args.spec ?? file.attributes['PIPING-SPEC'];
  if (spec === undefined || spec.trim() === '')
    return refuseIso(
      doc,
      'import_pcf',
      'ISO_ROUTE_SPEC_MISSING',
      'as route needs a spec: the file has no PIPING-SPEC and spec was not given',
      [],
      ['spec'],
    );
  const plan = planRoute(file.components);
  if (!plan.ok) return refuseIso(doc, 'import_pcf', plan.code, `as route: ${plan.message}`, plan.ids, ['as']);
  if (args.supports && plan.supports.length > 0 && Object.keys(getBuilding(doc).levels).length === 0)
    return refuseIso(
      doc,
      'import_pcf',
      'ISO_ROUTE_NO_LEVEL',
      `as route: ${plan.supports.length} support(s) in the file need a building level to be placed`,
      plan.supports.map((support) => support.componentId),
      ['supports'],
    );
  const composed = composeRoute(
    doc,
    { plan, lineNumber: args.lineNumber, spec: spec.trim(), service: args.service, supports: args.supports, valveType: args.valveType },
    ctx,
  );
  if (!isComposed(composed)) return composed;
  const read = loadLine(composed.document, 'import_pcf', composed.lineId);
  const compared = isLineRead(read) ? comparison(file.components, read.network.components) : null;
  const warnings: IsoIssue[] = [...args.warnings];
  const pipeDelta = (compared?.['pipeLengthDeltaMm'] as number | undefined) ?? 0;
  const countDelta = (compared?.['countDelta'] ?? {}) as Record<string, number>;
  if (Math.abs(pipeDelta) > 0.05 || Object.keys(countDelta).length > 0)
    warnings.push(
      isoIssue(
        'ISO_ROUTE_DIMENSIONS_CHANGED',
        'warning',
        `the routed line follows spec ${spec}, not the file: pipe length ${pipeDelta >= 0 ? '+' : ''}${pipeDelta} mm, component count differences ${JSON.stringify(countDelta)}`,
        [composed.lineId],
      ),
    );
  if (composed.droppedSupports > 0)
    warnings.push(
      isoIssue(
        'ISO_ROUTE_SUPPORTS_DROPPED',
        'warning',
        `${composed.droppedSupports} support(s) of the file were not created (supports false)`,
        [composed.lineId],
      ),
    );
  const route = {
    spec: spec.trim(),
    service: args.service,
    lineId: composed.lineId,
    lineNumber: args.lineNumber,
    runs: plan.runs.map((run) => ({
      key: run.key,
      runId: composed.runIds[run.key] ?? null,
      dn: run.dn,
      parent: run.parent ?? null,
      points: run.points,
      startPort: run.startPort !== undefined,
      endPort: run.endPort !== undefined,
      inline: run.inline.map((item) => ({ type: item.type, componentId: item.componentId })),
    })),
    portIds: composed.portIds,
    fieldWelds: plan.welds.map((weld, at) => ({ componentId: weld.componentId, kind: weld.kind, weldId: composed.weldIds[at] ?? null })),
    shopWeldsDerived: plan.shopWelds,
    supports: {
      requested: plan.supports.length,
      placed: composed.supportIds,
      dropped: composed.droppedSupports,
      // The mark is the document's own numbering (PS1 ...): SUPPORT-NAME of the file is not kept as the mark.
      marks: composed.supportIds.map((id, at) => {
        const element = composed.document.building?.elements[id];
        return { id, mark: element?.category === 'pipeSupport' ? element.mark : null, fileName: plan.supports[at]?.name ?? null };
      }),
    },
    rebuiltBySpec: plan.rebuilt,
    droppedAttributes: Object.keys(file.attributes).filter((key) => key !== 'PIPING-SPEC'),
    droppedUnknownRecords: file.unknownRecords.length,
    comparison: compared,
    commands: composed.commands,
  };
  const data = {
    ...args.base,
    as: 'route',
    lineId: args.preview ? args.lineNumber : composed.lineId,
    lineNumber: args.lineNumber,
    warnings,
    stored: !args.preview,
    route,
  };
  const text =
    `${plan.runs.length} run(s), ${composed.portIds.length} flanged end(s), ${plan.welds.length} field weld(s), ${composed.supportIds.length} support(s) on spec ${spec.trim()}` +
    `${compared === null ? '' : `, pipe ${(compared['routed'] as { totalPipeLengthMm: number }).totalPipeLengthMm.toFixed(1)} mm (file ${(compared['imported'] as { totalPipeLengthMm: number }).totalPipeLengthMm.toFixed(1)} mm)`}`;
  if (args.preview) return report(doc, `import_pcf preview as route: line ${args.lineNumber}, ${text}; nothing was changed`, data);
  return {
    document: composed.document,
    summary: `import_pcf: routed line ${composed.lineId} (${args.lineNumber}) from the file, ${text}`,
    affected: [
      composed.lineId,
      ...plan.runs.flatMap((run) => composed.runIds[run.key] ?? []),
      ...composed.portIds,
      ...composed.weldIds,
      ...composed.supportIds,
    ],
    data,
  };
}
