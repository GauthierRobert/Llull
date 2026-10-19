/**
 * SC-D1: a backend killed mid-save never loses the document. A real child process saves a ~0.5 MB document in a loop through
 * `writeDocumentFile` (desktop Save, CLI save) and is killed at seeded random instants, 25 times on the same file. After every kill
 * the file is a complete old-or-new version and `<file>.bak` is a complete previous version.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';

const RUNS = 25;
const SEED = 0x5c_d1;
const MAX_KILL_DELAY_MS = 200;

let workDir = '';
let childScript = '';

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'llull-save-kill-'));
  childScript = path.join(workDir, 'saveLoopChild.cjs');
  const serverDir = path.resolve(__dirname, '..');
  buildSync({
    entryPoints: [path.join(__dirname, 'fixtures', 'saveLoopChild.ts')],
    absWorkingDir: serverDir,
    tsconfig: path.join(serverDir, 'tsconfig.json'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: childScript,
    logLevel: 'error',
  });
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** mulberry32 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The generation a saved file holds (every box sits at x = generation); throws when the file is not a complete document. */
function generationOf(file: string): number {
  const doc: CadDocument = deserializeDocument(readFileSync(file, 'utf8'));
  const xs = new Set(Object.values(doc.entities).map((entity) => (entity as { readonly position: readonly number[] }).position[0]));
  expect(Object.keys(doc.entities)).toHaveLength(4000);
  expect(xs.size).toBe(1);
  return [...xs][0] ?? Number.NaN;
}

/** Run the save loop from `first`, kill it `delayMs` after its first completed save; resolves with the generations it announced. */
function saveThenKill(docPath: string, first: number, delayMs: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, docPath, String(first)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let armed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!armed && stdout.includes('saved ')) {
        armed = true;
        setTimeout(() => child.kill('SIGKILL'), delayMs);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!armed) reject(new Error(`save loop exited before saving (code ${String(code)}, ${String(signal)}): ${stderr}`));
      else resolve([...stdout.matchAll(/saved (\d+)/g)].map((match) => Number(match[1])));
    });
  });
}

describe('kill the backend mid-save', () => {
  it(`${RUNS} seeded kills: the file is always a complete old or new version, .bak a complete previous one`, async () => {
    const random = seededRandom(SEED);
    const docPath = path.join(workDir, 'part.llull.json');
    let next = 1;
    let interruptedWrites = 0;
    for (let run = 0; run < RUNS; run++) {
      const delayMs = Math.floor(random() * MAX_KILL_DELAY_MS);
      const announced = await saveThenKill(docPath, next, delayMs);
      const lastAnnounced = announced.at(-1) ?? next;
      const context = `run ${run} (kill after ${delayMs} ms, last announced save ${lastAnnounced})`;
      expect(existsSync(docPath), context).toBe(true);
      const saved = generationOf(docPath);
      // Killed after the rename but before the announcement -> one newer than announced.
      expect([lastAnnounced, lastAnnounced + 1], context).toContain(saved);
      expect(statSync(docPath).size, context).toBeGreaterThan(500_000);
      const backup = `${docPath}.bak`;
      if (existsSync(backup)) expect([saved - 1, saved], context).toContain(generationOf(backup));
      if (readdirSync(workDir).some((name) => name.endsWith('.tmp'))) interruptedWrites++;
      next = saved + 1;
    }
    expect(existsSync(`${docPath}.bak`)).toBe(true);
    // Orphaned temps of killed savers are removed by the next save; at most the last run's remain.
    expect(readdirSync(workDir).filter((name) => name.endsWith('.tmp')).length).toBeLessThanOrEqual(2);
    console.warn(`[saveKill] ${RUNS} kills, ${interruptedWrites} left a half-written temp (the document survived every one)`);
  }, 120_000);
});
