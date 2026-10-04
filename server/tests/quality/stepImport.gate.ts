/**
 * @layer server/tests/quality
 *
 * STEP import quality gate: every pinned STEP file (quality/corpus.json) goes through the real
 * path an agent uses — Python bridge (`import_step` port) → `import_mesh` → measure/check
 * commands → save/load — and is compared with an independent OpenCascade reference
 * (quality/step_reference.py). Fails, never skips, when CadQuery or the corpus is missing.
 *
 *   npm run quality:fetch && npm run quality:step          # QUALITY_TIER=smoke|full|stress
 *
 * @invariant a check id listed in an entry's `knownIssues` must FAIL (ratchet: fix ⇒ remove it)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { DEFAULT_MESH_COLOR } from '@core/commands/import_mesh';
import { serializeDocument } from '@core/commands/persistence';
import { createPythonExchangePort } from '../../src/pythonExchange';
import { BRIDGE_SCRIPT, CADQUERY_PYTHON, probePython } from '../exchangeTestSupport';
import { analyzeSoup, boxDistance, diagonal, unmatchedBoxes, type Box6 } from './meshQuality';

const ROOT = path.resolve(__dirname, '../../..');
const CORPUS_DIR = path.join(ROOT, '.cache', 'quality-corpus');
const TIERS = ['smoke', 'full', 'stress'] as const;
const TIER = (process.env['QUALITY_TIER'] ?? 'full') as (typeof TIERS)[number];
if (!TIERS.includes(TIER)) throw new Error(`QUALITY_TIER must be one of ${TIERS.join(', ')}`);

/** Bridge chordal tolerance (llull_bridge.py op_import_step default), in document units. */
const CHORD = 0.05;
const MAX_VOLUME_ERROR = 0.015;
const MAX_BOX_ERROR = 0.005;
const MAX_EDGE_DEFECT_RATIO = 0.001;
const MAX_DEGENERATE_RATIO = 0.01;

type CheckId =
  | 'imports'
  | 'mesh-integrity'
  | 'volume'
  | 'bounding-box'
  | 'part-placement'
  | 'colors'
  | 'part-names'
  | 'check-model'
  | 'save-load';

interface CorpusEntry {
  id: string;
  format: string;
  tier: (typeof TIERS)[number];
  description: string;
  knownIssues: CheckId[];
}

interface Reference {
  solids: number;
  volume: number;
  solidBoxes: Box6[];
  /** null when the file has no faces (wires / points only). */
  faceBox: Box6 | null;
  colors: number;
  partNames: string[];
}

interface Imported {
  document: CadDocument;
  meshes: Entity[];
  bridgeMs: number;
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'quality', 'corpus.json'), 'utf8')) as {
  files: CorpusEntry[];
};
const entries = manifest.files.filter(
  (entry) => entry.format === 'step' && TIERS.indexOf(entry.tier) <= TIERS.indexOf(TIER),
);
const port = createPythonExchangePort({
  python: CADQUERY_PYTHON,
  build123dPython: CADQUERY_PYTHON,
  timeoutMs: 600_000,
  bridgeScript: BRIDGE_SCRIPT,
  exchangeDir: null,
});
const report: Record<string, Record<string, unknown>> = {};

function reference(file: string): Reference {
  const run = spawnSync(CADQUERY_PYTHON, [path.join(ROOT, 'quality', 'step_reference.py'), file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  if (run.status !== 0) throw new Error(`step_reference.py failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as Reference;
}

function soupOf(entity: Entity): readonly number[] {
  return entity.kind === 'mesh' ? entity.mesh.positions : [];
}

/**
 * A known issue must still fail its assertions; a crash while loading only counts as the known
 * failure when `imports` itself is known (otherwise it is reported, never absorbed).
 */
function check(
  entry: CorpusEntry,
  id: CheckId,
  load: () => Promise<unknown>,
  body: () => void | Promise<void>,
): void {
  if (!entry.knownIssues.includes(id)) {
    it(id, body, 600_000);
    return;
  }
  it(`${id} (known issue)`, async () => {
    if (!entry.knownIssues.includes('imports')) await load();
    let failed = false;
    try {
      await body();
    } catch {
      failed = true;
    }
    expect(failed, `${id} passes now: remove it from knownIssues in quality/corpus.json`).toBe(
      true,
    );
  }, 600_000);
}

// Documents from an earlier run must never reach the display gate.
beforeAll(() => rmSync(path.join(CORPUS_DIR, 'docs'), { recursive: true, force: true }));

describe('quality gate prerequisites', () => {
  it('CadQuery is available to the bridge (pip install -r server/python/requirements.txt)', () => {
    expect(probePython(CADQUERY_PYTHON).cadquery).not.toBeNull();
  });
  it('the corpus is downloaded (npm run quality:fetch)', () => {
    expect(entries.length).toBeGreaterThan(0);
    const missing = entries.filter((e) => !existsSync(path.join(CORPUS_DIR, `${e.id}.step`)));
    expect(missing.map((e) => e.id)).toEqual([]);
  });
});

describe.each(entries)('STEP $id — $description', (entry) => {
  const file = path.join(CORPUS_DIR, `${entry.id}.step`);
  let ref: Reference | null = null;
  let imported: Promise<Imported> | null = null;
  const metrics: Record<string, unknown> = { tier: entry.tier };
  report[entry.id] = metrics;

  async function importOnce(): Promise<Imported> {
    const started = Date.now();
    const { bodies } = await port.importStep(readFileSync(file).toString('base64'));
    const bridgeMs = Date.now() - started;
    const result = execute(createEmptyDocument(), 'import_mesh', { bodies });
    const meshes = result.affected.map((id) => result.document.entities[id] as Entity);
    Object.assign(metrics, { bridgeMs, bodies: meshes.length, summary: result.summary });
    return { document: result.document, meshes, bridgeMs };
  }

  /** Reference + import run once per file; a failed import is cached, not retried per check. */
  async function load(): Promise<{ ref: Reference; imported: Imported }> {
    ref ??= reference(file);
    imported ??= importOnce();
    return { ref, imported: await imported };
  }

  check(entry, 'imports', load, async () => {
    const { ref: r, imported: i } = await load();
    expect(i.meshes.length).toBeGreaterThan(0);
    if (r.solids > 0) expect(i.meshes.length).toBe(r.solids);
  });

  check(entry, 'mesh-integrity', load, async () => {
    const { ref: r, imported: i } = await load();
    const reports = i.meshes.map((mesh) => analyzeSoup(soupOf(mesh)));
    const sum = (key: 'triangles' | 'edges' | 'boundaryEdges' | 'nonManifoldEdges'): number =>
      reports.reduce((total, mesh) => total + mesh[key], 0);
    const degenerate = reports.reduce((total, mesh) => total + mesh.degenerateTriangles, 0);
    const edgeDefects = sum('boundaryEdges') + sum('nonManifoldEdges');
    Object.assign(metrics, { triangles: sum('triangles'), edgeDefects, degenerate });
    expect(reports.every((mesh) => mesh.nonFiniteValues === 0)).toBe(true);
    expect(degenerate / sum('triangles')).toBeLessThanOrEqual(MAX_DEGENERATE_RATIO);
    if (r.solids === 0) return; // surface model: open shells are expected
    expect(edgeDefects / sum('edges')).toBeLessThanOrEqual(MAX_EDGE_DEFECT_RATIO);
    const inverted = i.meshes.filter((_, index) => (reports[index]?.signedVolume ?? 0) <= 0);
    expect(inverted.map((mesh) => mesh.id)).toEqual([]);
  });

  check(entry, 'volume', load, async () => {
    const { ref: r, imported: i } = await load();
    if (r.solids === 0) return;
    const volume = i.meshes.reduce((total, mesh) => {
      const result = execute(i.document, 'measure_volume', { entityId: mesh.id });
      return total + ((result.data as { volume?: number } | undefined)?.volume ?? NaN);
    }, 0);
    const error = Math.abs(volume - Math.abs(r.volume)) / Math.abs(r.volume);
    metrics['volumeError'] = error;
    expect(error).toBeLessThanOrEqual(MAX_VOLUME_ERROR);
  });

  check(entry, 'bounding-box', load, async () => {
    const { ref: r, imported: i } = await load();
    if (r.faceBox === null) throw new Error('reference: the file has no faces');
    const faceBox = r.faceBox;
    const data = execute(i.document, 'measure_bounding_box', {}).data as {
      min: [number, number, number];
      max: [number, number, number];
    };
    const box: Box6 = [...data.min, ...data.max];
    const error = boxDistance(box, faceBox) / diagonal(faceBox);
    metrics['boxError'] = error;
    expect(boxDistance(box, faceBox)).toBeLessThanOrEqual(
      MAX_BOX_ERROR * diagonal(faceBox) + 2 * CHORD,
    );
  });

  check(entry, 'part-placement', load, async () => {
    const { ref: r, imported: i } = await load();
    if (r.solids < 2) return;
    const boxes = i.meshes.map((mesh) => analyzeSoup(soupOf(mesh)).box);
    const misplaced = unmatchedBoxes(boxes, r.solidBoxes, MAX_BOX_ERROR, 2 * CHORD);
    expect(misplaced.map((index) => i.meshes[index]?.name ?? index)).toEqual([]);
  });

  check(entry, 'colors', load, async () => {
    const { ref: r, imported: i } = await load();
    if (r.colors === 0) return;
    const colored = i.meshes.filter((mesh) => mesh.color.toLowerCase() !== DEFAULT_MESH_COLOR);
    expect(colored.length, `the file defines ${r.colors} colour(s)`).toBeGreaterThan(0);
  });

  check(entry, 'part-names', load, async () => {
    const { ref: r, imported: i } = await load();
    if (r.solids < 2 || r.partNames.length === 0) return;
    const names = i.meshes.map((mesh) => mesh.name ?? '');
    expect(
      names.filter((name) => r.partNames.includes(name)),
      `parts: ${r.partNames.join(', ')}`,
    ).not.toEqual([]);
  });

  check(entry, 'check-model', load, async () => {
    const { imported: i } = await load();
    const data = execute(i.document, 'check_model', {}).data as { ok: boolean; issues: unknown[] };
    expect(
      data.issues.filter((issue) => (issue as { severity: string }).severity === 'error'),
    ).toEqual([]);
  });

  check(entry, 'save-load', load, async () => {
    const { imported: i } = await load();
    const json = serializeDocument(i.document);
    const reloaded = execute(createEmptyDocument(), 'load_document', { json }).document;
    expect(i.meshes.length).toBeGreaterThan(0);
    expect(reloaded.order).toEqual(i.document.order);
    for (const mesh of i.meshes) {
      const copy = reloaded.entities[mesh.id];
      expect(copy === undefined ? null : soupOf(copy), mesh.id).toEqual(soupOf(mesh));
    }
    mkdirSync(path.join(CORPUS_DIR, 'docs'), { recursive: true });
    writeFileSync(path.join(CORPUS_DIR, 'docs', `${entry.id}.llull.json`), json);
    metrics['documentBytes'] = json.length;
  });
});

afterAll(() => {
  mkdirSync(path.join(CORPUS_DIR, 'reports'), { recursive: true });
  writeFileSync(
    path.join(CORPUS_DIR, 'reports', 'step-import.json'),
    JSON.stringify({ tier: TIER, files: report }, null, 2),
  );
});
