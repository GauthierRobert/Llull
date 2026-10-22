import type { FontProvider } from '../geometry/fontPort';

let installed: FontProvider | null = null;

/** Install (or with null, remove) the process font provider (`ctx.fonts` of the default context). Composition roots / hosts only. */
export function setFontProvider(provider: FontProvider | null): void {
  installed = provider;
}

/** The installed bundled-font provider, or null (outline text then needs `import_font`). */
export function getFontProvider(): FontProvider | null {
  return installed;
}
