/** @layer server — the outcome of one CLI call, the same shape whichever backend ran it. */

export interface CliRunResult {
  readonly summary: string;
  readonly affected: readonly string[];
  readonly isError: boolean;
  /** The document was replaced (and saved, for a local backend not in dry-run). */
  readonly changed: boolean;
  readonly data?: unknown;
}
