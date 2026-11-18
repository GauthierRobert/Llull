/** export_isometric phases: parameter and graph refusals, sheet settings and plan, the issue comparison, the sheets, warnings, files and the report. */

import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { sha256Hex } from '@lib/sha256';
import type { LineAnalysis } from '../analysis';
import { isoIssue, refuseIso } from '../codes';
import { deltaOf, snapshotOf, type IssueDelta } from '../compareIssue';
import type { issueState } from '../issues';
import type { buildIsoGraph } from '../iso/isoGraph';
import { axisAngles, TRUE_ISO_SCALE } from '../iso/isoProjection';
import { dxfOf, svgOf } from '../iso/isoRender';
import { buildIsoSheet, type IsoSheet, type SheetOptions } from '../iso/isoSheet';
import { continuationOf, planSheets, type SheetInfo, type SheetPlan } from '../iso/isoSheets';
import { isoTables, TABLE_NAMES } from '../iso/isoTables';
import type { IsoIssue, IsoStyle } from '../model';
import { lineSupports } from '../supports';

const NAME = 'export_isometric';

type Issued = NonNullable<ReturnType<typeof issueState>['latest']>;
type IsoGraph = ReturnType<typeof buildIsoGraph>;

export type Phase<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: CommandResult };
const proceed = <T>(value: T): Phase<T> => ({ ok: true, value });
const stop = (result: CommandResult): Phase<never> => ({ ok: false, result });

/** The params the phases read. */
export interface IsoParams {
  readonly lineId: string;
  readonly style?: IsoStyle | undefined;
  readonly paper?: SheetOptions['paper'] | undefined;
  readonly formats?: ('svg' | 'dxf')[] | undefined;
  readonly tables?: SheetOptions['tables'][number][] | undefined;
  readonly northArrow?: SheetOptions['northArrow'] | undefined;
  readonly spoolId?: string | undefined;
  readonly compareToIssue?: boolean | undefined;
  readonly revision?: string | undefined;
}

const fileStem = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, '_');

export const tablesOf = (sheet: Pick<IsoSheet, 'tables'>): Record<string, unknown> =>
  Object.fromEntries(sheet.tables.map((table) => [table.name, { rows: table.rows.length, columns: table.columns, data: table.rows }]));

/** The refusal for spoolId / revision params that contradict the rest, or null. */
export function paramRefusal(doc: CadDocument, params: IsoParams): CommandResult | null {
  if (params.spoolId !== undefined && params.style !== undefined && params.style !== 'spool')
    return refuseIso(
      doc,
      NAME,
      'ISO_PARAM_INVALID',
      'spoolId is for the spool style: omit style or pass style spool',
      [params.spoolId],
      ['spoolId', 'style'],
    );
  if (params.revision !== undefined && params.compareToIssue !== true)
    return refuseIso(
      doc,
      NAME,
      'ISO_PARAM_INVALID',
      'revision labels the compareToIssue clouds: pass compareToIssue true',
      [],
      ['revision'],
    );
  return null;
}

/** The refusal for a line without drawable components or with unreachable ones, or null. */
export function graphRefusal(doc: CadDocument, params: IsoParams, graph: IsoGraph): CommandResult | null {
  if (graph.steps.length === 0)
    return refuseIso(doc, NAME, 'ISO_NO_PIPING', `line ${params.lineId} has no drawable component`, [params.lineId], ['lineId']);
  if (graph.groups > 1)
    return refuseIso(
      doc,
      NAME,
      'ISO_DISCONNECTED',
      `${graph.unreachable.length} component(s) of line ${params.lineId} are not connected to the line start: ${graph.unreachable.join(', ')}`,
      graph.unreachable,
      ['lineId'],
    );
  return null;
}

export interface Settings {
  readonly style: IsoStyle;
  readonly paper: SheetOptions['paper'];
  readonly northArrow: SheetOptions['northArrow'];
  readonly wanted: SheetOptions['tables'];
  readonly plan: SheetPlan;
}

/** Style, paper, north arrow, tables and sheet plan: explicit params over the stored define_isometric, over the defaults. */
export function settingsOf(analysis: LineAnalysis, params: IsoParams): Settings {
  const definition = analysis.fabrication.isometrics?.[analysis.lineId];
  const style: IsoStyle = params.style ?? (params.spoolId === undefined ? (definition?.style ?? 'check') : 'spool');
  const plan = planSheets(
    analysis,
    style === 'spool'
      ? { kind: 'spool' }
      : {
          kind: 'budget',
          splitAt: definition?.splitAt ?? 'weld',
          stored: definition?.sheetAssignment ?? {},
          ...(definition?.maxPipePiecesPerSheet === undefined ? {} : { budget: definition.maxPipePiecesPerSheet }),
        },
  );
  return {
    style,
    paper: params.paper ?? definition?.paper ?? 'A3',
    northArrow: params.northArrow ?? definition?.northArrow ?? 'up_right',
    wanted: params.tables ?? (style === 'check' ? [] : TABLE_NAMES),
    plan,
  };
}

/** The sheets to draw: every one, or the spool asked for; none is a refusal. */
export function chosenSheets(doc: CadDocument, params: IsoParams, plan: SheetPlan): Phase<readonly SheetInfo[]> {
  const chosen = params.spoolId === undefined ? plan.sheets : plan.sheets.filter((sheet) => sheet.spool === params.spoolId);
  if (chosen.length > 0) return proceed(chosen);
  return stop(
    refuseIso(
      doc,
      NAME,
      'ISO_SPOOL_NOT_FOUND',
      `line ${params.lineId} has no spool "${params.spoolId}" (${plan.sheets.map((sheet) => sheet.spool).join(', ')})`,
      [params.lineId],
      ['spoolId'],
    ),
  );
}

export interface Comparison {
  readonly issueId: string;
  readonly issuedRevision: string;
  readonly purpose: string;
  readonly unchanged: boolean;
  readonly delta: IssueDelta;
}

/** The comparison with the last issue and the revision clouds it draws (both absent without compareToIssue); a missing issue is a refusal. */
export function issueComparison(
  doc: CadDocument,
  params: IsoParams,
  analysis: LineAnalysis,
  latest: Issued | undefined,
): Phase<{ comparison: Comparison | undefined; revision: SheetOptions['revision'] }> {
  if (params.compareToIssue !== true) return proceed({ comparison: undefined, revision: undefined });
  const issued = latest === undefined ? undefined : analysis.fabrication.issueSnapshots?.[latest.id];
  if (latest === undefined || issued === undefined)
    return stop(
      refuseIso(
        doc,
        NAME,
        latest === undefined ? 'ISO_ISSUE_NOT_FOUND' : 'ISO_ISSUE_SNAPSHOT_MISSING',
        latest === undefined ? `line ${params.lineId} has no issue to compare with` : `issue ${latest.id} has no stored snapshot`,
        latest === undefined ? [params.lineId] : [latest.id],
        ['compareToIssue'],
      ),
    );
  const now = snapshotOf(analysis);
  const delta = deltaOf(issued, now);
  const comparison: Comparison = {
    issueId: latest.id,
    issuedRevision: latest.revision,
    purpose: latest.purpose,
    unchanged: delta.total === 0,
    delta,
  };
  const revision: SheetOptions['revision'] =
    delta.total > 0
      ? {
          label: params.revision ?? '*',
          issuedRevision: latest.revision,
          removed: delta.components.removed.length,
          componentIds: new Set([...delta.components.added, ...delta.components.changed]),
          welds: new Map([...delta.welds.added, ...delta.welds.changed].map((number) => [number, (now.welds[number] as { at: Vec3 }).at])),
        }
      : undefined;
  return proceed({ comparison, revision });
}

export interface Built {
  readonly info: SheetInfo;
  readonly sheet: IsoSheet;
  readonly continuation: ReturnType<typeof continuationOf>;
}

/** Draw every chosen sheet; a sheet whose components are not connected is a refusal. */
export function buildSheets(
  doc: CadDocument,
  params: IsoParams,
  analysis: LineAnalysis,
  settings: Settings,
  chosen: readonly SheetInfo[],
  revision: SheetOptions['revision'],
  current: Issued | undefined,
): Phase<Built[]> {
  const { style, paper, northArrow, wanted, plan } = settings;
  const scoped = style === 'spool' || plan.sheets.length > 1;
  const supports = lineSupports(doc, analysis.lineId, analysis.read.network);
  const built: Built[] = [];
  for (const info of chosen) {
    const continuation = continuationOf(plan, info.index);
    const sheet = buildIsoSheet(analysis, {
      style,
      paper,
      northArrow,
      tables: wanted,
      supports,
      ...(revision === undefined ? {} : { revision }),
      project: doc.building?.project.name.trim() || 'llull',
      ...(current === undefined
        ? {}
        : { issue: { revision: current.revision, purpose: current.purpose.replace('_', ' '), signer: current.signer } }),
      ...(scoped
        ? {
            sheet: {
              index: info.index,
              total: plan.sheets.length,
              include: new Set(info.componentIds),
              indices: new Set(info.indices),
              partial: style !== 'spool',
              continuation: continuation.all,
              ...(info.spool === undefined ? {} : { spool: info.spool }),
            },
          }
        : {}),
    });
    if (sheet.graph.groups > 1)
      return stop(
        refuseIso(
          doc,
          NAME,
          'ISO_DISCONNECTED',
          `sheet ${info.index} of line ${params.lineId} is not connected: ${sheet.graph.unreachable.join(', ')}`,
          sheet.graph.unreachable,
          ['lineId'],
        ),
      );
    built.push({ info, sheet, continuation });
  }
  return proceed(built);
}

export const mismatchesOf = (built: readonly Built[]): number =>
  built.reduce((total, { sheet }) => total + sheet.dimensions.reduce((sum, dimension) => sum + dimension.mismatches, 0), 0);

/** The de-duplicated warnings of the network, the plan and the sheets, then the export's own (dimension mismatch, provisional welds, stale issue). */
export function warningsOf(
  params: IsoParams,
  analysis: LineAnalysis,
  plan: SheetPlan,
  built: readonly Built[],
  mismatches: number,
  issues: { readonly latest: Issued | undefined; readonly current: Issued | undefined },
): IsoIssue[] {
  const unnumbered = analysis.numbering.entries.filter((entry) => entry.status === 'assigned');
  const warnings: IsoIssue[] = [];
  const warn = (issue: IsoIssue): void => {
    if (!warnings.some((have) => have.code === issue.code && have.message === issue.message)) warnings.push(issue);
  };
  [...analysis.read.network.warnings, ...plan.warnings, ...built.flatMap(({ sheet }) => sheet.warnings)].forEach(warn);
  if (mismatches > 0)
    warn(isoIssue('ISO_DIMENSION_MISMATCH', 'error', `${mismatches} dimension label(s) differ from the 3D distance`, [params.lineId]));
  if (unnumbered.length > 0)
    warn(
      isoIssue(
        'ISO_WELDS_UNNUMBERED',
        'warning',
        `${unnumbered.length} weld number(s) on the sheet are provisional`,
        unnumbered.map((entry) => entry.record.number),
      ),
    );
  const { latest, current } = issues;
  if (latest !== undefined && current === undefined)
    warn(isoIssue('ISO_ISSUE_STALE', 'warning', `the line changed after issue ${latest.id} (revision ${latest.revision})`, [latest.id]));
  return warnings;
}

interface IsoFile {
  readonly name: string;
  readonly format: 'svg' | 'dxf';
  readonly content: string;
  readonly sha256: string;
  readonly sheetIndex: number;
}

function filesOf(analysis: LineAnalysis, params: IsoParams, built: readonly Built[]): IsoFile[] {
  const stem = fileStem(analysis.name);
  const formats = (params.formats ?? ['svg']).filter((format, at, all) => all.indexOf(format) === at);
  return built.flatMap(({ info, sheet }) =>
    formats.map((format) => {
      const content = format === 'svg' ? svgOf(sheet.primitives, sheet.width, sheet.height, sheet.title) : dxfOf(sheet.primitives);
      return { name: `${stem}_iso_sheet${info.index}.${format}`, format, content, sha256: sha256Hex(content), sheetIndex: info.index };
    }),
  );
}

/** Everything the report reads once the sheets are drawn. */
export interface Drawn {
  readonly doc: CadDocument;
  readonly analysis: LineAnalysis;
  readonly graph: IsoGraph;
  readonly settings: Settings;
  readonly scoped: boolean;
  readonly built: readonly Built[];
  readonly mismatches: number;
  readonly warnings: readonly IsoIssue[];
  readonly comparison: Comparison | undefined;
  readonly current: Issued | undefined;
  readonly params: IsoParams;
}

function summaryOf(d: Drawn, whole: readonly unknown[], files: readonly IsoFile[]): string {
  const { analysis, graph, settings, built, mismatches, warnings, comparison, current } = d;
  return (
    `export_isometric: line ${analysis.name}: ${built.length} sheet(s) ${settings.paper} (${settings.style}), ${graph.runs.length} run(s), ${built.reduce((sum, { sheet }) => sum + sheet.dimensions.length, 0)} dimension string(s) (${mismatches} mismatch), ` +
    `${built.reduce((sum, { sheet }) => sum + sheet.annotations.length, 0)} label(s), ${whole.length} table(s), ${files.map((file) => file.name).join(', ')}; ` +
    `${current === undefined ? 'NOT FOR CONSTRUCTION, review required' : `issued ${current.purpose.replace('_', ' ')} rev ${current.revision} by ${current.signer}`}` +
    `${comparison === undefined ? '' : `; vs rev ${comparison.issuedRevision}: ${comparison.delta.total} difference(s)`}` +
    `${warnings.length === 0 ? '' : `; warnings: ${[...new Set(warnings.map((warning) => warning.code))].join(', ')}`}`
  );
}

function sheetsData(built: readonly Built[], files: readonly IsoFile[]): unknown[] {
  return built.map(({ info, sheet, continuation }) => {
    const own = files.filter((file) => file.sheetIndex === info.index);
    return {
      index: info.index,
      files: own.map((file) => file.name),
      sha256: own[0]?.sha256 ?? '',
      componentIds: info.componentIds,
      pipes: info.pipes,
      ...(info.spool === undefined ? {} : { spool: info.spool }),
      continuation,
      tables: tablesOf(sheet),
      layout: { k: sheet.layout.k, scale: sheet.layout.scale, overflow: sheet.layout.overflow },
    };
  });
}

function supportsData(built: readonly Built[]): unknown[] {
  return built.flatMap(({ info, sheet }) =>
    sheet.annotations
      .filter((annotation) => annotation.kind === 'support')
      .map((annotation) => ({
        id: annotation['supportId'],
        mark: annotation.text,
        type: annotation['supportType'],
        at: annotation.at,
        sheetIndex: info.index,
      })),
  );
}

/** The report of a drawn line: summary text and the data payload (files, sheets, projection, dimensions, annotations, comparison, warnings). */
export function isometricReport(d: Drawn): CommandResult {
  const { doc, analysis, settings, built, mismatches, warnings, comparison, current } = d;
  const { style, paper, northArrow } = settings;
  const files = filesOf(analysis, d.params, built);
  const angles = axisAngles(northArrow);
  const whole = d.scoped ? isoTables(analysis, settings.wanted).tables : (built[0]?.sheet.tables ?? []);
  const first = (built[0] as Built).sheet;
  return report(doc, summaryOf(d, whole, files), {
    lineId: analysis.name,
    style,
    paper,
    files: files.map(({ sheetIndex: _sheetIndex, ...file }) => file),
    sheets: sheetsData(built, files),
    projection: {
      axes: { east: { angleDeg: angles.east }, north: { angleDeg: angles.north }, up: { angleDeg: angles.up } },
      interAxisAngleDeg: 120,
      trueIsoScale: TRUE_ISO_SCALE,
    },
    northArrow: { mode: northArrow, angleDeg: angles.northArrow },
    dimensions: built.flatMap(({ info, sheet }) => sheet.dimensions.map((dimension) => ({ ...dimension, sheetIndex: info.index }))),
    dimensionMismatches: mismatches,
    annotations: built.flatMap(({ info, sheet }) => sheet.annotations.map((annotation) => ({ ...annotation, sheetIndex: info.index }))),
    supports: supportsData(built),
    tables: tablesOf({ tables: whole }),
    layout: {
      k: first.layout.k,
      scale: first.layout.scale,
      overflow: first.layout.overflow,
      passes: first.layout.passes,
      crossings: first.layout.crossings.length,
    },
    ...(comparison === undefined
      ? {}
      : {
          comparison: {
            ...comparison,
            clouds: built.reduce(
              (sum, { sheet }) => sum + sheet.annotations.filter((annotation) => annotation.kind === 'revision').length,
              0,
            ),
          },
        }),
    warnings,
    reviewRequired: current === undefined,
    ...(current === undefined ? {} : { issue: current }),
  });
}
