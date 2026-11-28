/**
 * render_realistic (RV1 RV-M3): a physically based, path-traced picture of the document by the native `llull-compute pathtrace` job
 * (`ctx.pathTrace`). render_view stays the deterministic technical raster; this is an illustration, never a reference for a measurement.
 * @affects nothing — read-only; document returned unchanged, affected: []
 * @invariant the scene is every visible 3D entity and instance-array member (instances traced without expansion), the appearance of each
 *   (entity override over material), the light entities (else the default 3 W/m² sun), the environment and one camera (RV1 §5b)
 * @invariant data.deterministic is the native report: true only for the CPU path that was not stopped by maxSeconds (PERF1 rule 4)
 * @failure no ctx.pathTrace -> NATIVE_TOOL_MISSING; nothing visible -> RENDER_SCENE_EMPTY; over the instance / triangle limit ->
 *   RENDER_SCENE_TOO_LARGE; camera problems -> SCENE_CAMERA_NOT_FOUND / SCENE_NOT_A_CAMERA / SCENE_CAMERA_INVALID / VIS_VIEWPOINT_NOT_FOUND /
 *   VIS_CAMERA_INVALID / RENDER_CAMERA_INVALID; no light at all -> RENDER_NO_LIGHT; an HDR environment record missing or a texture whose
 *   bytes this host lacks -> TEXTURE_ASSET_UNAVAILABLE; the native job's own code (e.g. PATHTRACE_JOB_INVALID) is passed on. All no-op.
 */

import { defineCommand, vec3, z } from '../../schema';
import { codedRejection } from '../../noop';
import type { CadDocument } from '../../../model/types';
import type { PathTraceJob, PathTraceScene } from '../../../model/pathTrace';
import { toMetres } from '../../../model/units';
import { MaterialBank } from './sceneMaterials';
import { collectSceneGeometry } from './sceneGeometry';
import { sceneEnvironment, sceneLighting } from './sceneLights';
import { realisticCamera } from './realisticCamera';
import { realisticResult } from './realisticResult';

const NAME = 'render_realistic';
/** Named guards: instance rows (4,000,000-member arrays fit twice) and unique triangles the job is given. */
export const MAX_RENDER_INSTANCES = 8_000_000;
export const MAX_RENDER_TRIANGLES = 50_000_000;

const params = z.object({
  camera: z
    .string()
    .optional()
    .describe('Camera entity id (add_camera): its position, aim, field of view and depth of field (fStop, focusDistance).'),
  viewpointId: z.string().optional().describe('Saved viewpoint (list_viewpoints) to render from instead of a camera entity.'),
  view: z
    .enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'])
    .optional()
    .describe('Named direction when no camera / viewpoint is given (default "iso"), framed on the scene as render_view does.'),
  direction: vec3('Custom direction [x, y, z] from the scene toward the camera (Z up); overrides `view`.').optional(),
  target: vec3('World point the camera looks at (default: the centre of the scene bounds).').optional(),
  zoom: z.number().min(0.1).max(50).optional().describe('Magnification of the framed scene, 0.1..50 (default 1 fits the whole scene).'),
  projection: z
    .enum(['perspective', 'orthographic'])
    .optional()
    .describe('Projection of a named / custom view (default "perspective"); a camera entity is always perspective.'),
  fovDeg: z
    .number()
    .optional()
    .describe('Vertical field of view of a perspective named view, degrees in (0, 180) (default: the viewport).'),
  width: z.number().int().min(16).max(8192).optional().describe('Picture width in pixels, 16..8192 (default 1280; rendered in tiles).'),
  height: z.number().int().min(16).max(8192).optional().describe('Picture height in pixels, 16..8192 (default 720).'),
  samples: z
    .number()
    .int()
    .min(1)
    .max(65536)
    .optional()
    .describe('Samples per pixel, 1..65536 (default 128); the upper bound with targetNoise.'),
  targetNoise: z
    .number()
    .min(0.001)
    .max(0.5)
    .optional()
    .describe(
      'Stop a tile early once its relative noise (standard error / mean luminance) is below this, e.g. 0.02 (default: run every sample).',
    ),
  maxBounces: z
    .number()
    .int()
    .min(0)
    .max(64)
    .optional()
    .describe(
      'Longest light path in scattering events, 0..64 (default 8; 1 = direct light only, 0 = emission and environment seen directly).',
    ),
  seed: z
    .number()
    .int()
    .min(0)
    .max(4294967295)
    .optional()
    .describe('Random seed (default 0): the same seed renders the same CPU image bit for bit.'),
  denoise: z
    .boolean()
    .optional()
    .describe('Apply the local edge-aware denoiser guided by albedo / normal / depth (default false: reference renders stay unfiltered).'),
  engine: z
    .enum(['cpu', 'gpu'])
    .optional()
    .describe('"cpu" (default, deterministic) or "gpu" (falls back to the CPU with data.fallbackReason when no GPU path tracer runs).'),
  exposure: z
    .number()
    .min(-20)
    .max(20)
    .optional()
    .describe('Exposure in EV applied before the view transform (default 0: radiance 1 is near white).'),
  ground: z
    .boolean()
    .optional()
    .describe(
      'Add a matte grey ground plane under the model (site ground elevation, else the lowest point) to catch shadows (default true).',
    ),
  exr: z.boolean().optional().describe('Also return the scene-linear OpenEXR (RGBA half) as data.files render.exr (default true).'),
  maxSeconds: z
    .number()
    .min(1)
    .max(86400)
    .optional()
    .describe('Stop sampling after this many seconds (default 600); a render stopped by time is marked deterministic false.'),
});

type Params = z.infer<typeof params>;

function jobOf(
  doc: CadDocument,
  p: Params,
  width: number,
  height: number,
): Omit<PathTraceJob, 'camera' | 'meshes' | 'materials' | 'instanceCount' | 'textures' | 'lights' | 'environment'> {
  return {
    kind: 'pathtrace',
    version: 1,
    width,
    height,
    samples: p.samples ?? 128,
    targetNoise: p.targetNoise ?? null,
    maxBounces: p.maxBounces ?? 8,
    seed: p.seed ?? 0,
    denoise: p.denoise ?? false,
    engine: p.engine ?? 'cpu',
    exr: p.exr ?? true,
    png: true,
    exposure: p.exposure ?? 0,
    maxSeconds: p.maxSeconds ?? 600,
    unitMetres: toMetres(doc, 1),
  };
}

const anyPositive = (values: readonly number[]): boolean => values.some((v) => v > 0);

export const renderRealistic = defineCommand({
  name: NAME,
  annotations: { readOnly: true, writesArtifact: true, readsMeshTriangles: 'document' },
  description:
    'Path-traced, physically based picture of the document (an illustration, not a measurement): global illumination, reflection and ' +
    'refraction, soft shadows from every light, depth of field. Draws every visible 3D entity and instance-array member with its ' +
    'appearance (set_material_appearance / apply_appearance; textures from import_texture), the light entities (add_light; none = one ' +
    'default sun of 3 W/m2 from the site sun or the default key light), the environment (set_environment; none = the site sky, else a ' +
    'uniform default) and an optional ground plane. Camera: `camera` (add_camera, with depth of field), `viewpointId`, or a framed ' +
    '`view` / `direction` (perspective by default). Runs the native path tracer (llull-compute pathtrace; NATIVE_TOOL_MISSING without it). ' +
    'Returns data { files [render.png (tone-mapped sRGB, base64), render.exr (scene-linear RGBA half) when exr; an EXR over 160 MiB is a host file data.file], width, ' +
    'height, samples (mean per pixel), seed, device, deterministic, stoppedBy (samples | noise | time), noise, denoised, elapsedMs, ' +
    'triangles, instances, illustration: true }. `llull … render_realistic --save out.png` (or out.exr, or a folder) writes the files. ' +
    'render_view stays the deterministic technical raster. Does NOT modify the document.',
  params,
  run(doc, p, ctx) {
    const port = ctx?.pathTrace ?? null;
    if (port === null)
      return codedRejection(
        doc,
        NAME,
        'NATIVE_TOOL_MISSING',
        'no native path tracer on this host (llull-compute with the pathtrace job)',
        'run through the llull CLI or the desktop app with llull-compute installed (LLULL_COMPUTE / LLULL_NATIVE_DIR), or use render_view',
      );
    const width = p.width ?? 1280;
    const height = p.height ?? 720;
    const bank = new MaterialBank(doc.appearance?.textures ?? {});
    const ground = (p.ground ?? true) ? { elevation: doc.siteContext?.groundElevation ?? null } : undefined;
    const geometry = collectSceneGeometry(doc, bank, { maxInstances: MAX_RENDER_INSTANCES, maxTriangles: MAX_RENDER_TRIANGLES }, ground);
    if (geometry.bounds === null)
      return codedRejection(doc, NAME, 'RENDER_SCENE_EMPTY', 'nothing visible to render', 'add a solid, or make its layer visible');
    if (geometry.overBudget)
      return codedRejection(
        doc,
        NAME,
        'RENDER_SCENE_TOO_LARGE',
        `the scene has more than ${MAX_RENDER_INSTANCES} placed parts or ${MAX_RENDER_TRIANGLES} unique triangles (${geometry.triangles})`,
        'hide layers you do not need, or decimate the heaviest meshes (decimate_mesh)',
      );
    const view = realisticCamera(doc, p, width, height, geometry.bounds);
    if ('code' in view)
      return codedRejection(doc, NAME, view.code, view.message, 'pass an existing camera (list_entities kind camera) or a named view');
    const lighting = sceneLighting(doc);
    const environment = sceneEnvironment(doc, bank);
    if ('missing' in environment)
      return codedRejection(
        doc,
        NAME,
        'TEXTURE_ASSET_UNAVAILABLE',
        `the HDR environment texture '${environment.missing}' is not an hdr texture of this document`,
        'set_environment source "hdr" with an import_texture .hdr id, or another source',
      );
    const env = environment.environment;
    const lit =
      lighting.lights.some((light) => anyPositive('irradiance' in light ? light.irradiance : light.power)) ||
      (env.type === 'color' ? env.intensity > 0 && anyPositive(env.color) : env.type === 'default' || env.intensity > 0) ||
      bank.materials.some((material) => anyPositive(material.emission));
    if (!lit)
      return codedRejection(
        doc,
        NAME,
        'RENDER_NO_LIGHT',
        'no light reaches the scene (zero lights, black environment, no emission)',
        'add_light, or set_environment with intensity > 0',
      );
    const textureBytes: Uint8Array[] = [];
    for (const record of bank.textureRecords) {
      const bytes = ctx?.imageAssets?.readImage(record.key) ?? null;
      if (bytes === null)
        return codedRejection(
          doc,
          NAME,
          'TEXTURE_ASSET_UNAVAILABLE',
          `texture '${record.id}' (${record.name}) is not in this host's image asset store`,
          'import_texture the file again on this machine, or remove_texture it',
          [record.id],
        );
      textureBytes.push(bytes);
    }
    const scene: PathTraceScene = {
      job: {
        ...jobOf(doc, p, width, height),
        camera: view.camera,
        meshes: geometry.meshes,
        materials: bank.materials,
        instanceCount: geometry.instanceCount,
        textures: bank.textures,
        lights: lighting.lights,
        environment: env,
      },
      positions: geometry.positions,
      normals: geometry.normals,
      uvs: geometry.uvs,
      indices: geometry.indices,
      instances: geometry.instances,
      textureBytes,
    };
    const outcome = port.render(scene);
    if (!outcome.ok)
      return codedRejection(
        doc,
        NAME,
        outcome.code,
        outcome.message,
        'check the llull-compute installation, or lower width / height / samples',
      );
    return realisticResult(
      doc,
      scene,
      outcome.image,
      { cameraId: p.camera, lighting: lighting.note, environment: environment.note },
      ctx?.exportFiles ?? null,
    );
  },
});
