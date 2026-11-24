/**
 * `cfd_render` transport (12 CFD TECHNICAL_SPEC M3b): `render_view` of the document with the computed flow drawn over it. The recorded result is
 * read through the same transports the Flow panel uses (`cfd_slice`, `cfd_streamlines`: refused unless trusted and current), their stored files
 * are decoded and projected with the camera `render_view` reports, and the layers are appended to its SVG (`--save view.png` rasterizes it).
 * Composed here, not as a `render_view` overlay kind: a core overlay sees only the document and a point-cloud port, never the result files.
 * The document is never changed; the overlay is drawn over the surface (like the cage / net overlays), not depth-tested.
 */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { makeProjector, type Projector } from '@core/commands/render/camera';
import { referenceProvenance } from '@core/commands/render/rendererProvenance';
import { appendBeforeClose } from '@core/commands/render/svg';
import { toMetres } from '@core/model/units';
import type { CadDocument, Vec3 } from '@core/model/types';
import { appendAll } from '@lib/appendAll';
import { escapeXml } from '@lib/escapeXml';
import { isRecord } from '@lib/isRecord';
import { resultColor } from '@lib/isoBands';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { parseSliceFile, parseStreamlinesFile, type SliceFile, type StreamlinesFile } from '@aero/index';
import { feaFailure } from '../fea/feaCommon';
import type { NativeDeps } from '../native/fatigueField';
import { cfdFileStore } from './fileStore';
import { runCfdQuery } from './flowQuery';

const TOOL = 'cfd_render';
/** Named caps of what is drawn (the picture, not the data, is thinned): cells a side of a slice, segments of all streamlines. */
const MAX_SLICE_CELLS_PER_SIDE = 96;
const MAX_SEGMENTS = 60_000;
const UNIT_OF: Readonly<Record<string, string>> = { speed: 'm/s', p: 'Pa', cp: '', ux: 'm/s', uy: 'm/s', uz: 'm/s' };

interface Range {
  readonly min: number;
  readonly max: number;
}

const fail = (code: string, message: string, ids: readonly string[] = []): FeaToolResult => ({
  ...feaFailure(TOOL, code, message, ids),
  data: { code },
});

const fraction = (value: number, range: Range): number =>
  range.max > range.min ? Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min))) : 0.5;

function rangeOf(values: Iterable<number>): Range | null {
  let [min, max] = [Infinity, -Infinity];
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return min <= max ? { min, max } : null;
}

const number3 = (n: number): string => String(Math.round(n * 100) / 100);

/** The slice as coloured quads (one per drawn sample, thinned to MAX_SLICE_CELLS_PER_SIDE a side); polygons drawn, and the value range. */
function sliceLayer(
  slice: SliceFile,
  toScene: (p: Vec3) => [number, number],
  perMetre: number,
): { svg: string[]; range: Range | null; cells: number } {
  const range = rangeOf(slice.values);
  const stride = Math.max(1, Math.ceil(slice.samples / MAX_SLICE_CELLS_PER_SIDE));
  const half = 0.5 * stride * slice.spacingM;
  const point = (iu: number, iv: number, du: number, dv: number): [number, number] => {
    const s = iu * slice.spacingM + du;
    const t = iv * slice.spacingM + dv;
    return toScene([
      (slice.origin[0] + s * slice.axisU[0] + t * slice.axisV[0]) * perMetre,
      (slice.origin[1] + s * slice.axisU[1] + t * slice.axisV[1]) * perMetre,
      (slice.origin[2] + s * slice.axisU[2] + t * slice.axisV[2]) * perMetre,
    ]);
  };
  const svg: string[] = [];
  if (range === null) return { svg, range, cells: 0 };
  for (let iv = 0; iv < slice.samples; iv += stride)
    for (let iu = 0; iu < slice.samples; iu += stride) {
      const value = slice.values[iv * slice.samples + iu] ?? Number.NaN;
      if (!Number.isFinite(value)) continue;
      const corners = [point(iu, iv, -half, -half), point(iu, iv, half, -half), point(iu, iv, half, half), point(iu, iv, -half, half)];
      svg.push(
        `    <polygon points="${corners.map(([x, y]) => `${number3(x)},${number3(y)}`).join(' ')}" fill="${resultColor(fraction(value, range))}"/>`,
      );
    }
  return { svg, range, cells: svg.length };
}

/** The streamlines as speed-coloured segments (thinned to MAX_SEGMENTS in all); the speed range. */
function linesLayer(
  file: StreamlinesFile,
  toScene: (p: Vec3) => [number, number],
  perMetre: number,
): { svg: string[]; range: Range | null } {
  const range = rangeOf(file.speeds);
  const svg: string[] = [];
  if (range === null) return { svg, range };
  const step = Math.max(1, Math.ceil(file.speeds.length / MAX_SEGMENTS));
  const at = (k: number): [number, number] =>
    toScene([
      (file.positions[3 * k] ?? 0) * perMetre,
      (file.positions[3 * k + 1] ?? 0) * perMetre,
      (file.positions[3 * k + 2] ?? 0) * perMetre,
    ]);
  for (let line = 0; line < file.lineCount; line++) {
    const [from, to] = [file.offsets[line] ?? 0, file.offsets[line + 1] ?? 0];
    for (let k = from; k < to - 1; k += step) {
      const next = Math.min(k + step, to - 1);
      const [a, b] = [at(k), at(next)];
      svg.push(
        `    <line x1="${number3(a[0])}" y1="${number3(a[1])}" x2="${number3(b[0])}" y2="${number3(b[1])}" stroke="${resultColor(fraction(file.speeds[k] ?? 0, range))}"/>`,
      );
    }
  }
  return { svg, range };
}

/** Legend: the colour ramp with the field, unit and min .. max (bottom left of the picture). */
function legend(label: string, range: Range, height: number, row: number): string[] {
  const y = height - 18 - 38 * row;
  const bars = Array.from(
    { length: 16 },
    (_, k) => `    <rect x="${10 + k * 8}" y="${y}" width="8" height="8" fill="${resultColor(k / 15)}"/>`,
  );
  return [
    `    <text x="10" y="${y - 4}" font-family="sans-serif" font-size="11" fill="#ffffff">${escapeXml(label)}</text>`,
    ...bars,
    `    <text x="10" y="${y + 20}" font-family="sans-serif" font-size="10" fill="#ffffff">${number3(range.min)}</text>`,
    `    <text x="138" y="${y + 20}" text-anchor="end" font-family="sans-serif" font-size="10" fill="#ffffff">${number3(range.max)}</text>`,
  ];
}

interface Queried {
  readonly file: Buffer;
  readonly data: Record<string, unknown>;
}

/** One query through its own transport (trust and staleness refusals included), then its stored file; or the failure. */
async function queried(
  op: 'slice' | 'streamlines',
  params: Record<string, unknown>,
  host: FeaHost,
  deps: NativeDeps,
  signal: AbortSignal | undefined,
): Promise<Queried | FeaToolResult> {
  const result = await runCfdQuery(op, params, host, deps, { signal });
  if (result.isError) return result;
  const data = isRecord(result.data) ? result.data : {};
  const sha = isRecord(data['file']) ? data['file']['sha256'] : undefined;
  const file = typeof sha === 'string' ? cfdFileStore(deps.store.directory).get(sha) : null;
  if (file === null) return fail('CFD_RESULT_MISSING', `the ${op} file the query stored is not in this machine's store: run it again`);
  return { file, data };
}

const isFailure = (value: Queried | FeaToolResult): value is FeaToolResult => 'summary' in value;

/** Why the render params cannot carry an overlay (core's `render_view` draws none on these), or null. */
function perspectiveRefusal(renderParams: Record<string, unknown>): string | null {
  if (renderParams['turntable'] !== undefined) return 'a turntable strip takes no overlay: render one view';
  if (renderParams['projection'] === 'perspective' || renderParams['fovDeg'] !== undefined)
    return 'the overlay needs an orthographic view (no projection perspective / fovDeg)';
  return null;
}

/**
 * @failure caseId missing / neither slice nor streamlines, a turntable, a perspective projection / fovDeg / viewpoint -> CFD_PARAM_INVALID; the query refusals of cfd_slice / cfd_streamlines (CFD_CASE_NOT_FOUND,
 *   CFD_NO_RESULT, CFD_RESULT_MISSING, CFD_RESULT_HASH_MISMATCH, CFD_RESULT_STALE, CFD_SOLVER_MISSING, ...), nothing is rendered; a refused
 *   render_view -> its own error; an undecodable stored file -> CFD_SOLVER_FAILED
 */
export async function runCfdRender(params: unknown, host: FeaHost, deps: NativeDeps, signal?: AbortSignal): Promise<FeaToolResult> {
  const { caseId, slice, streamlines, ...renderParams } = isRecord(params) ? params : ({} as Record<string, unknown>);
  if (typeof caseId !== 'string' || caseId === '') return fail('CFD_PARAM_INVALID', `${TOOL}: caseId is required`);
  if (slice === undefined && streamlines === undefined)
    return fail(
      'CFD_PARAM_INVALID',
      `${TOOL}: give slice and / or streamlines (the params of cfd_slice / cfd_streamlines without caseId)`,
      [caseId],
    );
  for (const [name, value] of [
    ['slice', slice],
    ['streamlines', streamlines],
  ] as const)
    if (value !== undefined && !isRecord(value)) return fail('CFD_PARAM_INVALID', `${TOOL}: ${name} must be an object`, [caseId]);

  const perspective = perspectiveRefusal(renderParams);
  if (perspective !== null) return fail('CFD_PARAM_INVALID', `${TOOL}: ${perspective}`, [caseId]);
  const doc = host.getDoc();
  const sliceAnswer = isRecord(slice) ? await queried('slice', { ...slice, caseId }, host, deps, signal) : undefined;
  if (sliceAnswer !== undefined && isFailure(sliceAnswer)) return sliceAnswer;
  const linesAnswer = isRecord(streamlines) ? await queried('streamlines', { ...streamlines, caseId }, host, deps, signal) : undefined;
  if (linesAnswer !== undefined && isFailure(linesAnswer)) return linesAnswer;
  if (signal?.aborted === true) return fail('CFD_CANCELLED', `${TOOL}: cancelled`, [caseId]);

  const sliceFile = sliceAnswer === undefined ? undefined : parseSliceFile(sliceAnswer.file);
  const linesFile = linesAnswer === undefined ? undefined : parseStreamlinesFile(linesAnswer.file);
  for (const decoded of [sliceFile, linesFile])
    if (typeof decoded === 'string') return fail('CFD_SOLVER_FAILED', `${TOOL}: ${decoded}`, [caseId]);

  const rendered = execute(doc, 'render_view', renderParams, defaultContext());
  if (rendered.rejected === true || !isRecord(rendered.data))
    return { summary: `${TOOL}: ${rendered.summary}`, affected: rendered.affected, isError: true, data: rendered.data };
  const view = rendered.data as {
    svg: string;
    camera: Parameters<typeof makeProjector>[0];
    renderer?: string;
    orthoHalf: number;
    width: number;
    height: number;
  };
  if (view.camera.fovDeg !== undefined)
    return fail(
      'CFD_PARAM_INVALID',
      `${TOOL}: the picture is a perspective view (a saved viewpoint?): the overlay needs an orthographic one`,
      [caseId],
    );
  const project: Projector = makeProjector(view.camera, view.orthoHalf, view.width, view.height);
  const perMetre = 1 / toMetres(doc as Pick<CadDocument, 'units'>, 1);

  const layers: string[] = [];
  const cfd: Record<string, unknown> = { caseId };
  const legends: string[] = [];
  if (sliceFile !== undefined && typeof sliceFile !== 'string' && sliceAnswer !== undefined) {
    const drawn = sliceLayer(sliceFile, project, perMetre);
    appendAll(layers, ['  <g class="cfd-slice" opacity="0.85">', ...drawn.svg, '  </g>']);
    const field = String(isRecord(slice) && typeof slice['field'] === 'string' ? slice['field'] : 'speed');
    if (drawn.range !== null)
      appendAll(legends, legend(`${field}${UNIT_OF[field] ? ` (${UNIT_OF[field]})` : ''}`, drawn.range, view.height, 0));
    cfd['slice'] = { file: sliceAnswer.data['file'], field, cells: drawn.cells, range: drawn.range };
  }
  if (linesFile !== undefined && typeof linesFile !== 'string' && linesAnswer !== undefined) {
    const drawn = linesLayer(linesFile, project, perMetre);
    appendAll(layers, ['  <g class="cfd-streamlines" stroke-width="1.4" stroke-linecap="round" fill="none">', ...drawn.svg, '  </g>']);
    if (drawn.range !== null)
      appendAll(legends, legend('streamline speed (m/s)', drawn.range, view.height, sliceFile === undefined ? 0 : 1));
    cfd['streamlines'] = { file: linesAnswer.data['file'], lines: linesFile.lineCount, segments: drawn.svg.length, range: drawn.range };
  }
  const svg = appendBeforeClose(view.svg, [...layers, '  <g class="cfd-legend">', ...legends, '  </g>'].join('\n'));
  const parts = [sliceFile === undefined ? '' : 'a slice', linesFile === undefined ? '' : 'streamlines'].filter((part) => part !== '');
  return {
    summary: `${TOOL}: ${rendered.summary} Drawn over it: ${parts.join(' and ')} of the recorded result of '${caseId}'.`,
    affected: [caseId],
    isError: false,
    // the provenance of render_view describes ITS svg: over the composed one it is recomputed (a native / viewport picture carries none)
    data: { ...rendered.data, svg, ...(view.renderer === 'reference' ? referenceProvenance(svg) : {}), cfd },
  };
}
