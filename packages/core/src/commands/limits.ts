/** Upper bounds that keep a single command from allocating unbounded entities/points. */
export const MAX_COPIES_PER_COMMAND = 10_000;
export const MAX_CURVE_SAMPLES = 10_000;
export const MAX_GEAR_TEETH = 1_000;
export const MAX_PROJECT_ACTIONS = 1_000;
export const MAX_PROJECT_STEPS = 10_000;
export const MAX_PROJECT_DEPTH = 4;
/** Total loop iterations (all loops, nested included) one build_project plan may expand to. */
export const MAX_LOOP_ITERATIONS = 1_000;
export const MAX_SPLINE_CONTROL_POINTS = 10_000;
export const MAX_TEMPLATE_ENTITIES = 10_000;
export const MAX_BATCH_IDS = 10_000;
export const MAX_IMPORT_BODIES = 10_000;
export const MAX_IMPORT_TRIANGLES = 2_000_000;
export const MAX_TRACE_FEATURES = 10_000;
export const MAX_DISPLAY_PRECISION = 20;
export const MAX_PROFILE_POINTS = 10_000;
export const MAX_REVOLVE_SEGMENTS = 1_024;
/** Image underlay data URL length in characters (~6 MB of PNG/JPEG); keeps saved documents sane. */
export const MAX_IMAGE_DATA_URL_LENGTH = 8_000_000;
/** Largest raster side in pixels: the common WebGL texture size limit. */
export const MAX_IMAGE_PIXEL_SIDE = 16_384;
