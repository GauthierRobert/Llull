/**
 * What a deliverable IS at this moment (plant 08 DAT §5.14): the SHA-256 of the canonical JSON of its report table (columns and rows) or of the IFC text, and the
 * plant objects its scope covers. A pure function of the document: the same document always gives the same hash, so a status step can be re-checked later.
 */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { resolveNode } from './hierarchy';
import { getPlantData } from './model';
import type { MtoDimension } from './plantReports/mto';
import { applyDefinition } from './plantReports/definition';
import { buildReport } from './plantReports/build';
import { objectsInScope } from './plantReports/scope';
import { REPORT_KINDS, type ReportKind } from './plantReports/types';
import { failure, type Outcome } from './commands/params';

/** The report kinds that are deliverables by their own name (`custom` needs a saved definition, which is a deliverable by its id). */
export const REPORT_DELIVERABLES = REPORT_KINDS.filter((kind): kind is Exclude<ReportKind, 'custom'> => kind !== 'custom');

export const IFC_DELIVERABLE = 'ifc';

export interface DeliverableContent {
  readonly sha256: string;
  /** Hierarchy node id of the scope, absent = the whole plant. */
  readonly hierarchyId?: string;
  /** The plant objects the scope covers; absent = all of them (the check then also covers the unclassified model elements). */
  readonly objects?: ReadonlySet<string>;
}

/** The deliverable ids a caller can name: the built-in report kinds, `ifc` and the saved report definitions. */
export const deliverableIds = (doc: CadDocument): string[] => [
  ...REPORT_DELIVERABLES,
  IFC_DELIVERABLE,
  ...Object.keys(getPlantData(doc).reports ?? {}).filter(
    (id) => id !== IFC_DELIVERABLE && !(REPORT_DELIVERABLES as readonly string[]).includes(id),
  ),
];

export function deliverableContent(
  doc: CadDocument,
  id: string,
  hierarchy: string | undefined,
  ctx: ExecutionContext | undefined,
  confirmExportControlled: unknown,
): Outcome<{ content: DeliverableContent }> {
  const data = getPlantData(doc);
  if (id === IFC_DELIVERABLE) {
    if (hierarchy !== undefined)
      return failure('DAT_PARAM_INVALID', 'the ifc deliverable is the whole plant: omit hierarchy', ['hierarchy']);
    const exported = execute(doc, 'export_ifc', { schema: 'IFC4X3_ADD2', confirmExportControlled }, ctx);
    const text = (exported.data as { ifc?: unknown } | undefined)?.ifc;
    if (exported.rejected === true || typeof text !== 'string')
      return failure(exported.error?.code ?? 'DAT_PARAM_INVALID', `the IFC export of the deliverable failed: ${exported.summary}`, [
        'deliverable',
      ]);
    return { ok: true, content: { sha256: sha256Hex(text) } };
  }
  const definition = data.reports?.[id];
  const builtin = (REPORT_DELIVERABLES as readonly string[]).includes(id);
  if (!builtin && definition === undefined)
    return failure('DAT_PARAM_INVALID', `no deliverable "${id}": use ${deliverableIds(doc).join(', ')}`, ['deliverable']);
  const scope = hierarchy ?? definition?.hierarchy;
  const node = scope === undefined ? null : resolveNode(data, scope);
  if (scope !== undefined && (node === null || node === 'ambiguous'))
    return failure('DAT_HIERARCHY_UNKNOWN', `no (or an ambiguous) hierarchy node "${scope}"`, ['hierarchy']);
  const built = buildReport(doc, {
    kind: (builtin ? id : definition?.kind) as ReportKind,
    hierarchy: scope,
    groupBy: builtin ? undefined : (definition?.groupBy as readonly MtoDimension[] | undefined),
  });
  const shaped = !built.ok || definition === undefined || builtin ? built : applyDefinition(built.table, definition);
  if (!shaped.ok) return failure(shaped.code, shaped.message, [shaped.path]);
  const scoped = objectsInScope(doc, scope);
  const hierarchyId = node === null || node === 'ambiguous' ? undefined : node.id;
  const sha256 = sha256Hex(
    jcsJson({ deliverable: id, columns: shaped.table.columns.map((column) => [column.name, column.unit]), rows: shaped.table.rows }),
  );
  return {
    ok: true,
    content: {
      sha256,
      ...(hierarchyId === undefined ? {} : { hierarchyId }),
      ...(scoped.ok && hierarchyId !== undefined ? { objects: new Set(scoped.objects.map((object) => object.id)) } : {}),
    },
  };
}
