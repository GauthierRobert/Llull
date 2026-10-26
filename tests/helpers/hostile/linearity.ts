/** Relative-time linearity measurement: robust to machine load (min of several runs, best of several attempts). */
import type { HostileReader } from './types';

const MIN_MS = 20;
const ATTEMPTS = 4;
const RUNS = 3;

export interface Linearity {
  readonly records: number;
  readonly small: number;
  readonly large: number;
  readonly ratio: number;
}

const fastest = (reader: HostileReader, records: number): number => {
  const input = reader.build(records);
  let best = Infinity;
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    reader.read(input);
    best = Math.min(best, performance.now() - started);
  }
  return best;
};

/** Smallest record count (doubling) whose single read takes at least MIN_MS, capped by `maxRecords` and by a 1.5 s read. */
function calibrate(reader: HostileReader): number {
  const cap = reader.maxRecords ?? 1 << 18;
  let records = 64;
  for (;;) {
    const input = reader.build(records);
    const started = performance.now();
    reader.read(input);
    const elapsed = performance.now() - started;
    if (elapsed >= MIN_MS || records >= cap || elapsed > 400) return records;
    records *= 2;
  }
}

/** Ratio time(4n) / time(n); the best (lowest) of up to ATTEMPTS attempts, stopping at the first one <= 8. */
export function measureLinearity(reader: HostileReader): Linearity {
  const records = calibrate(reader);
  let best: Linearity = { records, small: 0, large: 0, ratio: Infinity };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const small = fastest(reader, records);
    const large = fastest(reader, records * 4);
    const ratio = large / Math.max(small, 0.5);
    if (ratio < best.ratio) best = { records, small, large, ratio };
    if (best.ratio <= 8) break;
  }
  return best;
}
