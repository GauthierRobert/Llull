/** The manifold-3d WASM module, loaded and `setup()` once per process; shared by the kernel and the mesh engine. */

/** Version of the installed `manifold-3d` package, recorded in every provenance (07 MSH D7: results are bound to it). */
export const MANIFOLD_VERSION = '3.5.4';

interface SetupModule {
  setup(): void;
}

let cached: unknown = null;

/** The loaded module; callers cast it once to the subset of the API they use. */
export async function loadManifoldModule(): Promise<unknown> {
  if (cached !== null) return cached;
  const factory = (await import('manifold-3d')) as unknown as { default: (options?: unknown) => Promise<SetupModule> };
  const loaded = await factory.default();
  loaded.setup();
  cached = loaded;
  return loaded;
}
