// Shader compile failures of the GPU preview: three reports them to `renderer.debug.onShaderError` with the GL context and the compiled shaders; the
// fragment source carries `// llull-gpu:<key>`, so the failure reaches the preview that owns that program, which then falls back to the mesh.

import type { WebGLRenderer } from 'three';

const handlers = new Map<string, () => void>();

/** Calls `onFailure` when the program with `key` fails to compile or link; returns the unregistration. */
export function watchShaderFailure(debug: WebGLRenderer['debug'] | undefined, key: string, onFailure: () => void): () => void {
  if (debug === undefined) return () => undefined;
  handlers.set(key, onFailure);
  debug.onShaderError = (gl, _program, _vertex, fragment) => {
    const found = /llull-gpu:(\w+)/.exec(gl.getShaderSource(fragment) ?? '');
    if (found?.[1] !== undefined) handlers.get(found[1])?.();
  };
  return () => {
    handlers.delete(key);
  };
}
