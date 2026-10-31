import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { analyseLine, isAnalysis, type LineAnalysis } from '../analysis';
import { bomRows, boltingOf, type BomRow, type Bolting } from '../bom';
import { isoIssue, refuseIso } from '../codes';
import { allLineIds } from '../lineNetwork';

/**
 * @affects none (query: returns the same document)
 * @invariant PIPE quantities are metres of centreline (so BOM = takeoff = cut-list centreline sum), other items count; the spool rows add up to the line rows and the line rows to the document rows;
 *   a bolted joint (gasket + bolt set) belongs to the spool of its first component; `unverified` is inherited from the catalogue row
 * @failure unknown line -> ISO_LINE_NOT_FOUND; unknown spool -> ISO_SPOOL_NOT_FOUND; scope without its line / spool -> ISO_PARAM_INVALID; no piping -> ISO_NO_PIPING; components without item code are listed as ISO_ITEM_CODE_MISSING warnings
 */
export const pipingBom = defineCommand({
  name: 'piping_bom',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Bill of material of piping: rows by item code with description, quantity and unit (pipe in metres of centreline length, everything else in pieces; unverified: true when the catalogue row is not verified), for one line, ' +
    'one spool, or the whole document. With includeBolting the flanged joints add gaskets and stud bolts: one gasket and one bolt set per flange pair, and per flanged line end when matingFlanges is assume_in_scope ' +
    '(the mating flange is assumed in scope; default this_side_only counts pairs of the line only); bolts per set and diameter come from the ASME B16.5 table by DN and pressure class, the class being read from the ' +
    'flange item code (FLWN-100-150 = class 150). Gaskets and bolts are erection items. Scope: line (needs lineId), spool (lineId + spoolId, a name from spool_list), document (every line). ' +
    'Returns data = { scope, rows: [{ itemCode, type, description, quantity, unit, unverified? }], bolting?: { joints, gaskets, studBolts, diameter, groups: [{ dn, pressureClass, boltsPerSet, boltDiameterIn, sets, unverified }], unresolved }, ' +
    'withoutItemCode: [componentId], warnings, provenance: { catalogue, sources } }. Refusals: ISO_LINE_NOT_FOUND, ISO_SPOOL_NOT_FOUND, ISO_NO_PIPING, ISO_PARAM_INVALID.',
  params: z.object({
    scope: z
      .enum(['line', 'spool', 'document'])
      .describe('line = one line (lineId), spool = one spool (lineId + spoolId), document = every line with piping.'),
    lineId: z
      .string()
      .min(1)
      .optional()
      .describe('The line: routed line id, imported PCF line number or legacy line number. Needed for scope line and spool.'),
    spoolId: z.string().min(1).optional().describe('The spool name from spool_list, e.g. L-101-SP02. Needed for scope spool.'),
    includeBolting: z
      .boolean()
      .optional()
      .describe('true = add the bolting result (gaskets and stud bolts per flanged joint). Default false.'),
    matingFlanges: z
      .enum(['assume_in_scope', 'this_side_only'])
      .optional()
      .describe(
        'assume_in_scope = each flanged line end is a joint whose mating flange is supplied here (gasket + bolt set counted); this_side_only (default) = only flange pairs inside the line.',
      ),
  }),
  run: (doc, params): CommandResult => {
    if ((params.scope !== 'document' && params.lineId === undefined) || (params.scope === 'spool' && params.spoolId === undefined))
      return refuseIso(
        doc,
        'piping_bom',
        'ISO_PARAM_INVALID',
        `scope ${params.scope} needs ${params.scope === 'spool' ? 'lineId and spoolId' : 'lineId'}`,
        [],
        ['lineId', 'spoolId'],
      );
    const lineIds = params.scope === 'document' ? allLineIds(doc) : [params.lineId as string];
    if (lineIds.length === 0) return refuseIso(doc, 'piping_bom', 'ISO_NO_PIPING', 'the document has no piping');
    const analyses: LineAnalysis[] = [];
    for (const lineId of lineIds) {
      const analysis = analyseLine(doc, 'piping_bom', lineId);
      if (!isAnalysis(analysis)) return analysis;
      analyses.push(analysis);
    }
    const names = (analyses[0] as LineAnalysis).spools.spools.map((spool) => spool.name);
    if (params.scope === 'spool' && !names.includes(params.spoolId as string))
      return refuseIso(
        doc,
        'piping_bom',
        'ISO_SPOOL_NOT_FOUND',
        `line ${params.lineId} has no spool "${params.spoolId}" (${names.join(', ')})`,
        [params.lineId as string],
        ['spoolId'],
      );
    const rows = new Map<string, BomRow>();
    const missing: string[] = [];
    const bolting: Bolting[] = [];
    for (const analysis of analyses) {
      const spoolPosition = params.scope === 'spool' ? names.indexOf(params.spoolId as string) : -1;
      const inScope = (index: number): boolean => spoolPosition < 0 || analysis.spools.spoolOf.get(index) === spoolPosition;
      const result = bomRows(analysis.read.network.components, inScope);
      missing.push(...result.withoutItemCode);
      for (const row of result.rows) {
        const have = rows.get(row.itemCode);
        rows.set(
          row.itemCode,
          have === undefined
            ? row
            : {
                ...have,
                quantity: Math.round((have.quantity + row.quantity) * 1e6) / 1e6,
                ...(have.unverified === true || row.unverified === true ? { unverified: true as const } : {}),
              },
        );
      }
      if (params.includeBolting === true) bolting.push(boltingOf(analysis, params.matingFlanges ?? 'this_side_only', inScope));
    }
    const warnings = [
      ...(missing.length === 0
        ? []
        : [
            isoIssue(
              'ISO_ITEM_CODE_MISSING',
              'warning',
              `${missing.length} component(s) have no item code and are not in the rows`,
              missing,
            ),
          ]),
      ...bolting.flatMap((bolts) =>
        bolts.unresolved.length === 0
          ? []
          : [
              isoIssue(
                'ISO_BOLTING_UNRESOLVED',
                'warning',
                `${bolts.unresolved.length} flanged joint(s) have no ASME B16.5 bolt row (DN or class unknown)`,
                bolts.unresolved,
              ),
            ],
      ),
    ];
    const merged: Bolting | undefined =
      params.includeBolting === true
        ? (() => {
            const groups = new Map<string, Bolting['groups'][number]>();
            for (const group of bolting.flatMap((bolts) => bolts.groups)) {
              const key = `${group.dn}/${group.pressureClass}`;
              const have = groups.get(key);
              groups.set(key, have === undefined ? group : { ...have, sets: have.sets + group.sets });
            }
            const list = [...groups.values()];
            const diameters = new Set(list.map((group) => group.boltDiameterIn));
            return {
              joints: bolting.reduce((sum, bolts) => sum + bolts.joints, 0),
              gaskets: bolting.reduce((sum, bolts) => sum + bolts.gaskets, 0),
              studBolts: list.reduce((sum, group) => sum + group.boltsPerSet * group.sets, 0),
              diameter: diameters.size === 1 ? ([...diameters][0] ?? null) : null,
              groups: list,
              unresolved: bolting.flatMap((bolts) => bolts.unresolved),
            };
          })()
        : undefined;
    const list = [...rows.values()];
    return report(
      doc,
      `piping_bom: ${params.scope}${params.scope === 'document' ? '' : ` ${params.lineId}${params.spoolId === undefined ? '' : `/${params.spoolId}`}`}: ${list.length} item(s)` +
        `${list.some((row) => row.unit === 'm') ? `, pipe ${list.filter((row) => row.unit === 'm').reduce((sum, row) => sum + row.quantity, 0)} m` : ''}` +
        `${merged === undefined ? '' : `; bolting: ${merged.joints} flanged joint(s), ${merged.gaskets} gasket(s), ${merged.studBolts} stud bolt(s)${merged.diameter === null ? '' : ` ${merged.diameter} in`}`}` +
        `${warnings.length === 0 ? '' : `; warnings: ${warnings.map((warning) => warning.code).join(', ')}`}`,
      {
        scope: params.scope,
        rows: list,
        ...(merged === undefined ? {} : { bolting: merged }),
        withoutItemCode: missing,
        warnings,
        provenance: {
          catalogue:
            'ASME B16.5 class 150-600 weld-neck flange table (01 PSC bundled catalogue) for bolting; descriptions from the line (PCF MATERIALS / spec)',
          sources: [...new Set(analyses.map((analysis) => analysis.read.network.source))],
        },
      },
    );
  },
});
