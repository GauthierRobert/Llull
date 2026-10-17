import type { MaterialLibraryProvider } from './types';

let installed: MaterialLibraryProvider | null = null;

/** Install (or with null, remove) the process material-library provider (`ctx.libraries` of the default context). Composition roots only. */
export function setMaterialLibraryProvider(provider: MaterialLibraryProvider | null): void {
  installed = provider;
}

/** The installed library provider, or null (hosts that build their own context, such as the server, pass theirs). */
export function getMaterialLibraryProvider(): MaterialLibraryProvider | null {
  return installed;
}
