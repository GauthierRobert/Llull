/** render_animation parameters. */

import { vec3, z } from '../schema';

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('simulation').describe('Source: run the rigid-body physics (simulate_motion) and draw it in slow or fast motion.'),
    duration: z.number().positive().max(600).describe('Simulated seconds to run (simulate_motion `duration`), at most 600.'),
    timestep: z
      .number()
      .min(1e-5)
      .max(0.01)
      .optional()
      .describe(
        "Integration step in seconds (as simulate_motion). Default: simulate_motion's own rule. Every step is recorded while the run fits 6001 samples.",
      ),
    playbackRate: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe(
        'Simulated seconds shown per video second: 0.01 plays a 0.0628 s run (one crank turn at 954 rpm) as 6.3 s of video. Default 1. Frame k shows t = k · playbackRate / fps.',
      ),
  }),
  z.object({
    kind: z.literal('sweep').describe('Source: drive one kinematic joint or document parameter from start to end.'),
    mode: z
      .enum(['joint', 'parameter'])
      .describe('"joint": drive a kinematic joint (add_joint); "parameter": drive a document parameter (set_parameter).'),
    target: z.string().describe('The joint id (mode joint) or parameter name (mode parameter) to drive.'),
    start: z
      .number()
      .describe('First value: radians for a revolute joint, document units for a prismatic joint, the parameter unit for a parameter.'),
    end: z.number().describe('Last value, same unit as start. Must differ from start.'),
    duration: z
      .number()
      .positive()
      .max(600)
      .describe('Video seconds the sweep lasts (playbackRate is 1); frames = floor(duration · fps) + 1.'),
    pingPong: z.boolean().optional().describe('true: go from start to end and back to start over the duration (default false).'),
  }),
  z.object({
    kind: z.literal('clips').describe('Source: the document animation clips (animate), evaluated as the viewport plays them.'),
    duration: z
      .number()
      .positive()
      .max(600)
      .describe('Video seconds of the animation clips to render (animate, trigger auto; click clips are skipped).'),
  }),
  z.object({
    kind: z
      .literal('still')
      .describe(
        'Source: nothing moves, only the camera does. Needs camera.walkthroughId or camera.orbit (else MOV_NO_MOTION); no trace or readouts.',
      ),
    duration: z.number().positive().max(600).describe('Video seconds to render (playbackRate is 1); frames = floor(duration · fps) + 1.'),
  }),
]);

export const renderAnimationParams = z.object({
  source: sourceSchema.describe('What moves: a simulation, a joint / parameter sweep or the animation clips.'),
  fps: z.number().int().min(1).max(60).optional().describe('Video frames per second, 1..60. Default 30.'),
  width: z.number().optional().describe('Frame width in pixels, clamped to [64, 1920]. Default 1280.'),
  height: z.number().optional().describe('Frame height in pixels, clamped to [64, 1080]. Default 720.'),
  camera: z
    .object({
      view: z
        .enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'])
        .optional()
        .describe(
          'Named view; planar mechanisms read best face-on ("front" for a crank in the XZ plane, "top" for the XY plane). Default "iso".',
        ),
      direction: vec3('Viewing direction [x, y, z] from the scene toward the camera (Z-up). Give this OR view, not both.').optional(),
      viewpointId: z
        .string()
        .optional()
        .describe(
          'A saved viewpoint (save_viewpoint, vp-<n>) used exactly as saved in every frame (not reframed). Not with view / direction / walkthroughId.',
        ),
      walkthroughId: z
        .string()
        .optional()
        .describe(
          'A walkthrough (create_walkthrough, wt-<n>): the camera of frame k is the one render_walkthrough gives at t = k / fps (video time, whatever playbackRate). It holds on the last key when the video is longer (warning MOV_CAMERA_PATH_DURATION). Not with view / direction / viewpointId / orbit.',
        ),
      path: z
        .enum(['linear', 'smooth'])
        .optional()
        .describe(
          'With walkthroughId: "linear" (default) or "smooth" (eye on a Catmull-Rom spline through the keys), as render_walkthrough.',
        ),
      orbit: z
        .object({
          turns: z
            .number()
            .describe(
              'Turns of the camera about the axis over the whole video (negative: the other way), non-zero, at most 100 in magnitude. Frame k is turned by 2π · turns · k / (frames − 1), so one turn ends where it began (the last frame repeats the first; see loop).',
            ),
          loop: z
            .boolean()
            .optional()
            .describe(
              'true: frame k is turned by 2π · turns · k / frames instead, so the last frame stops one step short of the first and a looping GIF / MP4 repeats without a hitch (default false).',
            ),
          axis: vec3('Orbit axis [x, y, z] through the centre of the framed scene. Default [0, 0, 1] (a turntable).').optional(),
        })
        .optional()
        .describe(
          'Turntable: the camera circles the centre of the scene. Starts from view / direction (default "iso", an orthographic camera sized to the circumscribed sphere so nothing leaves the picture) or from viewpointId: then the saved framing is kept (nothing is refitted) and the orbit pivots about the centre of the motion bounds, so the scene may leave the picture. Not with walkthroughId.',
        ),
    })
    .optional()
    .describe(
      'The camera. Default: one fixed iso camera framed on all frames. Moving modes (walkthroughId, orbit) record the camera of each frame in data.timeline[k].camera.',
    ),
  overlays: z
    .object({
      time: z.boolean().optional().describe('Draw "t = … s" (simulated time) top left. Default false.'),
      trace: z
        .array(z.string())
        .max(4)
        .optional()
        .describe(
          'Up to 4 ids whose position is traced: rigid body ids (simulation: centre of mass over all samples) or entity ids (sweep / clips: the entity position over the frames).',
        ),
      readouts: z
        .array(z.string())
        .max(8)
        .optional()
        .describe(
          'Up to 8 quantities shown as "name = value unit" bottom left and listed in data.timeline[k].readouts: simulation: joint ids (deg or document units) and rigid body ids (their centre of mass as id.x, id.y, id.z); sweep: joint ids and parameter names; clips: clip ids (animate).',
        ),
      highlight: z
        .enum(['moving', 'none'])
        .optional()
        .describe('"moving": entities whose pose changes during the run are drawn in the accent colour; "none" (default).'),
      accent: z.string().optional().describe('Accent colour #rgb or #rrggbb for highlight. Default #ff9f1c.'),
    })
    .optional()
    .describe('Pictures drawn into every frame.'),
  format: z
    .enum(['frames', 'apng', 'gif', 'mp4'])
    .optional()
    .describe(
      '"frames", "apng", "gif" or "mp4" (default). gif / mp4 need the native encoder and are refused without it (NATIVE_TOOL_MISSING): retry with format "apng".',
    ),
  quality: z
    .enum(['draft', 'standard', 'high'])
    .optional()
    .describe(
      'Encoder effort for format "mp4" only (gif, frames and apng ignore it): "draft" = a smaller, softer file in the same encode time as "standard" (default); "high" = sharper, about twice the encode time.',
    ),
  sheet: z
    .object({ every: z.number().int().min(1).describe('Every n-th frame becomes a cell (the last frame is always added).') })
    .optional()
    .describe('Also produce sheet.png: a labelled contact sheet of the frames (cells at most 320 px wide, at most 6 columns).'),
  maxFrames: z
    .number()
    .int()
    .min(1)
    .max(1800)
    .optional()
    .describe('Refuse (MOV_FRAME_BUDGET) when the run needs more frames than this. Default and maximum 1800.'),
  background: z.string().optional().describe('Frame background #rgb or #rrggbb. Default #1a1a2e.'),
  renderer: z
    .enum(['reference', 'native'])
    .optional()
    .describe('"reference" (default, deterministic, digests) or "native" (GPU frames through llull-compute, no digests).'),
});
