/// <reference types="vite/client" />
/**
 * MG0.3 ratchet: the `max-lines` allowlist may only shrink, and must not keep stale entries.
 */
import { describe, it, expect } from 'vitest';
import allowlist from '../../../.eslint-max-lines-allowlist.json';

const BASELINE_COUNT = 30;
const sourceFiles = new Set(
  Object.keys(import.meta.glob(['/src/**/*.{ts,tsx}', '/server/src/**/*.ts'])).map((path) =>
    path.slice(1),
  ),
);

describe('max-lines allowlist ratchet', () => {
  it('never grows past the MG0.3 baseline', () => {
    expect(allowlist.length).toBeLessThanOrEqual(BASELINE_COUNT);
  });
  it('lists only files that still exist', () => {
    expect(allowlist.filter((file) => !sourceFiles.has(file))).toEqual([]);
  });
});
