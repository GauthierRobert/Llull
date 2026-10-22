// IMP validation — field -> mesh convergence of the reference mesher (isosurface_lib.mjs, marching tetrahedra, linear interpolation):
// volume, area and vertex distance error vs voxel size h for closed-form SDFs, plus the observed order p (error ~ C h^p).
// Run: node generate_mesh_convergence.mjs -> data/mesh_convergence.json
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isClosedManifold, marchingTetrahedra, meshMeasures } from './isosurface_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const r = (x) => Number(x.toPrecision(8));

const shapes = [
  {
    name: 'sphere_R10',
    f: (p) => Math.hypot(p[0], p[1], p[2]) - 10,
    box: [-11.3, 11.3],
    volume: (4 / 3) * Math.PI * 1000,
    area: 4 * Math.PI * 100,
    vertexError: (p) => Math.abs(Math.hypot(p[0], p[1], p[2]) - 10),
  },
  {
    name: 'torus_5_2',
    f: (p) => Math.hypot(Math.hypot(p[0], p[1]) - 5, p[2]) - 2,
    box: [-7.6, 7.6],
    volume: 2 * Math.PI ** 2 * 5 * 4,
    area: 4 * Math.PI ** 2 * 5 * 2,
    vertexError: (p) => Math.abs(Math.hypot(Math.hypot(p[0], p[1]) - 5, p[2]) - 2),
  },
];
const steps = [1.0, 0.5, 0.25, 0.125];
const result = [];
for (const s of shapes) {
  const rows = [];
  for (const h of steps) {
    const n = Math.round((s.box[1] - s.box[0]) / h);
    const mesh = marchingTetrahedra(s.f, [s.box[0], s.box[0], s.box[0]], [s.box[1], s.box[1], s.box[1]], [n, n, n]);
    const m = meshMeasures(mesh);
    let maxVertexError = 0;
    for (let i = 0; i < mesh.positions.length; i += 3)
      maxVertexError = Math.max(maxVertexError, s.vertexError([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]));
    rows.push({
      h: (s.box[1] - s.box[0]) / n,
      cells: n,
      triangles: m.triangles,
      closedManifold: isClosedManifold(mesh),
      volume: r(m.volume),
      volumeRelError: r((m.volume - s.volume) / s.volume),
      area: r(m.area),
      areaRelError: r((m.area - s.area) / s.area),
      maxVertexDistance: r(maxVertexError),
    });
  }
  const order = (key) => rows.slice(1).map((row, i) => r(Math.log(Math.abs(rows[i][key] / row[key])) / Math.log(rows[i].h / row.h)));
  result.push({
    name: s.name,
    exactVolume: r(s.volume),
    exactArea: r(s.area),
    rows,
    observedOrder: { volume: order('volumeRelError'), area: order('areaRelError'), vertex: order('maxVertexDistance') },
  });
}
writeFileSync(
  path.join(here, 'data', 'mesh_convergence.json'),
  JSON.stringify(
    {
      generated: 'generate_mesh_convergence.mjs',
      mesher: 'marching tetrahedra (6 Kuhn tets per cube), linear edge interpolation, no vertex refinement',
      note: 'second-order convergence expected for volume and area (linear interpolation of a smooth field); the gate uses the exact value with tolerance C·h² taken from these rows (TECHNICAL_SPEC §5.6)',
      shapes: result,
    },
    null,
    1,
  ) + '\n',
);
process.stdout.write('mesh convergence written\n');
