#!/usr/bin/env node
/**
 * Stand-in for the native `llull-kernel` sidecar (solver/bins/llull-kernel), speaking its NDJSON protocol so the worker wiring is tested
 * without a Rust build. It "builds" boxes only (evaluate -> key, tessellate -> the 12 triangles of the box, as base64 arrays), answers
 * NATIVE_UNSUPPORTED for anything else, prints one non-protocol line first, and exits at end of input.
 */
const { createInterface } = require('node:readline');

const shapes = new Map();
process.stdout.write('OCCT banner that is not JSON\n');

function boxMesh([sx, sy, sz], [px, py, pz]) {
  const corners = [];
  for (const z of [-sz / 2, sz / 2])
    for (const y of [-sy / 2, sy / 2]) for (const x of [-sx / 2, sx / 2]) corners.push(px + x, py + y, pz + z);
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const indices = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return {
    encoding: 'base64-le',
    positions: Buffer.from(new Float64Array(corners).buffer).toString('base64'),
    indices: Buffer.from(new Uint32Array(indices).buffer).toString('base64'),
  };
}

function resolve(handle) {
  if (handle.recipe === undefined) {
    if (!shapes.has(handle.key)) return { error: `shape not cached: ${handle.key}` };
    return { shape: shapes.get(handle.key) };
  }
  const { recipe } = handle;
  if (recipe.op !== 'solid' || recipe.entity.kind !== 'box') return { error: `NATIVE_UNSUPPORTED: recipe op '${recipe.op}'` };
  shapes.set(handle.key, recipe.entity);
  return { shape: recipe.entity };
}

function answer({ op, args }) {
  if (op === 'info')
    return {
      result: { occtVersion: '7.9.2', build: 'llull-kernel@fake', capabilities: ['exportStep'], ops: ['info', 'evaluate', 'tessellate'] },
    };
  if (op !== 'evaluate' && op !== 'tessellate') return { result: null, error: `NATIVE_UNSUPPORTED: op '${op}'` };
  const { shape, error } = resolve(args[0]);
  if (error !== undefined) return { result: null, error };
  return { result: op === 'evaluate' ? { key: args[0].key } : boxMesh(shape.size, shape.position) };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ id: request.id, ...answer(request) })}\n`);
});
