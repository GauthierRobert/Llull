/** A cap on untrusted input was hit (archive or deflate output): stable `code`, the `limit` in bytes and the size the input `declared` (null when unknown). */
export class LimitError extends Error {
  constructor(
    readonly code: 'ZIP_LIMIT_EXCEEDED' | 'INFLATE_LIMIT_EXCEEDED',
    detail: string,
    readonly limit: number,
    readonly declared: number | null,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'LimitError';
  }
}
