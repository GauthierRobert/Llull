/**
 * Render reference gate (RV1 §7 layer V3, docs/QUALITY_GATES.md "Render reference gate"): every scene of server/tests/quality/renderScenes.ts
 * is rendered by render_realistic (llull-compute pathtrace) at the manifest's fixed sample count and compared with its Cycles reference,
 * pinned by sha256 in quality/render-reference.json and kept in .cache/render-reference/<sha256>.exr (never committed).
 *
 *   npm run render:reference        compare (fails on a missing / stale reference or a metric over its threshold)
 *   npm run render:reference:bake   also renders missing or stale references with Blender Cycles (quality/render/cycles_from_job.py)
 *                                   and records sha256, first measurements and thresholds in the manifest
 *
 * Thresholds are set at the first measurement (measured x (1 + margin) + floor) and only ever lowered by hand.
 * Needs llull-compute, python3 with quality/render/requirements.txt, and for baking `blender` (LLULL_BLENDER) 4.x.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { PathTracePort, PathTraceScene } from '@core/model/pathTrace';
import { createImageAssetStore } from '../../src/imageAssets/store';
import { nativeBinaryPath } from '../../src/native/nativeBinary';
import { createPathTracePort, pathTraceJobFiles } from '../../src/native/pathTracePort';
import { requireTool } from '../../../tests/requireTool';
import { RENDER_SCENES } from './renderScenes';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST = path.join(ROOT, 'quality', 'render-reference.json');
const CACHE = path.join(ROOT, '.cache', 'render-reference');
const CONVERTER = path.join(ROOT, 'quality', 'render', 'cycles_from_job.py');
const COMPARE = path.join(ROOT, 'quality', 'render', 'compare.py');
const BAKE = process.env['RENDER_REFERENCE_BAKE'] === '1';
const ONLY = (process.env['RENDER_REFERENCE_SCENES'] ?? '').split(',').filter((id) => id !== '');
const BINARY = nativeBinaryPath('llull-compute');

interface Metrics {
  readonly relError: number;
  readonly flip: number;
  readonly bias: number;
}

interface SceneEntry {
  id: string;
  description: string;
  sceneSha256: string | null;
  reference: { sha256: string; bytes: number; samples: number; blender: string; seconds: number } | null;
  firstMeasured: (Metrics & { date: string; llullSamples: number }) | null;
  thresholds: { relError: number; flip: number; absBias: number } | null;
  /** Known, documented llull-vs-Cycles differences of this scene (not llull bugs). */
  notes?: string;
}

interface Manifest {
  $comment: string;
  llullSamples: number;
  referenceSamples: number;
  seed: number;
  margin: number;
  floors: { relError: number; flip: number; absBias: number };
  scenes: SceneEntry[];
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
let manifestChanged = false;
const results: string[] = [];

/** sha256 of what the scene is: the job folder without the sampling knobs, so a reference survives a change of llull's sample count. */
function sceneHash(scene: PathTraceScene): string {
  const files = pathTraceJobFiles(scene);
  const job: Record<string, unknown> = { ...scene.job };
  for (const key of ['samples', 'seed', 'maxSeconds', 'targetNoise', 'denoise', 'engine', 'exr', 'png', 'exposure']) delete job[key];
  files['job.json'] = JSON.stringify(job);
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(name).update(files[name] ?? '');
  return hash.digest('hex');
}

const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

function writeJobFolder(scene: PathTraceScene, folder: string): void {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const [name, content] of Object.entries(pathTraceJobFiles(scene))) writeFileSync(path.join(folder, name), content);
}

function bakeReference(entry: SceneEntry, folder: string, hash: string): void {
  const blender = process.env['LLULL_BLENDER'] ?? 'blender';
  const out = path.join(CACHE, 'baking', `${entry.id}.exr`);
  mkdirSync(path.dirname(out), { recursive: true });
  const started = performance.now();
  const run = spawnSync(
    blender,
    [
      '-b',
      '--factory-startup',
      '-noaudio',
      '-P',
      CONVERTER,
      '--',
      folder,
      out,
      String(manifest.referenceSamples),
      '--seed',
      String(manifest.seed),
    ],
    { encoding: 'utf8', timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0 || !existsSync(out)) throw new Error(`blender failed for ${entry.id}: ${run.stderr || run.stdout}`.slice(-4000));
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const sha = sha256File(out);
  writeFileSync(path.join(CACHE, `${sha}.exr`), readFileSync(out));
  const info = JSON.parse(readFileSync(`${out}.json`, 'utf8')) as { blender: string };
  entry.reference = { sha256: sha, bytes: readFileSync(out).length, samples: manifest.referenceSamples, blender: info.blender, seconds };
  // A changed scene is a new measurement; a lost cache file of an unchanged scene keeps its first measurement and thresholds (a re-bake
  // writes the same pixels on the same machine, but never the same bytes: Cycles stamps its render time into the EXR header).
  if (entry.sceneSha256 !== hash) {
    entry.firstMeasured = null;
    entry.thresholds = null;
  }
  entry.sceneSha256 = hash;
  manifestChanged = true;
}

function compare(reference: string, test: string, id: string): Metrics {
  const reports = path.join(CACHE, 'reports');
  mkdirSync(reports, { recursive: true });
  const python = process.env['LLULL_PYTHON'] ?? 'python3';
  const run = spawnSync(
    python,
    [
      COMPARE,
      reference,
      test,
      '--flip-png',
      path.join(reports, `${id}.flip.png`),
      '--side-by-side',
      path.join(reports, `${id}.side-by-side.png`),
    ],
    { encoding: 'utf8', timeout: 600_000 },
  );
  if (run.status !== 0) throw new Error(`compare.py failed for ${id}: ${run.stderr}`);
  const metrics = JSON.parse(run.stdout) as Metrics;
  writeFileSync(path.join(reports, `${id}.json`), `${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}

const ceil4 = (value: number): number => Math.ceil(value * 10_000) / 10_000;

function thresholdsFrom(measured: Metrics): NonNullable<SceneEntry['thresholds']> {
  const { margin, floors } = manifest;
  return {
    relError: ceil4(measured.relError * (1 + margin) + floors.relError),
    flip: ceil4(measured.flip * (1 + margin) + floors.flip),
    absBias: ceil4(Math.abs(measured.bias) * (1 + margin) + floors.absBias),
  };
}

const python = spawnSync(process.env['LLULL_PYTHON'] ?? 'python3', ['-c', 'import numpy, OpenEXR, flip_evaluator'], { encoding: 'utf8' });
const ready = BINARY !== null && python.status === 0;
if (python.status !== 0)
  console.warn('render reference gate: pip install -r quality/render/requirements.txt (numpy, OpenEXR, flip-evaluator)');

afterAll(() => {
  if (manifestChanged) writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.warn(['render reference gate (llull vs Cycles)', ...results].join('\n'));
});

describe.skipIf(requireTool('native:llull-compute', ready))('render reference corpus (RV1 V3)', () => {
  const images = createImageAssetStore(path.join(CACHE, 'images'));
  const real = createPathTracePort(BINARY ?? '');
  for (const entry of manifest.scenes) {
    const build = RENDER_SCENES[entry.id];
    it.skipIf(ONLY.length > 0 && !ONLY.includes(entry.id))(entry.id, () => {
      if (build === undefined) throw new Error(`manifest scene ${entry.id} has no builder in renderScenes.ts`);
      let captured: PathTraceScene | null = null;
      const port: PathTracePort = {
        render(scene) {
          captured = scene;
          return real.render(scene);
        },
      };
      const ctx: ExecutionContext = { ...defaultContext(), imageAssets: images, pathTrace: port };
      const scene = build(ctx);
      const params = { ...scene.render, samples: manifest.llullSamples, seed: manifest.seed, denoise: false, exr: true, maxSeconds: 3600 };
      const result = execute(scene.doc, 'render_realistic', params, ctx);
      expect(result.error, result.summary).toBeUndefined();
      const job = captured as PathTraceScene | null;
      if (job === null) throw new Error('render_realistic did not reach the port');
      const folder = path.join(CACHE, 'jobs', entry.id);
      writeJobFolder(job, folder);
      const data = result.data as { files: { name: string; base64: string }[]; elapsedMs: number };
      const exr = data.files.find((file) => file.name === 'render.exr');
      if (exr === undefined) throw new Error('render_realistic returned no EXR');
      const test = path.join(CACHE, 'llull', `${entry.id}.exr`);
      mkdirSync(path.dirname(test), { recursive: true });
      writeFileSync(test, Buffer.from(exr.base64, 'base64'));
      const hash = sceneHash(job);
      const referencePath = (): string => path.join(CACHE, `${entry.reference?.sha256 ?? 'none'}.exr`);
      const stale = entry.sceneSha256 !== hash;
      const missing = entry.reference === null || !existsSync(referencePath()) || sha256File(referencePath()) !== entry.reference.sha256;
      if (stale || missing) {
        if (!BAKE)
          throw new Error(
            `${entry.id}: the Cycles reference is ${stale ? 'stale (the scene changed since it was baked)' : 'missing from .cache/render-reference'}: run npm run render:reference:bake`,
          );
        bakeReference(entry, folder, hash);
      }
      const measured = compare(referencePath(), test, entry.id);
      if (entry.thresholds === null) {
        entry.firstMeasured = { ...measured, date: new Date().toISOString().slice(0, 10), llullSamples: manifest.llullSamples };
        entry.thresholds = thresholdsFrom(measured);
        manifestChanged = true;
      }
      const limits = entry.thresholds;
      results.push(
        `${entry.id.padEnd(16)} relError ${measured.relError.toFixed(4)} (<= ${limits.relError})  FLIP ${measured.flip.toFixed(4)} (<= ${limits.flip})  ` +
          `bias ${(measured.bias * 100).toFixed(2)} % (|.| <= ${(limits.absBias * 100).toFixed(2)} %)  llull ${Math.round(data.elapsedMs)} ms`,
      );
      expect(measured.relError, `${entry.id} relError`).toBeLessThanOrEqual(limits.relError);
      expect(measured.flip, `${entry.id} FLIP`).toBeLessThanOrEqual(limits.flip);
      expect(Math.abs(measured.bias), `${entry.id} |bias|`).toBeLessThanOrEqual(limits.absBias);
    });
  }
});
