/**
 * A stand-in for `llull-compute meshops <folder>` that answers with a chosen result, for tests of what the host does with an answer it cannot trust.
 * Run as `node --require fakeMeshopsJob.cjs meshops <folder>` (NODE_OPTIONS) with FAKE_MESHOPS_RESULT = ok | past_vertices | odd_indices | partial_positions | nan:
 * the preload writes the result files and the final `done` event, then exits before node looks for a script called `meshops`.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

if (path.basename(process.argv[1] ?? '') === 'meshops') {
  const folder = process.argv[2];
  const positions = fs.readFileSync(path.join(folder, 'positions.f64'));
  const indices = fs.readFileSync(path.join(folder, 'indices.u32'));
  const mode = process.env.FAKE_MESHOPS_RESULT ?? 'ok';
  let resultPositions = positions;
  let resultIndices = indices;
  if (mode === 'past_vertices') {
    resultIndices = Buffer.from(indices);
    resultIndices.writeUInt32LE(positions.length / 24 + 5, 0);
  } else if (mode === 'odd_indices') resultIndices = indices.subarray(0, indices.length - 4);
  else if (mode === 'partial_positions') resultPositions = positions.subarray(0, positions.length - 8);
  else if (mode === 'nan') {
    resultPositions = Buffer.from(positions);
    resultPositions.writeDoubleLE(Number.NaN, 0);
  }
  const files = {
    'result_positions.f64': resultPositions,
    'result_indices.u32': resultIndices,
    'report.json': Buffer.from(JSON.stringify({ op: 'decimate', items: 0, ms: 0, report: {} })),
  };
  const outputs = Object.entries(files).map(([name, bytes]) => {
    fs.writeFileSync(path.join(folder, name), bytes);
    return { path: name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  fs.writeSync(1, `${JSON.stringify({ type: 'done', ok: true, outputs })}\n`);
  process.exit(0);
}
