/**
 * `fea_render` transport (aerospace 05 TR-FEA-92, RS1 RS-5): the same plot as `render_fea_results` (pure @cae `fieldPlotRequest` +
 * `fieldPlotLayout`), with the per-pixel raster stage run by `llull-compute raster` for large headless renders. raster: `ts` (the reference
 * and hash path), `cpu` (native CPU twin, bit-identical), `gpu` (wgpu; a picture, `deterministic: false`), `auto` (TS below
 * RASTER_MIN_SAMPLES supersampled pixels, native CPU above). A missing binary or GPU falls back with the reason in `data.raster`.
 * The document is never written; the SVG frame (legend, markers, title) is always the TypeScript one.
 */

import { defaultContext } from '@core/commands/context';
import type { CommandResult } from '@core/commands/types';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { isRecord } from '@lib/isRecord';
import { fieldPlotLayout } from '@cae/results/fieldPlotSvg';
import { finishRaster, prepareRaster, rasterPixels, type PreparedRaster, type RasterPixels } from '@cae/results/fieldRaster';
import { fieldPlotRequest, renderParams } from '@cae/results/plotRequest';
import { feaFailure } from '../fea/feaCommon';
import { f64Bytes, readOutput, withJobFolder } from './computeJob';
import type { NativeDeps } from './fatigueField';

const TOOL = 'fea_render';
/** Supersampled pixels from which `auto` rasters natively (measured crossover incl. the process start, see the 05 spec §13). */
const RASTER_MIN_SAMPLES = 1_000_000;
const RASTER_TIMEOUT_MS = 120_000;

type RasterChoice = 'auto' | 'ts' | 'cpu' | 'gpu';

interface Provenance {
  readonly engine: 'ts' | 'native-cpu' | 'native-gpu';
  readonly deterministic: boolean;
  readonly device?: string;
  readonly reason?: string;
  readonly elapsedMs: number;
}

function jobFiles(prepared: PreparedRaster, engine: 'cpu' | 'gpu'): Record<string, Buffer | string> {
  const { ghostTriangles, triangles, light, normals, owners, caps, ...scalars } = prepared;
  return {
    'job.json': JSON.stringify({ ...scalars, engine }),
    'ghost.f64': f64Bytes(ghostTriangles),
    'triangles.f64': f64Bytes(triangles),
    'light.f64': f64Bytes(light),
    'normals.f64': f64Bytes(normals),
    'owners.f64': f64Bytes(owners),
    'caps.f64': f64Bytes(caps),
  };
}

/** The native raster of `prepared`, or the reason it could not be used. */
async function nativePixels(
  prepared: PreparedRaster,
  engine: 'cpu' | 'gpu',
  deps: NativeDeps,
): Promise<{ readonly pixels: RasterPixels; readonly provenance: Provenance } | string> {
  try {
    return await withJobFolder(
      jobFiles(prepared, engine),
      async (folder) => {
        const run = await deps.runner.run(['raster'], folder, RASTER_TIMEOUT_MS);
        if (!run.ok) return `${run.code ?? 'NATIVE_JOB_FAILED'}: ${run.message ?? 'llull-compute failed'}`;
        const rgba = new Uint8Array(await readOutput(folder, run, 'rgba.bin'));
        const depthBytes = await readOutput(folder, run, 'depth.f32');
        const copy = new Uint8Array(depthBytes.length);
        copy.set(depthBytes);
        const depth = new Float32Array(copy.buffer);
        const samples = prepared.width * prepared.height * prepared.samples * prepared.samples;
        if (rgba.length !== prepared.width * prepared.height * 4 || depth.length !== samples)
          return 'NATIVE_PROTOCOL: raster outputs of the wrong size';
        const gpu = run.warnings.find((warning) => warning.code === 'NATIVE_RASTER_GPU');
        const fallback = run.warnings.find((warning) => warning.code === 'NATIVE_RASTER_CPU_FALLBACK');
        const provenance: Provenance =
          gpu !== undefined
            ? {
                engine: 'native-gpu',
                deterministic: false,
                device: /GPU \((.*)\): a picture/.exec(gpu.message)?.[1] ?? 'gpu',
                elapsedMs: run.elapsedMs,
              }
            : {
                engine: 'native-cpu',
                deterministic: true,
                elapsedMs: run.elapsedMs,
                ...(fallback !== undefined ? { reason: fallback.message } : {}),
              };
        return { pixels: { rgba, depth }, provenance };
      },
      deps.env,
    );
  } catch (error) {
    return `NATIVE_PROTOCOL: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const outcomeOf = (result: CommandResult): FeaToolResult => ({
  summary: result.summary,
  affected: result.affected,
  isError: result.rejected === true,
  ...(result.data !== undefined ? { data: result.data } : {}),
});

/**
 * @failure invalid params -> FEA_PLOT_INVALID; the render_fea_results refusals (FEA_RESULTS_MISSING, FEA_FIELD_MISSING, ...); never fails on the
 *   native side: a missing binary / GPU or a job failure falls back to the TypeScript raster with the reason in data.raster
 */
export async function runFeaRender(params: unknown, host: FeaHost, deps: NativeDeps): Promise<FeaToolResult> {
  const { raster: requested = 'auto', ...rest } = isRecord(params) ? params : {};
  if (!['auto', 'ts', 'cpu', 'gpu'].includes(String(requested)))
    return feaFailure(TOOL, 'FEA_PLOT_INVALID', `raster must be auto, ts, cpu or gpu, got '${String(requested)}'`);
  const parsed = renderParams.safeParse(rest);
  if (!parsed.success)
    return feaFailure(TOOL, 'FEA_PLOT_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  const request = fieldPlotRequest(host.getDoc(), parsed.data, { ...defaultContext(), feaArtifacts: deps.store });
  if (!('plot' in request)) return outcomeOf(request);
  const layout = fieldPlotLayout(request.plot);
  const prepared = prepareRaster(layout.raster);
  const choice = requested as RasterChoice;
  const samples = prepared.width * prepared.height * prepared.samples * prepared.samples;
  const wantsNative = choice === 'cpu' || choice === 'gpu' || (choice === 'auto' && samples >= RASTER_MIN_SAMPLES);
  let reason: string | undefined;
  let native: { readonly pixels: RasterPixels; readonly provenance: Provenance } | null = null;
  if (wantsNative) {
    const attempt = await nativePixels(prepared, choice === 'gpu' ? 'gpu' : 'cpu', deps);
    if (typeof attempt === 'string') reason = attempt;
    else native = attempt;
  }
  const started = Date.now();
  const pixels = native?.pixels ?? rasterPixels(prepared);
  const provenance: Provenance = native?.provenance ?? {
    engine: 'ts',
    deterministic: true,
    elapsedMs: Date.now() - started,
    ...(reason !== undefined ? { reason } : {}),
  };
  const finished = layout.finish(finishRaster(layout.raster, prepared, pixels));
  const result = outcomeOf(request.finish(finished.svg, finished.facesDrawn));
  const engineText =
    provenance.engine === 'ts'
      ? `TypeScript raster${reason !== undefined ? ` (native unavailable: ${reason})` : ''}`
      : `${provenance.engine} raster`;
  return {
    ...result,
    summary: `${TOOL}: ${engineText}, ${samples} supersampled pixels in ${provenance.elapsedMs} ms. ${result.summary}`,
    data: { ...(isRecord(result.data) ? result.data : {}), raster: provenance },
  };
}
