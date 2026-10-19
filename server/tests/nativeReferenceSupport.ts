/**
 * Shared fixtures of the VC-KRN-25 suites: the native `llull-kernel` (OCCT 7.9.2) against the OCP 7.9.3.1 reference numbers the 01 KRN
 * validation pack recorded (docs/aerospace/01-exact-brep-kernel/validation). One sidecar per file, no WASM kernel: the reference is the
 * committed JSON, not another engine. Skips with a logged reason without the binary (`LLULL_REQUIRE_NATIVE_KERNEL=1` fails instead).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import type { ShapeRecipe } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { decodeMesh, nativeArgs } from '../src/native/kernelProtocol';
import { createKernelSession, spawnKernelChild, type NativeKernelSession } from '../src/native/kernelSession';
import { nativeKernelBinary } from './kernelTestSupport';
import { handleOf } from './nativeKernelCorpus';

export { nativeKernelBinary };

const VALIDATION_DIR = path.resolve(__dirname, '../../docs/aerospace/01-exact-brep-kernel/validation');

export const readReference = <T>(file: string): T => JSON.parse(readFileSync(path.join(VALIDATION_DIR, file), 'utf8')) as T;

interface NativeReferenceHarness {
  /** Reply of `op` (KernelOps arguments; recipes are sent as handles); fails the test on an error reply. */
  call(op: string, args: readonly unknown[]): Promise<unknown>;
  /** Reply of `op` on the recipe's handle. */
  on(op: string, recipe: ShapeRecipe, ...rest: readonly unknown[]): Promise<unknown>;
  /** A second, independent sidecar process (cross-process determinism); closed with the first. */
  fresh(): NativeReferenceHarness;
}

function harnessOver(open: () => NativeKernelSession): NativeReferenceHarness {
  const call = async (op: string, args: readonly unknown[]): Promise<unknown> => {
    const reply = await open().request(op, nativeArgs(op, args));
    expect(reply.error, `${op} error`).toBeUndefined();
    return op === 'tessellate' ? decodeMesh(reply.result) : reply.result;
  };
  return {
    call,
    on: (op, recipe, ...rest) => call(op, [handleOf(recipe), ...rest]),
    fresh: () => {
      let session: NativeKernelSession | null = null;
      const opened = (): NativeKernelSession => (session ??= track(createKernelSession(spawnKernelChild(nativeKernelBinary!))));
      return harnessOver(opened);
    },
  };
}

const sessions: NativeKernelSession[] = [];
const track = (session: NativeKernelSession): NativeKernelSession => {
  sessions.push(session);
  return session;
};

/** One sidecar for the calling file (call at module level). */
export function nativeReferenceHarness(): NativeReferenceHarness {
  let session: NativeKernelSession | null = null;
  beforeAll(() => {
    if (nativeKernelBinary !== null) session = track(createKernelSession(spawnKernelChild(nativeKernelBinary)));
  });
  afterAll(() => sessions.splice(0).forEach((open) => open.close()));
  return harnessOver(() => session!);
}

export const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);

/** Python's `"%.<digits>f" % value` (keeps the sign of -0.0, like CPython). */
function pythonFixed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits);
  return value < 0 || Object.is(value, -0) ? `-${text}` : text;
}

/** First 16 hex digits of sha256 over `area,cx,cy,cz` per face joined by `|` — the probe / measure_step_brep.py face signature. */
export function faceSignature(faces: readonly { readonly area: number; readonly centroid: readonly number[] }[], digits: number): string {
  const parts = faces.map((face) => [face.area, ...face.centroid].map((value) => pythonFixed(value, digits)).join(','));
  return sha256Hex(parts.join('|')).slice(0, 16);
}

/** Worst value seen per named measure, printed once per file (the numbers recorded in 01 §13.D and validation/README.md). */
export class WorstDeviations {
  private readonly worst = new Map<string, { value: number; label: string }>();

  record(measure: string, value: number, label: string): number {
    const current = this.worst.get(measure);
    if (current === undefined || value > current.value) this.worst.set(measure, { value, label });
    return value;
  }

  report(title: string): void {
    if (this.worst.size === 0) return;
    const lines = [...this.worst].map(([measure, { value, label }]) => `  ${measure}: ${value.toExponential(2)} (${label})`);
    console.warn(`[VC-KRN-25] ${title}, worst deviations vs the OCP 7.9.3.1 reference:\n${lines.join('\n')}`);
  }
}
