// troika-three-text ships no types: only the builder configuration llull calls (src/ui/viewport/textFont.ts) is declared.
declare module 'troika-three-text' {
  export function configureTextBuilder(config: { useWorker?: boolean; sdfGlyphSize?: number; textureWidth?: number }): void;
}
