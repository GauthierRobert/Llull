/**
 * A stand-in for `llull-compute meshops <folder>` that answers with a chosen result, for tests of what the host does with an answer it cannot trust.
 * Run as `node --require fakeMeshopsJob.cjs meshops <folder>` (NODE_OPTIONS) with FAKE_MESHOPS_RESULT = ok | past_vertices | odd_indices | partial_positions | nan | bad_report | other_report | hole_code | sculpt_index | sculpt_blank_index | sculpt_moved:
 * the preload writes the result files and the final `done` event, then exits before node looks for a script called `meshops`.
 * The report of `repair`, `fill_holes` and `sculpt` is a well-formed one for the op asked (`bad_report`: an empty one; `other_report`: well-formed for another mode or
 * fairing, with a loop number past `totalLoops`, or for a sculpt without symmetry that reports a symmetry error and more stamps applied than there are); `hole_code` ends the job
 * with an error event of a `MESH_HOLE_` code no command documents; `sculpt_index` with `SCULPT_OFF_SURFACE` naming a stamp the op does not have. The result mesh of those ops is the input.
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
  const job = JSON.parse(fs.readFileSync(path.join(folder, 'job.json'), 'utf8'));
  const op = job.op;
  if (mode === 'hole_code') {
    fs.writeSync(1, `${JSON.stringify({ type: 'error', code: 'MESH_HOLE_UNDOCUMENTED', message: 'a code no command knows' })}\n`);
    process.exit(1);
  }
  if (mode === 'sculpt_index' || mode === 'sculpt_blank_index') {
    const message = mode === 'sculpt_index' ? '99' : ' ';
    fs.writeSync(1, `${JSON.stringify({ type: 'error', code: 'SCULPT_OFF_SURFACE', message })}\n`);
    process.exit(1);
  }
  const changes = Object.fromEntries(
    [
      'welded',
      'duplicatesRemoved',
      'degenerateRemoved',
      'flipped',
      'stitched',
      'holesFilled',
      'componentsRemoved',
      'facesRemovedWithComponents',
    ].map((key) => [key, 0]),
  );
  const other = mode === 'other_report';
  const filled = {
    loop: other ? 1 : 0,
    edges: 3,
    triangles: 1,
    addedVertices: 0,
    area: 1,
    triangulation: 'dp',
    fairing: other ? 'none' : job.params.fairing,
  };
  const reports = {
    repair: { mode: other ? 'close_holes' : job.params.mode, changes, notes: [], skippedHoles: 0 },
    fill_holes: { totalLoops: 1, filled: [filled], skipped: [] },
    sculpt: {
      movedVertices: mode === 'sculpt_moved' ? 1e9 : 0,
      maxDisplacement: 0,
      displacedVolume: 0,
      volumeBasis: 'height-field-sum',
      symmetryError: other ? 1 : job.params.symmetry === undefined ? null : 0,
      refinedEdges: 0,
      stampsApplied: (other ? 3 : 1) * (job.params.stamps ?? []).length,
    },
  };
  const report = mode === 'bad_report' ? {} : (reports[op] ?? {});
  const files = {
    'result_positions.f64': resultPositions,
    'result_indices.u32': resultIndices,
    'report.json': Buffer.from(JSON.stringify({ op, items: 0, ms: 0, report })),
  };
  const outputs = Object.entries(files).map(([name, bytes]) => {
    fs.writeFileSync(path.join(folder, name), bytes);
    return { path: name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  fs.writeSync(1, `${JSON.stringify({ type: 'done', ok: true, outputs })}\n`);
  process.exit(0);
}
