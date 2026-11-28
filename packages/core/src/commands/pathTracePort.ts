import type { PathTracePort } from '../model/pathTrace';

let installed: PathTracePort | null = null;

/** Install (or with null, remove) the process native path tracer (`ctx.pathTrace` of the default context). Composition roots / hosts only. */
export function setPathTracePort(port: PathTracePort | null): void {
  installed = port;
}

/** The installed native path tracer, or null (`render_realistic` then refuses with NATIVE_TOOL_MISSING). */
export function getPathTracePort(): PathTracePort | null {
  return installed;
}
