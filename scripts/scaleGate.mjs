#!/usr/bin/env node
/**
 * LIM-1 scale gate (docs/decisions/LIM1-scale.md): builds a synthetic many-parts + many-booleans model through the real `llull` CLI
 * (native kernel when installed), exports it to GLB and reports plan time, per-step hot spots, GLB size and mesh sharing.
 *
 *   node scripts/scaleGate.mjs [--channels 300] [--rings 4] [--sequential] [--plan FILE] [--keep DIR]
 *
 * --channels N   coolant channels cut into a liner (default 300) with ONE boolean listing every tool (`--sequential`: N booleans)
 * --rings R      24-bolt circles (default 4) plus 36 blades and 28 vanes (~R*24 + 64 parts) to exercise glTF mesh sharing
 * --plan FILE    time this plan instead (e.g. the LLR-845 engine plan); the GLB budgets still apply
 * Budgets (exit 1 when broken): every GLB mesh is indexed, meshes <= distinct geometries, <= 40 GLB bytes per triangle.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const channels = Number(option('channels', 300));
const rings = Number(option('rings', 4));
const sequential = args.includes('--sequential');
const kept = option('keep', undefined);
const dir = kept === undefined ? mkdtempSync(join(tmpdir(), 'llull-scale-')) : (mkdirSync(kept, { recursive: true }), kept);
const repo = resolve(import.meta.dirname, '..');

/** Liner (tube) with `count` axial channels: array_polar of one cutter, then one listed-tools subtract (or `count` sequential ones). */
function linerActions(count) {
  const tools = ['$ch0', ...Array.from({ length: count - 1 }, (_, k) => `$ch[${k}]`)];
  const cuts = sequential
    ? tools.map((tool) => ({ command: 'boolean', params: { op: 'subtract', a: '$liner', b: tool }, as: 'liner' }))
    : [{ command: 'boolean', params: { op: 'subtract', a: '$liner', b: tools }, as: 'liner' }];
  return [
    { command: 'add_cylinder', params: { radius: 160, height: 300, anchor: 'base-center', position: [0, 0, 0] }, as: 'liner' },
    { command: 'add_cylinder', params: { radius: 130, height: 320, anchor: 'base-center', position: [0, 0, -10] }, as: 'bore' },
    { command: 'boolean', params: { op: 'subtract', a: '$liner', b: '$bore' }, as: 'liner' },
    { command: 'add_cylinder', params: { radius: 1, height: 280, anchor: 'base-center', position: [145, 0, 10] }, as: 'ch0' },
    { command: 'array_polar', params: { id: '$ch0', count, center: [0, 0, 0] }, as: 'ch' },
    ...cuts,
  ];
}

/** Pattern-heavy parts: bolt circles, a lofted blade row and a vane row (each a polar array of one source). */
function partActions() {
  const actions = [];
  for (let ring = 0; ring < rings; ring++) {
    const r = 220 + ring * 40;
    actions.push({ command: 'add_cylinder', params: { radius: 6, height: 40, position: [r, 0, 320 + ring * 10] }, as: `bolt${ring}` });
    actions.push({ command: 'array_polar', params: { id: `$bolt${ring}`, count: 24, center: [0, 0, 0] } });
  }
  const section = (chord) => [
    [-chord / 2, 0],
    [0, chord / 8],
    [chord / 2, 0],
    [0, -chord / 16],
  ];
  const row = (as, z, count, chord) => [
    {
      command: 'loft_sections',
      params: {
        sections: [
          { center: [100, 0, z], rotation: [0, 1.5708, 0], section: section(chord) },
          { center: [140, 0, z], rotation: [0, 1.5708, 0], section: section(chord * 0.8) },
        ],
      },
      as,
    },
    { command: 'array_polar', params: { id: `$${as}`, count, center: [0, 0, 0] } },
  ];
  return [...actions, ...row('blade', -60, 36, 20), ...row('vane', -100, 28, 16)];
}

function llull(cliArgs) {
  const started = performance.now();
  const run = spawnSync(process.execPath, ['server/bin/llull.cjs', ...cliArgs], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 30 });
  return { ...run, wallMs: Math.round(performance.now() - started) };
}

/** Mesh / index / triangle facts of a GLB file. */
function glbFacts(path) {
  const bytes = readFileSync(path);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  const primitives = (json.meshes ?? []).flatMap((mesh) => mesh.primitives);
  const meshNodes = (json.nodes ?? []).filter((node) => node.mesh !== undefined).length;
  return { bytes: bytes.length, meshes: primitives.length, meshNodes, indexed: primitives.every((p) => p.indices !== undefined) };
}

const planPath = option('plan', undefined) ?? join(dir, 'scale-plan.json');
if (option('plan', undefined) === undefined)
  writeFileSync(planPath, JSON.stringify([{ command: 'set_units', params: { units: 'mm' } }, ...linerActions(channels), ...partActions()]));
const docPath = join(dir, 'scale.llull.json');
const run = llull(['run', planPath, '--doc', docPath, '--json', '--no-fit']);
const report = JSON.parse(run.stdout || '{}');
if (report.ok !== true) {
  console.error(`plan failed: ${report.summary ?? run.stderr}`);
  process.exit(1);
}
const steps = report.data?.steps ?? [];
const slowest = [...steps].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 3);
const glbPath = join(dir, 'scale.glb');
const exported = llull(['export_gltf', 'binary=true', '--doc', docPath, '--save', glbPath, '--json']);
const triangleCount = JSON.parse(exported.stdout || '{}').data?.triangleCount ?? 0;
const glb = glbFacts(glbPath);
const docBytes = statSync(docPath).size;
const result = {
  plan:
    option('plan', undefined) ??
    `liner ${channels} channels (${sequential ? 'sequential' : 'one listed-tools'} boolean) + ${rings * 24 + 64} pattern parts`,
  planWallMs: run.wallMs,
  stepMs: steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0),
  slowest: slowest.map((step) => `${step.command} #${step.index} ${step.durationMs} ms`),
  documentBytes: docBytes,
  exportWallMs: exported.wallMs,
  triangleCount,
  glbBytes: glb.bytes,
  glbBytesPerTriangle: Number((glb.bytes / Math.max(1, triangleCount)).toFixed(1)),
  meshNodes: glb.meshNodes,
  meshes: glb.meshes,
  dir,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
const broken = [
  !glb.indexed && 'a GLB mesh is not indexed',
  result.glbBytesPerTriangle > 40 && `GLB ${result.glbBytesPerTriangle} bytes per triangle > 40`,
  option('plan', undefined) === undefined &&
    glb.meshes > glb.meshNodes - (rings * 23 + 35 + 27) &&
    'pattern copies do not share their mesh',
].filter(Boolean);
if (broken.length > 0) {
  console.error(`scale gate FAILED: ${broken.join('; ')}`);
  process.exit(1);
}
