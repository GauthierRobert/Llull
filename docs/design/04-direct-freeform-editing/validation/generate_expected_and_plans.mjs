// Builds data/topology_ops_cases.json (hand-built result cages of extrude / inset / loop cut / bevel / bridge, checked against their
// closed-form volumes with the reference subdivision), validation/plans/*.json and validation/expected_results.json from the data
// files written by generate_subd_refs.mjs and generate_edit_refs.mjs. Run those two first, then: node generate_expected_and_plans.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { boxCage, cubeCage, meshVolume, subdivide, vec, withAllEdgesSharp } from './ref_catmull_clark.mjs';

const here = new URL('.', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(`data/${name}`, here), 'utf8'));
const save = (path, value) => writeFileSync(new URL(path, here), JSON.stringify(value, null, 1) + '\n');
const r12 = (x) => Number(x.toPrecision(12));

// ---------- 1. Topology results built by hand, all edges infinitely sharp: limit = the polyhedron (planar faces) ----------
function checkManifold(cage) {
  const directed = new Set();
  for (const f of cage.faces)
    f.forEach((a, i) => {
      const k = `${a}>${f[(i + 1) % f.length]}`;
      if (directed.has(k)) throw new Error(`edge ${k} twice`);
      directed.add(k);
    });
  for (const k of directed) {
    const [a, b] = k.split('>');
    if (!directed.has(`${b}>${a}`)) throw new Error(`open edge ${k}`);
  }
  const edges = directed.size / 2;
  return { V: cage.vertices.length, E: edges, F: cage.faces.length, euler: cage.vertices.length - edges + cage.faces.length };
}
const creasedVolume = (cage, L = 2) => Math.abs(meshVolume(subdivide(withAllEdgesSharp(cage, 10), L)));
const cube = cubeCage(1); // faces: bottom [0,3,2,1], top [4,5,6,7], front y- [0,1,5,4], back y+ [2,3,7,6], right x+ [1,2,6,5], left x- [0,4,7,3]
const top = [4, 5, 6, 7];
const ringOps = (offset) => {
  const vertices = [...cube.vertices, ...top.map((v) => vec.add(cube.vertices[v], [0, 0, 0]).map((c, axis) => offset(c, axis)))];
  const inner = [8, 9, 10, 11];
  const faces = cube.faces.filter((f) => f.join() !== top.join()).map((f) => [...f]);
  faces.push(inner);
  top.forEach((a, i) => {
    const b = top[(i + 1) % 4];
    faces.push([a, b, inner[(i + 1) % 4], inner[i]]);
  });
  return { vertices, faces, sharpness: new Map() };
};
const extruded = ringOps((c, axis) => (axis === 2 ? c + 1 : c));
const inset = ringOps((c, axis) => (axis === 2 ? c - 0.5 : c * 0.5));
const loopCut = (() => {
  const vertices = [...cube.vertices, ...[0, 1, 2, 3].map((v) => vec.centroid([cube.vertices[v], cube.vertices[v + 4]]))];
  const mid = (v) => 8 + (v % 4);
  const faces = [];
  for (const f of cube.faces) {
    const isSide = f.some((v) => v < 4) && f.some((v) => v >= 4);
    if (!isSide) {
      faces.push([...f]);
      continue;
    }
    // side face [a, b, c, d] with two bottom (< 4) and two top vertices: split at mid-height
    const lower = f.map((v) => (v < 4 ? v : mid(v)));
    const upper = f.map((v) => (v >= 4 ? v : mid(v)));
    faces.push(lower, upper);
  }
  return { vertices, faces, sharpness: new Map() };
})();
const bevel = (() => {
  const v = cube.vertices.map((p) => [...p]);
  v.push([-1, -1, 0.5], [-1, -0.5, 1], [1, -1, 0.5], [1, -0.5, 1]); // 8 = 4a, 9 = 4b, 10 = 5a, 11 = 5b
  const faces = [
    [0, 3, 2, 1],
    [9, 11, 6, 7],
    [0, 1, 10, 8],
    [2, 3, 7, 6],
    [1, 2, 6, 11, 10],
    [0, 8, 9, 7, 3],
    [8, 10, 11, 9],
  ];
  // vertices 4 and 5 are no longer used: drop them by remapping
  const used = [...new Set(faces.flat())].sort((a, b) => a - b);
  const remap = new Map(used.map((old, i) => [old, i]));
  return { vertices: used.map((i) => v[i]), faces: faces.map((f) => f.map((i) => remap.get(i))), sharpness: new Map() };
})();
const bridge = (() => {
  const base = boxCage([3, 3, 1], [3, 3, 1]);
  const topCentre = base.faces[4];
  const bottomCentre = base.faces[13];
  const below = (v) => {
    const p = base.vertices[v];
    return base.vertices.findIndex((q) => q[0] === p[0] && q[1] === p[1] && q[2] === -p[2]);
  };
  const faces = base.faces.filter((_, i) => i !== 4 && i !== 13).map((f) => [...f]);
  topCentre.forEach((a, i) => {
    const b = topCentre[(i + 1) % 4];
    faces.push([a, b, below(b), below(a)]);
  });
  return { vertices: base.vertices, faces, sharpness: new Map(), check: bottomCentre.every((v) => topCentre.map(below).includes(v)) };
})();
const topo = {
  generated: '2026-10-22',
  generator: 'generate_expected_and_plans.mjs',
  method:
    'result cages built by hand for each operation, every edge infinitely sharp; the reference subdivision (level 2) must equal the closed-form polyhedron volume because all faces are planar and all vertices are corners',
  cases: {
    extrudeTopFace1: {
      counts: checkManifold(extruded),
      closedForm: 12,
      derivation: '8 + 2 x 2 x 1',
      referenceLevel2: r12(creasedVolume(extruded)),
    },
    insetTop_t0p5_dm0p5: {
      counts: checkManifold(inset),
      closedForm: r12(8 - 7 / 6),
      derivation: '8 - frustum h/3 (A1 + A2 + sqrt(A1 A2)) = 8 - 0.5/3 (4 + 1 + 2)',
      referenceLevel2: r12(creasedVolume(inset)),
    },
    loopCutMidHeight: { counts: checkManifold(loopCut), closedForm: 8, referenceLevel2: r12(creasedVolume(loopCut)) },
    bevelEdge45_setback0p5: {
      counts: checkManifold(bevel),
      closedForm: 7.75,
      derivation: '8 - (0.5 x 0.5 / 2) x 2',
      referenceLevel2: r12(creasedVolume(bevel)),
    },
    bridgeBox3x3x1Centre: {
      counts: checkManifold(bridge),
      genus: (2 - checkManifold(bridge).euler) / 2,
      closedForm: 8,
      derivation: '3 x 3 x 1 - 1 x 1 x 1',
      referenceLevel2: r12(creasedVolume(bridge)),
      bottomMatches: bridge.check,
    },
  },
};
save('data/topology_ops_cases.json', topo);

// ---------- 2. Plans ----------
const subd = read('subd_cube_cases.json');
const edits = read('cage_edit_cases.json');
const drag = read('point_drag_cases.json');
const masks = read('subd_limit_masks.json');
const torus = read('subd_regular_torus.json');
const sym = read('symmetry_cases.json');
const fall = read('falloff_curves.json');

save('plans/baseline_subd_cage_today.json', [
  { command: 'add_subdivision_solid', params: { box: { size: [2, 2, 2] }, levels: 3, id: 'cube' } },
  { command: 'mass_properties', params: { entityId: 'cube' } },
  { command: 'edit_subdivision_cage', params: { id: 'cube', crease: true } },
  { command: 'mass_properties', params: { entityId: 'cube' } },
  {
    command: 'add_subdivision_solid',
    params: { box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 3, id: 'pad', position: [5, 0, 0] },
  },
  { command: 'mass_properties', params: { entityId: 'pad' } },
  { command: 'edit_subdivision_cage', params: { id: 'pad', vertexIndices: [edits.topVertexIndex], falloff: 1.5, translate: [0, 0, 0.5] } },
  { command: 'mass_properties', params: { entityId: 'pad' } },
  { command: 'measure_bounding_box', params: { entityId: 'pad' } },
]);

// grip: box [40,20,10] segments [4,2,1]; top faces are boxCage faces 0..7 (index u * ny + v), centre ones u = 1, 2.
const grip = boxCage([40, 20, 10], [4, 2, 1]);
const cornerTop = grip.vertices.findIndex((p) => p[0] === -20 && p[1] === -10 && p[2] === 5);
const cornerBottom = grip.vertices.findIndex((p) => p[0] === -20 && p[1] === -10 && p[2] === -5);
save('plans/target_grip_cage_tools.json', [
  { command: 'add_subdivision_solid', params: { box: { size: [40, 20, 10], segments: [4, 2, 1] }, levels: 3, id: 'grip' } },
  { command: 'set_cage_symmetry', params: { id: 'grip', planes: ['x'] } },
  { command: 'select_cage_elements', params: { id: 'grip', faces: { normal: [0, 0, 1], within: 0.2 } } },
  { command: 'extrude_cage_faces', params: { id: 'grip', faces: ['f-1.2', 'f-1.3', 'f-1.4', 'f-1.5'], distance: 8 } },
  { command: 'inset_cage_faces', params: { id: 'grip', faces: ['f-1.2', 'f-1.3', 'f-1.4', 'f-1.5'], thickness: 2, depth: -1 } },
  { command: 'loop_cut_cage', params: { id: 'grip', edge: [cornerTop, cornerBottom], cuts: 2 } },
  { command: 'set_cage_crease', params: { id: 'grip', edges: { loopFrom: [0, 1] }, sharpness: 2 } },
  {
    command: 'edit_subdivision_cage',
    params: {
      id: 'grip',
      faces: ['f-1.2', 'f-1.3'],
      translate: [0, 0, 3],
      falloff: { radius: 12, shape: 'smooth', metric: 'topological' },
    },
  },
  { command: 'evaluate_subdivision', params: { id: 'grip', vertices: ['v-1.0'] } },
  { command: 'check_subdivision', params: { id: 'grip' } },
  { command: 'mass_properties', params: { entityId: 'grip' } },
]);

save('plans/target_creased_cube_topology.json', [
  { command: 'add_subdivision_solid', params: { box: { size: [2, 2, 2] }, levels: 2, id: 'ext' } },
  { command: 'extrude_cage_faces', params: { id: 'ext', faces: [0], distance: 1 } },
  { command: 'edit_subdivision_cage', params: { id: 'ext', crease: true } },
  { command: 'mass_properties', params: { entityId: 'ext' } },
  { command: 'add_subdivision_solid', params: { box: { size: [2, 2, 2] }, levels: 2, id: 'ins', position: [4, 0, 0] } },
  { command: 'inset_cage_faces', params: { id: 'ins', faces: [0], thickness: 0.5, depth: -0.5 } },
  { command: 'edit_subdivision_cage', params: { id: 'ins', crease: true } },
  { command: 'mass_properties', params: { entityId: 'ins' } },
  { command: 'add_subdivision_solid', params: { box: { size: [2, 2, 2] }, levels: 2, id: 'cut', position: [8, 0, 0] } },
  { command: 'loop_cut_cage', params: { id: 'cut', edge: [0, 4], cuts: 1 } },
  { command: 'edit_subdivision_cage', params: { id: 'cut', crease: true } },
  { command: 'mass_properties', params: { entityId: 'cut' } },
  {
    command: 'add_subdivision_solid',
    params: { box: { size: [3, 3, 1], segments: [3, 3, 1] }, levels: 2, id: 'tun', position: [0, 6, 0] },
  },
  { command: 'bridge_cage_faces', params: { id: 'tun', facesA: [4], facesB: [13] } },
  { command: 'edit_subdivision_cage', params: { id: 'tun', crease: true } },
  { command: 'check_subdivision', params: { id: 'tun' } },
  { command: 'mass_properties', params: { entityId: 'tun' } },
]);

save('plans/target_nurbs_point_drag.json', [
  { command: 'create_nurbs_curve', params: { degree: 3, poles: drag.curve.poles, knots: drag.curve.knots }, as: 'crv' },
  { command: 'edit_nurbs', params: { id: '$crv', operation: 'drag_point', u: drag.curve.u, displacement: drag.curve.displacement } },
  { command: 'inspect_nurbs', params: { id: '$crv' } },
  {
    command: 'create_nurbs_surface',
    params: { degreeU: 3, degreeV: 3, poles: Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => [i, j, 0])) },
    as: 'srf',
  },
  {
    command: 'edit_nurbs_surface',
    params: { id: '$srf', operation: 'drag_point', u: drag.surface.uv[0], v: drag.surface.uv[1], displacement: drag.surface.displacement },
  },
  { command: 'edit_nurbs_surface', params: { id: '$srf', operation: 'insert_knot', direction: 'u', u: 0.25, times: 1 } },
  { command: 'inspect_nurbs', params: { id: '$srf' } },
]);

save('plans/target_brep_face_moves.json', [
  { command: 'add_box', params: { size: [20, 20, 10] }, as: 'plate' },
  { command: 'add_cylinder', params: { radius: 3, height: 20 }, as: 'pin' },
  { command: 'boolean', params: { op: 'subtract', a: '$plate', b: '$pin' }, as: 'holed' },
  { command: 'mass_properties', params: { entityId: '$holed' } },
  { command: 'move_faces', params: { id: '$holed', facesNear: [[3, 0, 0]], mode: 'offset', distance: 1 }, as: 'bored' },
  { command: 'mass_properties', params: { entityId: '$bored' } },
  { command: 'add_box', params: { size: [10, 10, 10], position: [30, 0, 0] }, as: 'blk' },
  { command: 'fillet_edge', params: { id: '$blk', edgesNear: [[35, 0, 5]], radius: 1 }, as: 'rounded' },
  { command: 'mass_properties', params: { entityId: '$rounded' } },
  { command: 'delete_faces', params: { id: '$rounded', facesNear: [[34.7071, 0, 4.7071]] }, as: 'sharp' },
  { command: 'mass_properties', params: { entityId: '$sharp' } },
  { command: 'add_box', params: { size: [10, 10, 10], position: [60, 0, 5] }, as: 'b3' },
  { command: 'move_faces', params: { id: '$b3', facesNear: [[60, 0, 10]], mode: 'translate', vector: [0, 0, 2] }, as: 'taller' },
  { command: 'mass_properties', params: { entityId: '$taller' } },
  { command: 'add_box', params: { size: [10, 10, 10], position: [90, 0, 5] }, as: 'b4' },
  {
    command: 'move_faces',
    params: { id: '$b4', facesNear: [[95, 0, 5]], mode: 'rotate', axis: { origin: [95, 0, 0], direction: [0, 1, 0] }, angleDeg: 10 },
    as: 'leaning',
  },
  { command: 'mass_properties', params: { entityId: '$leaning' } },
]);

save('plans/target_subd_to_nurbs.json', [
  { command: 'add_subdivision_solid', params: { box: { size: [2, 2, 2] }, levels: 3, id: 'c' } },
  { command: 'evaluate_subdivision', params: { id: 'c', vertices: [2], samples: [{ face: 0, u: 0.5, v: 0.5 }] } },
  { command: 'check_subdivision', params: { id: 'c' } },
  { command: 'subdivision_to_nurbs', params: { id: 'c', output: 'sheets', faces: 'unpacked', extraordinary: 'G0', keep: true } },
  { command: 'subdivision_to_nurbs', params: { id: 'c', output: 'solid', faces: 'packed', extraordinary: 'G1', keep: true } },
  { command: 'mass_properties', params: { entityId: 'c' } },
  { command: 'mass_properties', params: { entityId: 'c', surfaceModel: 'limit_patches' } },
]);

// ---------- 3. expected_results.json ----------
const tc = topo.cases;
const D = '--doc t.llull.json --json';
const cases = [
  {
    vc: 'VC-DIR-01',
    what: 'Catmull-Clark limit masks and subdominant eigenvalue, valence 3..12',
    metric: 'lambda formula vs measured ring contraction',
    value: masks.masks.map((m) => ({ n: m.valence, lambda: m.lambdaFormula, measured: m.lambdaMeasured })),
    tolerance: 2e-3,
    tolerance_kind: 'relative',
    unit: '1',
    grade: 'A',
    source: '(a) OpenSubdiv catmarkScheme.h masks [S3]; (b) measured by generate_subd_refs.mjs',
    proves: ['FR-DIR-33', 'TR-DIR-02'],
    cli: { run: `llull evaluate_subdivision '{"id":"$c","vertices":[0]}' ${D}`, assert: 'data.points[0].valence, data.points[0].limit' },
  },
  {
    vc: 'VC-DIR-02',
    what: 'cube cage +-1: limit of corner, top face centre, top-front edge midpoint',
    metric: 'limit position',
    value: { corner: [0.5, 0.5, 0.5], faceCentre: [0, 0, r12(68 / 81)], edgeMid: [0, r12(395 / 648), r12(395 / 648)] },
    tolerance: 1e-12,
    unit: 'document length',
    grade: 'A',
    source:
      '(b) closed form (n^2 v + 4 sum e + sum d)/(n(n+5)), exact rationals 1/2, 68/81, 395/648; deep subdivision agrees (data/subd_cube_cases.json)',
    proves: ['FR-DIR-33', 'TR-DIR-02'],
    cli: { run: `llull run plans/target_subd_to_nurbs.json ${D}`, assert: 'steps[1].data.points[*].limit' },
  },
  {
    vc: 'VC-DIR-03',
    what: 'cube corner limit normal',
    metric: 'unit normal',
    value: subd.cornerLimitNormal.expected,
    tolerance: 1e-12,
    unit: '1',
    grade: 'A',
    source: '(b) symmetry; tangent masks reproduce it (data/subd_cube_cases.json)',
    proves: ['FR-DIR-33', 'TR-DIR-02'],
    cli: { run: `llull evaluate_subdivision '{"id":"c","vertices":[2]}' ${D}`, assert: 'data.points[0].normal' },
  },
  {
    vc: 'VC-DIR-04',
    what: 'TODAY: add_subdivision_solid box [2,2,2] levels 3, mass_properties without kernel (level mesh)',
    metric: 'volume',
    value: subd.smoothMeshVolumeByLevel[3],
    tolerance: 1e-9,
    tolerance_kind: 'relative',
    unit: 'document length^3',
    grade: 'A',
    source:
      '(b) reference implementation of the same published rules (ref_catmull_clark.mjs = llull subdivision.ts rules, same fan triangulation); not yet run on llull',
    runsToday: true,
    proves: ['FR-DIR-35', 'TR-DIR-01'],
    cli: { run: `llull run plans/baseline_subd_cage_today.json ${D}`, assert: 'steps[1].data.volume' },
  },
  {
    vc: 'VC-DIR-05',
    what: 'TODAY: same cube with every edge creased (edit_subdivision_cage crease true, no selection = all)',
    metric: 'volume',
    value: 8,
    tolerance: 1e-12,
    tolerance_kind: 'relative',
    unit: 'document length^3',
    grade: 'A',
    source: '(b) closed form: all vertices corners, faces planar -> cube; reference levels 0..5 all 8',
    runsToday: true,
    proves: ['FR-DIR-10', 'FR-DIR-11', 'TR-DIR-01'],
    cli: { run: `llull run plans/baseline_subd_cage_today.json ${D}`, assert: 'steps[3].data.volume' },
  },
  {
    vc: 'VC-DIR-06',
    what: 'TODAY: box [2,2,2] seg [2,2,2] at [5,0,0]; edit_subdivision_cage vertexIndices [top] falloff 1.5 translate [0,0,0.5]',
    metric: 'cage vertices (world) and level-3 volume before / after',
    value: {
      topVertexIndex: edits.topVertexIndex,
      volumeBefore: edits.meshVolumeLevel3Before,
      volumeAfter: edits.meshVolumeLevel3After,
      verticesAfterLocal: 'data/cage_edit_cases.json verticesAfter (+ [5,0,0] for world)',
    },
    tolerance: { vertices: 1e-6, volume: 1e-9 },
    unit: 'document length',
    grade: 'A',
    source: '(b) smoothstep weights of subdivisionCage.ts recomputed; reference subdivision',
    runsToday: true,
    proves: ['FR-DIR-07', 'FR-DIR-10', 'TR-DIR-06'],
    cli: {
      run: `llull run plans/baseline_subd_cage_today.json ${D}`,
      assert: 'steps[5].data.volume, steps[6].data.vertices, steps[7].data.volume',
    },
  },
  {
    vc: 'VC-DIR-07',
    what: 'semi-sharp creases: every cube edge sharpness s, levels 4 (level-mesh volume)',
    metric: 'volume',
    value: {
      s1: subd.allEdgesSharpness1VolumeByLevel[4],
      s2: subd.allEdgesSharpness2VolumeByLevel[4],
      s0p5: subd.allEdgesSharpness0p5VolumeByLevel[4],
    },
    tolerance: 1e-9,
    tolerance_kind: 'relative',
    unit: 'document length^3',
    grade:
      'A for s1 (identity: s = 1 equals one sharp step = box seg [2,2,2] smooth level 3, 6.31819142235 both ways); B for s2, s0p5 (reference implementation of OpenSubdiv rules, to confirm against OpenSubdiv)',
    source: '(b) generate_subd_refs.mjs',
    proves: ['FR-DIR-11', 'TR-DIR-01', 'TR-DIR-03'],
    cli: {
      run: `llull set_cage_crease '{"id":"cube","edges":"all","sharpness":1}' ${D}; llull mass_properties entityId=cube ${D}`,
      assert: 'data.volume',
    },
  },
  {
    vc: 'VC-DIR-08',
    what: 'fully regular torus cage 8 x 6 -> subdivision_to_nurbs sheets: exact',
    metric: 'max deviation patches vs limit',
    value: 0,
    tolerance: 1e-9,
    unit: 'document length',
    grade: 'A',
    source: `(a) Stam: regular part = bicubic B-spline [S5]; reference B-spline vs mask ${torus.maxCornerDeviation_bsplineVsMask.toExponential(1)} / ${torus.maxCentreDeviation_bsplineVsFacePointMask.toExponential(1)}`,
    proves: ['FR-DIR-29', 'TR-DIR-10'],
    cli: { run: `llull subdivision_to_nurbs '{"id":"t","output":"sheets"}' ${D}`, assert: 'data.maxDeviation' },
  },
  {
    vc: 'VC-DIR-09',
    what: 'cube cage -> subdivision_to_nurbs unpacked G0 / packed G1',
    metric: 'patch count; deviation at EV patches; G1 angle at EV edges',
    value: {
      unpackedPatchCount: 24,
      maxDeviation: 'TBD — measure with subdivision_to_nurbs data.maxDeviation (ACC-type patches near the 8 valence-3 EVs)',
      g1AngleDegAtEvEdges: 'TBD — 0 required for G1 option, measure with check_continuity',
    },
    tolerance: { count: 0 },
    unit: 'count / document length / deg',
    grade: 'A for count (6 faces x 4 refined quads); C for deviation',
    source: '(b) once-refined cube = 24 quads; Rhino ToNURBS options [R5]',
    proves: ['FR-DIR-29', 'FR-DIR-30', 'TR-DIR-10'],
    cli: {
      run: `llull run plans/target_subd_to_nurbs.json ${D} --kernel occt`,
      assert: 'steps[3].data.patchCount, steps[3].data.maxDeviation',
    },
  },
  {
    vc: 'VC-DIR-10',
    what: 'falloff curves of lib/falloff.ts',
    metric: 'f(t) at 21 samples per shape',
    value: 'data/falloff_curves.csv',
    tolerance: 1e-12,
    unit: '1',
    grade: 'A',
    source: `(a) ${fall.source.slice(0, 60)}… [S9]`,
    proves: ['FR-DIR-07', 'TR-DIR-06'],
    cli: { run: 'unit test tests/unit/subd/falloff.test.ts (pure library, no CLI surface)', assert: 'table equality' },
  },
  {
    vc: 'VC-DIR-11',
    what: 'mirror symmetry on box seg [2,1,1]: drag one vertex by (0.3,0.2,0.4)',
    metric: 'mirror vertex delta; level-2 max asymmetry',
    value: { mirrorDelta: sym.mirroredDisplacement, maxAsymmetry: 0 },
    tolerance: 1e-12,
    unit: 'document length',
    grade: 'A',
    source: `(b) reflection; reference asymmetry ${sym.level2MaxAsymmetry.toExponential(1)}`,
    proves: ['FR-DIR-08', 'TR-DIR-07'],
    cli: {
      run: `llull set_cage_symmetry '{"id":"s","planes":["x"]}' ${D}; llull edit_subdivision_cage '{"id":"s","vertices":[${sym.draggedVertex}],"translate":[0.3,0.2,0.4]}' ${D}; llull check_subdivision id=s ${D}`,
      assert: 'data.symmetry.maxDeviation',
    },
  },
  {
    vc: 'VC-DIR-12',
    what: 'edit_nurbs drag_point on the cubic of point_drag_cases.json, u 0.4, D (0,1,0)',
    metric: 'achieved displacement; untouched poles; pole deltas',
    value: { achieved: drag.curve.displacement, untouchedPoles: drag.curve.untouchedPoles, poleDeltas: drag.curve.poleDeltas },
    tolerance: 1e-12,
    unit: 'document length',
    grade: 'A',
    source: '(b) least-norm closed form dP_i = N_i(u) D / sum N_j^2 (TECHNICAL_SPEC 5.6)',
    proves: ['FR-DIR-21', 'FR-DIR-23', 'TR-DIR-08'],
    cli: { run: `llull run plans/target_nurbs_point_drag.json ${D}`, assert: 'steps[2].data.poles' },
  },
  {
    vc: 'VC-DIR-13',
    what: 'edit_nurbs_surface drag_point on a planar bicubic 5x5, (u,v) = (0.3,0.6), D (0,0,1)',
    metric: 'achieved displacement',
    value: drag.surface.displacement,
    tolerance: 1e-12,
    unit: 'document length',
    grade: 'A',
    source: '(b) least-norm closed form (tensor basis)',
    proves: ['FR-DIR-22', 'FR-DIR-23', 'TR-DIR-08'],
    cli: { run: `llull run plans/target_nurbs_point_drag.json ${D}`, assert: 'evaluate S(0.3,0.6) before/after' },
  },
  {
    vc: 'VC-DIR-14',
    what: 'edit_nurbs_surface insert_knot / elevate_degree; move_poles with U/V falloff',
    metric: 'shape change of preserving ops; falloff weights of moved poles',
    value: { shapeChange: 0, weights: 'f(t) of falloff_curves.json in index space' },
    tolerance: 1e-12,
    unit: 'document length',
    grade: 'A',
    source: '(b) knot insertion / degree elevation preserve the surface (B-spline property, same invariant as edit_nurbs today)',
    proves: ['FR-DIR-22', 'TR-DIR-08'],
    cli: { run: `llull run plans/target_nurbs_point_drag.json ${D}`, assert: 'summary shape change' },
  },
  {
    vc: 'VC-DIR-15',
    what: 'one gesture = one command (component suite): 60 pointer moves then release; Esc variant; arrow-key nudge; typed value',
    metric: 'dispatch count and params',
    value: { release: 1, esc: 0, nudgePerKey: 1 },
    tolerance: 0,
    unit: 'count',
    grade: 'A',
    source: '(b) PRIME DIRECTIVE',
    proves: ['FR-DIR-01', 'FR-DIR-02', 'FR-DIR-04', 'FR-DIR-05', 'FR-DIR-41', 'TR-DIR-11'],
    cli: { run: 'npx vitest run tests/component/direct', assert: 'dispatch spy' },
  },
  {
    vc: 'VC-DIR-16',
    what: 'UI gesture vs CLI call vs history replay vs --app',
    metric: 'document deep equality incl. element ids',
    value: 'equal',
    tolerance: 0,
    unit: '-',
    grade: 'A',
    source: '(b) L1, L8',
    proves: ['FR-DIR-05', 'FR-DIR-36', 'FR-DIR-42', 'TR-DIR-15'],
    cli: { run: `llull run plans/target_grip_cage_tools.json ${D}; llull replay_history ${D}`, assert: 'document hash' },
  },
  {
    vc: 'VC-DIR-17',
    what: 'undo / redo of a committed gesture (local and online store modes)',
    metric: 'deep equality',
    value: 'equal',
    tolerance: 0,
    unit: '-',
    grade: 'A',
    source: '(b) store contract',
    proves: ['FR-DIR-03', 'TR-DIR-11'],
    cli: { run: 'npx vitest run tests/integration/directEdit.test.ts; llull undo --doc t.llull.json', assert: 'document equality' },
  },
  {
    vc: 'VC-DIR-18',
    what: 'preview frame time on reference cages (386 vertices preview level 2; 98 vertices level 3)',
    metric: 'p95 frame ms',
    value: { budgetMs: 16, referenceProbeMs: 'data/latency_probe.json (5.1 ms / 6.4 ms reference JS)' },
    tolerance: 'value <= budget',
    unit: 'ms',
    grade: 'C (probe on one machine); budget from RAIL [S10]',
    source: '(c) TBD — measure with tests/bench/directEdit.bench.ts',
    proves: ['FR-DIR-06', 'TR-DIR-15'],
    cli: { run: 'npx vitest bench tests/bench/directEdit.bench.ts', assert: 'p95' },
  },
  {
    vc: 'VC-DIR-19',
    what: 'creased cube: extrude top face by 1',
    metric: 'counts, volume',
    value: { counts: tc.extrudeTopFace1.counts, volume: 12, reference: tc.extrudeTopFace1.referenceLevel2 },
    tolerance: 1e-12,
    unit: 'document length^3',
    grade: 'A',
    source: '(b) closed form, reference agrees',
    proves: ['FR-DIR-12', 'TR-DIR-05'],
    cli: { run: `llull run plans/target_creased_cube_topology.json ${D}`, assert: 'steps[3].data.volume' },
  },
  {
    vc: 'VC-DIR-20',
    what: 'creased cube: inset top face thickness 0.5 depth -0.5',
    metric: 'volume',
    value: {
      volume: tc.insetTop_t0p5_dm0p5.closedForm,
      reference: tc.insetTop_t0p5_dm0p5.referenceLevel2,
      counts: tc.insetTop_t0p5_dm0p5.counts,
    },
    tolerance: 1e-12,
    unit: 'document length^3',
    grade: 'A',
    source: '(b) frustum closed form',
    proves: ['FR-DIR-13', 'TR-DIR-05'],
    cli: { run: `llull run plans/target_creased_cube_topology.json ${D}`, assert: 'steps[7].data.volume' },
  },
  {
    vc: 'VC-DIR-21',
    what: 'creased cube: one loop cut at mid-height',
    metric: 'counts, volume',
    value: { counts: tc.loopCutMidHeight.counts, volume: 8, reference: tc.loopCutMidHeight.referenceLevel2 },
    tolerance: 1e-12,
    unit: 'document length^3',
    grade: 'A',
    source: '(b) planar split',
    proves: ['FR-DIR-14', 'TR-DIR-05'],
    cli: { run: `llull run plans/target_creased_cube_topology.json ${D}`, assert: 'steps[11].data.volume' },
  },
  {
    vc: 'VC-DIR-22',
    what: 'creased box 3x3x1 seg [3,3,1]: bridge centre top and bottom faces',
    metric: 'Euler characteristic, genus, volume',
    value: {
      euler: tc.bridgeBox3x3x1Centre.counts.euler,
      genus: tc.bridgeBox3x3x1Centre.genus,
      volume: 8,
      reference: tc.bridgeBox3x3x1Centre.referenceLevel2,
    },
    tolerance: 1e-12,
    unit: 'document length^3',
    grade: 'A',
    source: '(b) 9 - 1',
    proves: ['FR-DIR-15', 'TR-DIR-05'],
    cli: { run: `llull run plans/target_creased_cube_topology.json ${D}`, assert: 'steps[15].data.euler, steps[16].data.volume' },
  },
  {
    vc: 'VC-DIR-23',
    what: 'move_faces offset +1 on the bore of a 20x20x10 plate with a radius-3 through hole (OCC)',
    metric: 'volume before / after',
    value: { before: r12(4000 - 90 * Math.PI), after: r12(4000 - 160 * Math.PI) },
    tolerance: 1e-6,
    tolerance_kind: 'relative',
    unit: 'document length^3',
    grade: 'A',
    source: '(b) 20*20*10 - pi r^2 * 10',
    proves: ['FR-DIR-25', 'TR-DIR-09'],
    cli: { run: `llull run plans/target_brep_face_moves.json ${D} --kernel occt`, assert: 'steps[3].data.volume, steps[5].data.volume' },
  },
  {
    vc: 'VC-DIR-24',
    what: 'move_faces translate top face of a 10^3 box by +2 z; rotate the +x face 10 deg about its bottom edge (outward)',
    metric: 'volume',
    value: { translate: 1200, rotate: r12(1000 + 500 * Math.tan((10 * Math.PI) / 180)) },
    tolerance: 1e-6,
    tolerance_kind: 'relative',
    unit: 'document length^3',
    grade: 'A',
    source: '(b) 10*10*12; 1000 + 1/2 * 10 * (10 tan 10deg) * 10',
    proves: ['FR-DIR-25', 'TR-DIR-09'],
    cli: { run: `llull run plans/target_brep_face_moves.json ${D} --kernel occt`, assert: 'steps[13].data.volume, steps[16].data.volume' },
  },
  {
    vc: 'VC-DIR-25',
    what: 'delete_faces on a 1 mm fillet of a 10^3 box (OCC defeaturing)',
    metric: 'volume before / after',
    value: { before: r12(1000 - (1 - Math.PI / 4) * 10), after: 1000 },
    tolerance: 1e-6,
    tolerance_kind: 'relative',
    unit: 'document length^3',
    grade: 'A',
    source: '(b) fillet removes (1 - pi/4) r^2 per unit length',
    proves: ['FR-DIR-26', 'TR-DIR-09'],
    cli: { run: `llull run plans/target_brep_face_moves.json ${D} --kernel occt`, assert: 'steps[8].data.volume, steps[10].data.volume' },
  },
  {
    vc: 'VC-DIR-26',
    what: 'drag handle for the existing push_pull_face on a 10^3 box top face, value 2, through /preview then commit',
    metric: 'dispatch count; committed command; volume',
    value: { dispatches: 1, command: 'push_pull_face', volume: 1200, previewMutatesLiveDoc: false },
    tolerance: 1e-6,
    unit: 'document length^3',
    grade: 'A',
    source: '(b)',
    proves: ['FR-DIR-27', 'TR-DIR-11', 'TR-DIR-12'],
    cli: {
      run: `llull push_pull_face '{"id":"$b","faceNear":[0,0,5],"distance":2}' ${D} --kernel occt`,
      assert: 'mass_properties data.volume',
    },
  },
  {
    vc: 'VC-DIR-27',
    what: 'wrong plan: unknown element id, sharpness 12, edge id passed to extrude_cage_faces, loop cut through an n-gon',
    metric: 'error codes',
    value: ['DIR_REF_LOST', 'DIR_SHARPNESS_RANGE', 'DIR_ELEMENT_KIND', 'DIR_LOOP_NOT_QUAD'],
    tolerance: 0,
    unit: '-',
    grade: 'A',
    source: 'TECHNICAL_SPEC 7.1',
    proves: ['FR-DIR-37', 'FR-DIR-39', 'TR-DIR-14'],
    cli: { run: `llull run bad.plan.json --validate ${D}`, assert: 'error.code per step, exit 1' },
  },
  {
    vc: 'VC-DIR-28',
    what: 'check_subdivision on the box [2,2,2] levels 3 cage',
    metric: 'findings',
    value: {
      extraordinaryHistogram: { 3: 8 },
      euler: 2,
      genus: 0,
      meshVolume: subd.smoothMeshVolumeByLevel[3],
      limitVolumeEstimate: subd.smoothLimitVolumeEstimate.value,
      finding: 'DIR_CHECK_LEVEL_MESH_DEVIATION (warn, ~1.69 % > 0.5 % default)',
      provenanceScheme: 'Catmull-Clark, OpenSubdiv uniform creases',
    },
    tolerance: { meshVolume: 1e-9, limitVolumeEstimate: 1e-4 },
    unit: 'document length^3',
    grade: 'A for counts / mesh volume; B for the limit estimate (extrapolated)',
    source: '(b) data/subd_cube_cases.json',
    proves: ['FR-DIR-34', 'FR-DIR-44', 'TR-DIR-13', 'TR-DIR-03'],
    cli: { run: `llull check_subdivision id=c ${D}`, assert: 'data.findings[*].code, data.extraordinaryHistogram' },
  },
  {
    vc: 'VC-DIR-29',
    what: 'same subdivision measured with no kernel and with OCC',
    metric: 'surfaceModel and volumes',
    value: {
      noKernel: { surfaceModel: 'level_mesh', volume: subd.smoothMeshVolumeByLevel[3] },
      occ: {
        surfaceModel: 'limit_patches',
        volume: 'TBD — measure (expected near the limit estimate ' + subd.smoothLimitVolumeEstimate.value + ')',
      },
    },
    tolerance: { noKernel: 1e-9 },
    unit: 'document length^3',
    grade: 'A (no kernel) / C (OCC)',
    source: '(b) / (c)',
    proves: ['FR-DIR-35', 'TR-DIR-10'],
    cli: {
      run: `llull mass_properties entityId=c ${D}; llull mass_properties entityId=c ${D} --kernel occt`,
      assert: 'data.surfaceModel, data.volume',
    },
  },
  {
    vc: 'VC-DIR-30',
    what: 'element ids survive replay: grip plan, then edit_step_params on the extrude distance; later edit still targets f-1.2..f-1.5; deleting a targeted face gives DIR_REF_LOST',
    metric: 'ids and codes',
    value: { sameTargets: true, lostCode: 'DIR_REF_LOST' },
    tolerance: 0,
    unit: '-',
    grade: 'A',
    source: '(b) TECHNICAL_SPEC 3.2',
    proves: ['FR-DIR-20', 'TR-DIR-04'],
    cli: {
      run: `llull run plans/target_grip_cage_tools.json ${D}; llull edit_step_params '{"stepId":"<id of the extrude FeatureStep, doc.featureHistory>","params":{"id":"grip","faces":["f-1.2","f-1.3","f-1.4","f-1.5"],"distance":12}}' ${D}`,
      assert: 'history steps params ids',
    },
  },
  {
    vc: 'VC-DIR-31',
    what: 'render_view overlay=cage shows the cage',
    metric: 'file written; cage pixels present',
    value: 'TBD — pixel check of cage colour in the saved PNG',
    tolerance: 'n/a',
    unit: '-',
    grade: 'C',
    source: '(c)',
    proves: ['FR-DIR-40', 'TR-DIR-13'],
    cli: { run: `llull render_view view=iso isolate=c overlay=cage --doc t.llull.json --save out/c.png`, assert: 'exists' },
  },
  {
    vc: 'VC-DIR-32',
    what: 'parity / units audit of every DIR command and UI tool',
    metric: 'UI tools without command; numeric params without unit',
    value: { uiToolsWithoutCommand: 0, paramsWithoutUnit: 0, guideHasFreeformSection: true },
    tolerance: 0,
    unit: 'count',
    grade: 'A',
    source: 'AF-01..04',
    proves: ['FR-DIR-05', 'FR-DIR-38', 'FR-DIR-43', 'TR-DIR-14'],
    cli: { run: 'llull describe <each command> --json; llull guide', assert: 'audit script' },
  },
  {
    vc: 'VC-DIR-33',
    what: 'slide_cage_edges factor 0.5 on the mid loop of the creased cut cube; weld refusal',
    metric: 'volume; code',
    value: { volume: 8, weldNonManifold: 'DIR_WELD_NONMANIFOLD' },
    tolerance: 1e-12,
    unit: 'document length^3',
    grade: 'A',
    source: '(b) loop stays in the planar side faces',
    proves: ['FR-DIR-09', 'FR-DIR-18', 'TR-DIR-05'],
    cli: {
      run: `llull slide_cage_edges '{"id":"cut","edges":{"loopFrom":"<first new edge id from loop_cut_cage data>"},"factor":0.5}' ${D}`,
      assert: 'mass_properties data.volume',
    },
  },
  {
    vc: 'VC-DIR-34',
    what: 'creased cube: bevel edge (1,-1,1)-(-1,-1,1) with setback 0.5',
    metric: 'counts, volume',
    value: { counts: tc.bevelEdge45_setback0p5.counts, volume: 7.75, reference: tc.bevelEdge45_setback0p5.referenceLevel2 },
    tolerance: 1e-12,
    unit: 'document length^3',
    grade: 'A',
    source: '(b) chamfer prism',
    proves: ['FR-DIR-16', 'TR-DIR-05'],
    cli: { run: `llull bevel_cage_edges '{"id":"bev","edges":[[0,1]],"width":0.25}' ${D}`, assert: 'mass_properties data.volume' },
  },
  {
    vc: 'VC-DIR-35',
    what: 'open cage: delete top face of the creased cube, then fill_cage_hole ngon, crease all',
    metric: 'Euler, volume',
    value: { afterDelete: { boundaryLoops: 1, euler: 1 }, afterFill: { euler: 2, volume: 8 } },
    tolerance: 1e-12,
    unit: 'document length^3',
    grade: 'A',
    source: '(b)',
    proves: ['FR-DIR-17', 'TR-DIR-05'],
    cli: {
      run: `llull delete_cage_faces '{"id":"c","faces":[0],"boundary":"edge_and_corner"}' ${D}; llull fill_cage_hole '{"id":"c","edge":[0,1],"mode":"ngon"}' ${D}`,
      assert: 'check_subdivision data.euler',
    },
  },
  {
    vc: 'VC-DIR-36',
    what: 'fit_cage_vertices flatten the 4 top vertices of a perturbed cage onto plane z = 1',
    metric: 'max |z - 1|',
    value: 0,
    tolerance: 1e-12,
    unit: 'document length',
    grade: 'A',
    source: '(b) projection',
    proves: ['FR-DIR-19', 'TR-DIR-05'],
    cli: {
      run: `llull fit_cage_vertices '{"id":"c","vertices":[0,1,2,3],"to":{"plane":{"origin":[0,0,1],"normal":[0,0,1]}}}' ${D}`,
      assert: 'data.vertices',
    },
  },
  {
    vc: 'VC-DIR-37',
    what: 'control net overlay of a 5 x 5 surface',
    metric: 'drawn poles and hull segments',
    value: { poles: 25, hullSegments: 40 },
    tolerance: 0,
    unit: 'count',
    grade: 'A',
    source: '(b) nU(nV-1) + nV(nU-1)',
    proves: ['FR-DIR-24', 'TR-DIR-11'],
    cli: { run: 'npx vitest run tests/component/direct/netOverlay.test.tsx', assert: 'counts' },
  },
  {
    vc: 'VC-DIR-38',
    what: 'reapply fillets after move_faces (COULD)',
    metric: 'fillet faces present, radius',
    value: 'TBD — define with 06 BLD',
    tolerance: 'TBD',
    unit: 'document length',
    grade: 'C',
    source: '(c) Onshape option [R18]',
    proves: ['FR-DIR-28'],
    cli: { run: 'TBD', assert: 'TBD' },
  },
  {
    vc: 'VC-DIR-39',
    what: 'face_to_subdivision on a planar 10 x 10 square face (COULD)',
    metric: 'limit surface flat',
    value: { maxOutOfPlane: 0 },
    tolerance: 1e-9,
    unit: 'document length',
    grade: 'A',
    source: '(b) affine invariance of subdivision on a planar cage',
    proves: ['FR-DIR-31'],
    cli: { run: `llull face_to_subdivision '{"id":"$b","faceNear":[0,0,5]}' ${D} --kernel occt`, assert: 'evaluate_subdivision z' },
  },
  {
    vc: 'VC-DIR-40',
    what: 'select_cage_elements on box [2,2,2] seg [2,2,2]: faces with normal +z; edge loop through an equatorial edge',
    metric: 'counts',
    value: { topFaces: 4, equatorLoopEdges: 8 },
    tolerance: 0,
    unit: 'count',
    grade: 'A',
    source: '(b) cage topology',
    proves: ['FR-DIR-32', 'FR-DIR-01', 'TR-DIR-13'],
    cli: { run: `llull select_cage_elements '{"id":"pad","faces":{"normal":[0,0,1],"within":0.2}}' ${D}`, assert: 'data.faces.length' },
  },
];
save('expected_results.json', {
  gap: 'DIR',
  generated: '2026-10-22',
  notes:
    'Values are (a) quoted from a source, (b) derived analytically or from the reference implementation (derivation in each case), or (c) TBD with the tool to measure. Sources in validation/sources.md. runsToday = the case runs on llull as of 2026-10-22 (plans/baseline_subd_cage_today.json). Plans flag proposed commands in validation/README.md section 4.',
  cases,
});
process.stdout.write(JSON.stringify(topo.cases, null, 1) + '\n');
