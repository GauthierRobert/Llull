/**
 * Ambient module declaration for opencascade.js.
 * The package ships no TS types; all narrowing is done in occtKernel.ts via
 * local interfaces. The `any` here is the single concession to the WASM boundary.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module 'opencascade.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: (opts?: { wasmBinary?: Uint8Array; locateFile?: (path: string) => string }) => Promise<any>;
  export default factory;
}
