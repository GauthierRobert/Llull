/**
 * Ambient module declaration for the opencascade.js Emscripten glue (the package ships no TS
 * types and its `index.js` imports the .wasm directly, which Node cannot load). All narrowing
 * is done in occtKernel.ts via local interfaces.
 */

declare module 'opencascade.js/dist/opencascade.wasm.js' {
  const factory: (moduleOptions: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
