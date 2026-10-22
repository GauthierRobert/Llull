/** The fonts a host ships with the app (03 WRP, D-WRP-3): listed and read by id, never by path. Injected as `ctx.fonts` so core never reads files. */

export interface BundledFont {
  /** Stable id, e.g. `fira-sans-regular`. */
  readonly id: string;
  readonly family: string;
  readonly style: string;
  readonly licence: string;
  /** Pinned sha256 (hex) of the font bytes: a bundled font whose bytes differ is not offered. */
  readonly sha256: string;
  readonly source: string;
}

export interface FontProvider {
  list(): readonly BundledFont[];
  /** The bytes of bundled font `id`, null when unknown or unreadable. */
  bytes(id: string): Uint8Array | null;
}
