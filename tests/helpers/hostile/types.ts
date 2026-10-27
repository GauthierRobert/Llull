/** Shape of one entry of the hostile-input harness (`tests/unit/contract/hostileInput.test.ts`): a reader of untrusted text or bytes. */

export type HostileInput = string | Uint8Array;

export interface HostileReader {
  /** Unique, human-readable id (shows in every test name). */
  readonly name: string;
  /** Registered command names and `packages/`-relative `file:function` keys this entry covers (the completeness check reads them). */
  readonly covers: readonly string[];
  /** `text` readers receive strings; `bytes` readers receive Uint8Array (strings from `build` are UTF-8 encoded). */
  readonly input: 'text' | 'bytes';
  /** A valid input with `records` repeated records (the many-tiny-records case and the linear-time scale). */
  readonly build: (records: number) => HostileInput;
  /** Valid input nested `depth` levels deep, for formats that nest. */
  readonly nest?: (depth: number) => HostileInput;
  /** Reader under test: its public pure entry (or `execute` on its import command). May return anything but must not throw. */
  readonly read: (input: HostileInput) => unknown;
  /** Sanity check that `build(3)` really reaches the reader's happy path (guards against a sample that is refused up front). */
  readonly accepts: (result: unknown) => boolean;
  /** Linear-time check is skipped (reason) when the reader refuses large inputs up front by design. */
  readonly skipLinear?: string;
  /** Format-specific hostile inputs (e.g. many unterminated constructs), each run as an extra named case. */
  readonly extra?: readonly { readonly name: string; readonly input: () => HostileInput }[];
  /** The reader costs ~1 s per call (a command that builds geometry): PR mode runs only its empty / whitespace / BOM / truncation cases and skips the happy-path check. */
  readonly costly?: boolean;
  /** Time allowed for one hostile case (default 4000 ms); only for readers with a high constant factor per record. */
  readonly budgetMs?: number;
  /** Largest record count worth timing; default 1 << 18. */
  readonly maxRecords?: number;
}

export const asText = (input: HostileInput): string => (typeof input === 'string' ? input : new TextDecoder().decode(input));
export const asBytes = (input: HostileInput): Uint8Array => (typeof input === 'string' ? new TextEncoder().encode(input) : input);

export const repeated = (head: string, record: (index: number) => string, tail: string, records: number): string => {
  const parts: string[] = [head];
  for (let index = 0; index < records; index++) parts.push(record(index));
  parts.push(tail);
  return parts.join('');
};

/** For readers whose documented failure is a plain `Error` throw: that is a refusal; any other throw (TypeError, RangeError, ...) is a defect. */
export const orRefusal = <T>(read: () => T): T | { readonly refusal: string } => {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && error.constructor === Error) return { refusal: error.message };
    throw error;
  }
};
