import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { PAPER_SIZES } from '@core/model/sheet';
import { MM_PER_UNIT } from '@core/model/units';
import { sha256Hex } from '@lib/sha256';
import type { CadDocument } from '@core/model/types';
import { refuseIso } from '../codes';
import { GA_ANNOTATIONS, GA_DIRECTIONS, buildPipingGa, type GaLine } from '../ga/pipingGa';
import { buildIsoGraph } from '../iso/isoGraph';
import { dxfOf, svgOf } from '../iso/isoRender';
import { allLineIds, isLineRead, loadLine } from '../lineNetwork';
import { getBuilding } from '../../../building/model';

const fileStem = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, '_');

/** The level of a line: the highest building level at or below its lowest centreline point, else the lowest level (the 02 RTE rule for a run). */
function levelOf(doc: CadDocument, lowestMm: number): string | undefined {
  const levels = Object.values(getBuilding(doc).levels).sort((a, b) => a.elevation - b.elevation);
  const mm = MM_PER_UNIT[doc.units];
  return (levels.filter((level) => level.elevation * mm <= lowestMm + 1e-6).at(-1) ?? levels[0])?.id;
}

/**
 * @affects none (query: returns the same document; the drawing is in `data.files[]`)
 * @invariant to scale (1:scale, paper mm = world mm / scale) from the 3D centrelines of routed, imported and legacy lines; a plan is east right / north up, a section is seen from the side the viewer stands on with the model nearer than cutAt removed; every label is listed with its 3D value; deterministic; always NOT FOR CONSTRUCTION, reviewRequired true
 * @failure unknown line -> ISO_LINE_NOT_FOUND; no piping (or none on the level) -> ISO_NO_PIPING; unknown levelId -> ISO_PARAM_INVALID; export-controlled content without confirmation -> MAT_EXPORT_CONTROLLED
 */
export const exportPipingGa = defineCommand({
  name: 'export_piping_ga',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Draw the piping general arrangement (orthographic, TO SCALE 1:scale) of the pipe lines of the document (routed lines, imported PCF lines and legacy pipe lines alike) as SVG and / or DXF R12: a plan (view plan: east right, north up, with a north arrow) ' +
    'or a section / elevation (view section: seen from the side `direction` the viewer stands on, default south, east right; with cutAt - y for north / south, x for east / west - the model nearer to the viewer than the cut is removed and pipes crossing the cut show their cut circle; without it the whole piping is projected). ' +
    'Pipes of DN at or above doubleLineFromDn (default 100) are drawn double line at their outside diameter (EN 10220 / ASME B36.10 table), smaller ones single line. annotate (default all four): line_label = "<line>-DN<dn>-<spec>" ' +
    '(e.g. L-101-DN100-A1A: PIPELINE-REFERENCE, bore of the first pipe, PIPING-SPEC) along the longest run; cl_elevation = "CL EL +3000" once per distinct horizontal centreline elevation of the line (flow order); ' +
    'bop_elevation = bottom of pipe "BOP EL +2942.85" = CL - OD / 2 (two decimals) for the same levels; flow_arrow = an arrow on every straight run over 1000 mm in the flow direction (component order from the line start). ' +
    'The building is not drawn (combine with export_plan_sheet). levelId keeps the lines whose lowest point is on that level; lineIds keeps the named lines (default all). ' +
    'Returns data = { view, direction?, cutAt?, paper, scale, files: [{ name, format, content, sha256 }], lines: [{ lineId, dn, outsideDiameterMm, spec, doubleLine, drawnSegments }], ' +
    'labels: [{ kind line | cl_elevation | bop_elevation, text, lineId, at (3D mm), sheet (paper mm), valueMm?, rotationDeg? }], arrows: [{ lineId, run, at, direction, sheet }], extentMm, fits, warnings, reviewRequired: true }. ' +
    'Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_NO_PIPING, ISO_PARAM_INVALID (levelId), MAT_EXPORT_CONTROLLED, or the RTE_* code of a routed run that no longer derives. ISO_GA_OVERFLOW is a warning (the drawing is larger than the paper at that scale). Save with llull export_piping_ga --save <dir>.',
  params: z.object({
    view: z.enum(['plan', 'section']).describe('plan = top view; section = elevation / section seen from `direction`.'),
    direction: z
      .enum(GA_DIRECTIONS)
      .optional()
      .describe(
        'Section only: the side the viewer stands on (north / south / east / west; +Y is north). Default south (looking north, east on the right).',
      ),
    cutAt: z
      .number()
      .optional()
      .describe(
        'Section only: the cut plane on the viewing axis, document units (y for north / south, x for east / west). The model nearer to the viewer is removed. Omit for no cut.',
      ),
    paper: z.enum(PAPER_SIZES).describe('Paper size, landscape ISO A0..A4.'),
    scale: z.number().positive().describe('Drawing scale denominator: 50 = 1:50 (paper mm = world mm / 50).'),
    doubleLineFromDn: z
      .number()
      .positive()
      .optional()
      .describe('DN from which pipes are drawn double line (outside diameter). Default 100.'),
    annotate: z
      .array(z.enum(GA_ANNOTATIONS))
      .optional()
      .describe('Annotations to draw: line_label, cl_elevation, bop_elevation, flow_arrow. Default all four.'),
    lineIds: z
      .array(z.string().min(1))
      .optional()
      .describe('Lines to draw: routed line ids, imported PCF line numbers, legacy pipe line numbers. Default every line with piping.'),
    levelId: z
      .string()
      .min(1)
      .optional()
      .describe('Keep only the lines whose lowest centreline point is on this building level (add_level id or name as in the building).'),
    formats: z
      .array(z.enum(['svg', 'dxf']))
      .min(1)
      .optional()
      .describe('Output formats. Default ["svg"].'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_piping_ga', 'sheet', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const everyLine = allLineIds(doc);
    const unknown = (params.lineIds ?? []).filter((id) => !everyLine.includes(id));
    if (unknown.length > 0)
      return refuseIso(
        doc,
        'export_piping_ga',
        'ISO_LINE_NOT_FOUND',
        `no pipe line ${unknown.map((id) => `"${id}"`).join(', ')}`,
        unknown,
        ['lineIds'],
      );
    if (params.levelId !== undefined && getBuilding(doc).levels[params.levelId] === undefined)
      return refuseIso(
        doc,
        'export_piping_ga',
        'ISO_PARAM_INVALID',
        `the building has no level "${params.levelId}"`,
        [params.levelId],
        ['levelId'],
      );
    const wanted = params.lineIds === undefined ? everyLine : [...new Set(params.lineIds)];
    const lines: GaLine[] = [];
    for (const id of wanted) {
      const read = loadLine(doc, 'export_piping_ga', id);
      if (!isLineRead(read)) return read;
      const graph = buildIsoGraph(read.network);
      if (graph.steps.length === 0) continue;
      const lowest = Math.min(...graph.steps.flatMap((step) => [step.start[2], step.end[2]]));
      if (params.levelId !== undefined && levelOf(doc, lowest) !== params.levelId) continue;
      lines.push({ id, network: read.network, graph });
    }
    if (lines.length === 0)
      return refuseIso(
        doc,
        'export_piping_ga',
        'ISO_NO_PIPING',
        params.levelId === undefined ? 'the document has no piping to draw' : `no piping on level ${params.levelId}`,
        [],
        ['lineIds'],
      );
    const direction = params.direction ?? 'south';
    const unit = MM_PER_UNIT[doc.units];
    const ga = buildPipingGa(lines, {
      view: params.view,
      direction,
      cutAt: params.view === 'section' && params.cutAt !== undefined ? params.cutAt * unit : undefined,
      paper: params.paper,
      scale: params.scale,
      doubleLineFromDn: params.doubleLineFromDn ?? 100,
      annotate: params.annotate ?? GA_ANNOTATIONS,
      project: doc.building?.project.name.trim() || 'llull',
    });
    const stem = lines.length === 1 ? fileStem(lines[0]?.network.lineId ?? 'piping') : 'piping';
    const files = (params.formats ?? ['svg'])
      .filter((format, at, all) => all.indexOf(format) === at)
      .map((format) => {
        const content = format === 'svg' ? svgOf(ga.primitives, ga.width, ga.height, ga.title) : dxfOf(ga.primitives);
        return { name: `${stem}_ga_${params.view}.${format}`, format, content, sha256: sha256Hex(content) };
      });
    return report(
      doc,
      `export_piping_ga: ${params.view}${params.view === 'section' ? ` from ${direction}${params.cutAt === undefined ? '' : ` cut at ${params.cutAt}`}` : ''} 1:${params.scale} on ${params.paper}: ` +
        `${lines.length} line(s), ${ga.labels.length} label(s), ${ga.arrows.length} flow arrow(s), ${files.map((file) => file.name).join(', ')}` +
        `${ga.fits ? '' : '; ISO_GA_OVERFLOW: larger than the paper at this scale'}; NOT FOR CONSTRUCTION, review required`,
      {
        view: params.view,
        ...(params.view === 'section' ? { direction, ...(params.cutAt === undefined ? {} : { cutAt: params.cutAt }) } : {}),
        paper: params.paper,
        scale: params.scale,
        files,
        lines: ga.lines,
        labels: ga.labels,
        arrows: ga.arrows,
        extentMm: ga.extentMm,
        fits: ga.fits,
        warnings: ga.warnings,
        reviewRequired: true,
      },
    );
  },
});
