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
import { getPlantData, own } from './model';
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

const unknownScope = (reference: string, fixed: boolean): Outcome<never> =>
  failure(
    'DAT_HIERARCHY_UNKNOWN',
    fixed
      ? `the scope "${reference}" of this revision no longer exists in the hierarchy (a regenerate or a hierarchy replace dropped it)`
      : `no (or an ambiguous) hierarchy node "${reference}"`,
    ['hierarchy'],
  );

/**
 * The content of `id` in a scope. `scope.fixed` (an existing revision): `scope.hierarchy` is its stored node id (or undefined = the whole plant) and nothing else
 * decides the scope, a saved definition's own hierarchy included; otherwise (a new revision) `scope.hierarchy` or else the definition's hierarchy is the scope.
 */
export function deliverableContent(
  doc: CadDocument,
  id: string,
  scope: { readonly hierarchy: string | undefined; readonly fixed: boolean },
  ctx: ExecutionContext | undefined,
  confirmExportControlled: unknown,
): Outcome<{ content: DeliverableContent }> {
  const data = getPlantData(doc);
  const hierarchy = scope.hierarchy;
  if (id === IFC_DELIVERABLE) {
    const node = hierarchy === undefined ? undefined : resolveNode(data, hierarchy);
    if (node === null || node === 'ambiguous') return unknownScope(hierarchy ?? '', scope.fixed);
    const exported = execute(
      doc,
      'export_ifc',
      { schema: 'IFC4X3_ADD2', confirmExportControlled, ...(node === undefined ? {} : { plant: { scope: node.id } }) },
      ctx,
    );
    const text = (exported.data as { ifc?: unknown } | undefined)?.ifc;
    if (exported.rejected === true || typeof text !== 'string')
      return failure(exported.error?.code ?? 'DAT_PARAM_INVALID', `the IFC export of the deliverable failed: ${exported.summary}`, [
        'deliverable',
      ]);
    const scoped = node === undefined ? null : objectsInScope(doc, node.id);
    return {
      ok: true,
      content: {
        sha256: sha256Hex(text),
        ...(node === undefined ? {} : { hierarchyId: node.id }),
        ...(scoped?.ok === true ? { objects: new Set(scoped.objects.map((object) => object.id)) } : {}),
      },
    };
  }
  const definition = own(data.reports, id);
  const builtin = (REPORT_DELIVERABLES as readonly string[]).includes(id);
  if (!builtin && definition === undefined)
    return failure('DAT_PARAM_INVALID', `no deliverable "${id}": use ${deliverableIds(doc).join(', ')}`, ['deliverable']);
  const wanted = scope.fixed ? hierarchy : (hierarchy ?? definition?.hierarchy);
  const node = wanted === undefined ? null : resolveNode(data, wanted);
  if (wanted !== undefined && (node === null || node === 'ambiguous')) return unknownScope(wanted, scope.fixed);
  const built = buildReport(doc, {
    kind: (builtin ? id : definition?.kind) as ReportKind,
    hierarchy: wanted,
    groupBy: builtin ? undefined : (definition?.groupBy as readonly MtoDimension[] | undefined),
  });
  const shaped = !built.ok || definition === undefined || builtin ? built : applyDefinition(built.table, definition);
  if (!shaped.ok) return failure(shaped.code, shaped.message, [shaped.path]);
  const scoped = objectsInScope(doc, wanted);
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
