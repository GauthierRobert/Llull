/** Lifetime helpers for native (WASM heap) objects of the geometry kernels, freed with `delete()`. */

/** A native object the kernel must free explicitly. */
export interface NativeObject {
  delete(): void;
}

/** Free a native object; the kernel may already have released it, so failures are ignored. */
export function release(native: NativeObject | null): void {
  try {
    native?.delete();
  } catch {
    /* already released */
  }
}

/**
 * Run `body` with an `own` registrar and release every native it registered afterwards. A throw
 * is reported to `onError` and maps to null.
 */
export function withOwned<N extends NativeObject, T>(
  body: (own: <H extends N | null>(native: H) => H) => T | null,
  onError: (error: unknown) => void = () => undefined,
): T | null {
  const owned: Array<N | null> = [];
  try {
    return body((native) => {
      owned.push(native);
      return native;
    });
  } catch (error) {
    onError(error);
    return null;
  } finally {
    owned.forEach(release);
  }
}
