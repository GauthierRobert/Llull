/** `export_pipe_spec` (plant 01 PSC M2): canonical JSON or the spec-sheet CSV of one spec revision. */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { exportRefusal, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { csvLines, type CsvCell } from '@lib/csv';
import { sha256Hex } from '@lib/sha256';
import type { NominalSize } from '../../catalog/types';
import { componentRows } from '../checks/rows';
import { canonicalSpecText } from '../file';
import { sizesInRange } from '../size';
import type { PipeSpec } from '../types';
import { isLoaded, loadSpec } from './answer';

const sizeText = (size: NominalSize | undefined): string | null => (size === undefined ? null : `${size.system} ${size.key}`);

const COLUMNS = [
  'component',
  'type',
  'from',
  'to',
  'branchFrom',
  'branchTo',
  'ends',
  'class',
  'pn',
  'facing',
  'radius',
  'schedule',
  'scheduleFromPipe',
  'wallMm',
  'priority',
  'catalogRef',
  'commodityCode',
  'description',
  'material',
  'verified',
] as const;

/** Spec sheet: one row per component and size range; `verified` = every catalogue row it resolves to is grade A. */
function sheetCsv(spec: PipeSpec, verified: ReadonlyMap<string, boolean>): string {
  const rows = spec.components.map((component): CsvCell[] => [
    component.id,
    component.type,
    sizeText(component.from),
    sizeText(component.to),
    sizeText(component.branchFrom),
    sizeText(component.branchTo),
    component.ends ?? null,
    component.class ?? null,
    component.pn ?? null,
    component.facing ?? null,
    component.radius ?? null,
    component.schedule ?? null,
    component.scheduleFromPipe ?? null,
    component.wallMm ?? null,
    component.priority ?? null,
    component.catalogRef,
    component.commodityCode ?? null,
    component.description ?? null,
    component.material ?? null,
    verified.get(component.id) ?? false,
  ]);
  return csvLines(COLUMNS, rows);
}

function branchCsv(spec: PipeSpec): string {
  const cells = spec.branchTable?.cells ?? {};
  return csvLines(
    ['header', 'branch', 'fitting'],
    Object.keys(cells).flatMap((header) =>
      Object.entries(cells[header] ?? {}).map(([branch, fitting]): CsvCell[] => [header, branch, fitting]),
    ),
  );
}

/**
 * @affects none; data = { specId, revision, format, text, sha256, bytes, components, branchCsv? }
 * @invariant read-only; json is the canonical file (sorted keys, millimetres) and importing it into an empty document then exporting gives the identical sha256; sha256 is of the text
 * @failure unknown spec or revision -> PSC_SPEC_UNKNOWN; export-controlled content in the document without a human signature -> MAT_EXPORT_CONTROLLED / MAT_HUMAN_GATE
 */
export const exportPipeSpec = defineCommand({
  name: 'export_pipe_spec',
  description:
    'Export one revision of a piping spec as canonical JSON (format llull-pipe-spec: sorted keys, millimetres, sizes as fromNps / toNps or fromDn / toDn) or as the spec-sheet CSV for reviewers ' +
    '(one row per component with sizes, ends, class, facing, schedule, catalogue, commodity code and verified; the branch table comes back as a second CSV in data.branchCsv). ' +
    'Returns the text and its sha256: exporting, importing and exporting again gives the identical hash. Next: import_pipe_spec re-imports the JSON; pass --save to write it to a file.',
  params: z.object({
    specId: z.string().describe('Spec id (list_pipe_specs).'),
    revision: z.number().int().positive().describe('Spec revision. Default: the newest.').optional(),
    format: z.enum(['json', 'csv']).describe('json = canonical llull-pipe-spec file (default); csv = spec sheet.').optional(),
    confirmExportControlled,
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { specId, revision, format = 'json', confirmExportControlled: confirmation }, ctx): CommandResult => {
    const gated = exportRefusal(doc, 'export_pipe_spec', 'data', confirmation, ctx);
    if (gated !== null) return gated;
    const loaded = loadSpec(doc, 'export_pipe_spec', specId, revision, false);
    if (!isLoaded(loaded)) return loaded;
    const { spec } = loaded;
    let text: string;
    let table: string | undefined;
    if (format === 'csv') {
      const rows = componentRows({
        spec,
        catalogs: loaded.catalogs,
        missingCatalogs: [],
        sizes: sizesInRange(spec.sizeRange.from, spec.sizeRange.to),
      });
      text = sheetCsv(
        spec,
        new Map(
          rows.map((entry) => [
            entry.component.id,
            entry.unresolved === undefined &&
              entry.missing.length === 0 &&
              entry.resolved.length > 0 &&
              entry.resolved.every((row) => row.verified),
          ]),
        ),
      );
      table = branchCsv(spec);
    } else text = canonicalSpecText(spec);
    return report(
      doc,
      `export_pipe_spec: ${spec.id} r${spec.revision} as ${format}: ${spec.components.length} component(s), ${new TextEncoder().encode(text).length} bytes.`,
      {
        specId: spec.id,
        revision: spec.revision,
        format,
        text,
        sha256: sha256Hex(text),
        bytes: new TextEncoder().encode(text).length,
        components: spec.components.length,
        ...(table === undefined ? {} : { branchCsv: table }),
      },
    );
  },
});
