// Builds validation/expected_results.json (the VC index) from data/*.json so no value is transcribed by hand.
// Run after generate_analytic_refs.mjs and generate_mesh_algorithms.mjs: node generate_expected_results.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const d = (name) => JSON.parse(fs.readFileSync(path.join(here, 'data', name), 'utf8'));
const r12 = (x) => Number(x.toPrecision(12));
const ico = d('icosphere_convergence.json');
const topo = d('topology_cases.json');
const stl = d('stl_fixtures.json');
const defect = d('defect_mesh.json').truth;
const hole = d('hole_fill_reference.json');
const qem = d('qem_planar_reference.json');
const smooth = d('smoothing_reference.json');
const rs = d('remesh_smooth_refs.json');
const hull = d('convex_hull_cases.json');
const mink = d('minkowski_cases.json');
const off = d('offset_shell_cases.json');
const cut = d('plane_cut_cases.json');
const bool = d('boolean_cases.json');
const sculpt = d('sculpt_cases.json');
const D = '--doc t.llull.json --json';

// Two spheres R 10, centres 10 apart: V_union = 2 * 4/3 pi R^3 - pi (4R + d)(2R - d)^2 / 12 (lens volume).
const R = 10;
const dist = 10;
const lens = (Math.PI * (4 * R + dist) * (2 * R - dist) ** 2) / 12;
const union = 2 * (4 / 3) * Math.PI * R ** 3 - lens;
const unionArea = 2 * 4 * Math.PI * R * R - 2 * 2 * Math.PI * R * (R - dist / 2);
// Plate 40 x 30 x 5 with a through hole r 5: exact B-rep volume.
const plate = 40 * 30 * 5 - Math.PI * 25 * 5;

const cases = [
  {
    vc: 'VC-MSH-01',
    what: 'analyze_mesh area / volume of icospheres R 10 levels 0..6 (import_mesh of generated soups)',
    expected: ico.levels.map((l) => ({ level: l.level, faces: l.faces, area: l.area, volume: l.volume })),
    closedForm: ico.closedForm,
    tolerance: { value: 1e-9, relative: true },
    unit: 'mm, mm^2, mm^3',
    source: '(b) data/icosphere_convergence.json; closed form 4 pi R^2, 4/3 pi R^3; error ratio -> 4 per level',
    grade: 'A',
    proves: ['FR-MSH-01', 'FR-MSH-03', 'TR-MSH-01'],
    cli: { run: `llull run plans/baseline_mesh_today.json ${D}; llull analyze_mesh id=$ico ${D}`, assert: 'data.area, data.volume' },
  },
  {
    vc: 'VC-MSH-02',
    what: 'topology fingerprints',
    expected: topo.cases,
    tolerance: 'exact',
    source: '(b) data/topology_cases.json; chi = 2 - 2g',
    grade: 'A',
    proves: ['FR-MSH-03', 'TR-MSH-01'],
    cli: { run: `llull analyze_mesh id=<mesh> ${D}`, assert: 'data.eulerCharacteristic, data.genus, data.boundaryLoops, data.closed' },
  },
  {
    vc: 'VC-MSH-03',
    what: 'STL import (ascii + binary) with explicit units; inch file into a mm document',
    expected: { files: stl.files, inchScale: 25.4, inchVolumeFactor: r12(25.4 ** 3) },
    tolerance: stl.tolerance,
    source: '(b) data/stl_fixtures.json (sha256 pinned); 1 in = 25.4 mm exactly',
    grade: 'A',
    proves: ['FR-MSH-01', 'FR-MSH-29', 'TR-MSH-06'],
    cli: {
      run: `llull import_mesh_file file=validation/data/icosphere_r10_l1_binary.stl units=mm ${D}`,
      assert: 'data.triangles, data.weldedVertices, data.volume',
    },
  },
  {
    vc: 'VC-MSH-04',
    what: 'diagnose and repair the defect mesh',
    expected: defect,
    tolerance: 'counts exact; volume / area 1e-9 relative',
    source: '(b) data/defect_mesh.json ground truth (constructed)',
    grade: 'A',
    proves: ['FR-MSH-03', 'FR-MSH-05', 'FR-MSH-06', 'TR-MSH-08'],
    cli: { run: `llull run plans/target_defect_repair.json ${D}`, assert: 'steps[2].data, steps[6].data' },
  },
  {
    vc: 'VC-MSH-05',
    what: 'hole filling: planar loop (area exact), sphere cap (fairing)',
    expected: {
      planar: {
        area: hole.planar.expectedArea,
        patchTriangles: hole.planar.expectedPatchTriangles,
        boundaryEdgesAfter: hole.planar.expectedBoundaryEdgesAfter,
      },
      sphere: {
        closedAfter: true,
        flatFillVolume: hole.sphere.volumeAfterFlatFill,
        originalVolume: hole.sphere.volumeOriginal,
        fairedVolume:
          'TBD - measure with fill_mesh_holes fairing=curvature; must lie between flatFillVolume and originalVolume + |originalVolume - flatFillVolume|',
      },
    },
    tolerance: { planarArea: 1e-9 },
    source: '(b) data/hole_fill_reference.json (reference DP run)',
    grade: 'A (planar) / TBD (sphere)',
    proves: ['FR-MSH-06', 'TR-MSH-08'],
    cli: { run: `llull fill_mesh_holes id=$m holes=all fairing=none ${D}`, assert: 'data.filled[*].triangles, data.areaAfter' },
  },
  {
    vc: 'VC-MSH-06',
    what: 'QEM decimation of planar grids keeps area and planarity',
    expected: qem.cases.map((c) => ({ id: c.id, area: c.expectedArea, maxDistanceFromPlane: 0, maxQuadricCost: 0, boundaryEdges: 48 })),
    tolerance: { area: 1e-9, relative: true, plane: 1e-12 },
    source: '(b) data/qem_planar_reference.json; Garland-Heckbert: Q(v) = 0 for v on all its planes',
    grade: 'A',
    proves: ['FR-MSH-08', 'TR-MSH-08'],
    cli: { run: `llull decimate_mesh id=$grid targetTriangles=40 preserveBoundary=true ${D}`, assert: 'data.areaAfter, data.maxDeviation' },
  },
  {
    vc: 'VC-MSH-07',
    what: 'QEM on icosphere R 10 l5 with maxDeviation 0.05: symmetric Hausdorff to the input <= 0.05 mm, triangle count reported',
    expected: { hausdorffMax: '<= 0.05', triangles: 'TBD - measure', volumeRelChange: 'TBD - measure' },
    tolerance: 'bound',
    source: '(b) bound by construction of the maxDeviation stop rule (TECHNICAL_SPEC 5.3)',
    grade: 'A (bound)',
    proves: ['FR-MSH-08', 'FR-MSH-25'],
    cli: { run: `llull decimate_mesh id=$s maxDeviation=0.05 ${D}`, assert: 'data.deviation.max' },
  },
  {
    vc: 'VC-MSH-08',
    what: 'Laplacian vs Taubin (lambda 0.6307, kPB 0.1) on a clean icosphere l4, uniform umbrella',
    expected: { mu: rs.taubin.mu, runs: smooth.clean.runs },
    tolerance: { value: 1e-9, relative: true },
    source: '(b) data/smoothing_reference.json; kPB = 1/lambda + 1/mu (Taubin 1995 eq. 9)',
    grade: 'A',
    proves: ['FR-MSH-10', 'TR-MSH-08'],
    cli: {
      run: `llull smooth_mesh id=$s method=taubin lambda=0.6307 passBand=0.1 iterations=10 weights=uniform volumeCorrection=false ${D}`,
      assert: 'data.meanRadius (via analyze_mesh), data.volumeAfter',
    },
  },
  {
    vc: 'VC-MSH-09',
    what: 'Taubin on a noisy sphere: noise reduced, mean radius kept (Laplacian shrinks)',
    expected: smooth.noisy,
    tolerance: { value: 1e-9, relative: true },
    source: '(b) data/smoothing_reference.json',
    grade: 'A',
    proves: ['FR-MSH-10'],
    cli: { run: `llull smooth_mesh id=$noisy method=taubin iterations=10 ${D}`, assert: 'data.volumeAfter' },
  },
  {
    vc: 'VC-MSH-10',
    what: 'isotropic remesh of icosphere R 10 to L = 1 with projection',
    expected: {
      maxEdge: rs.remesh.edgeBand[1],
      minEdge: rs.remesh.edgeBand[0],
      chordDeviationMax: rs.remesh.chordDeviationBound,
      fractionInBand: 'TBD - measure (report only)',
    },
    tolerance: 'bounds',
    source: '(b) data/remesh_smooth_refs.json; Botsch-Kobbelt thresholds; Jung bound',
    grade: 'A (bounds)',
    proves: ['FR-MSH-09', 'TR-MSH-08'],
    cli: { run: `llull remesh_mesh id=$s targetEdgeLength=1 iterations=5 ${D}`, assert: 'data.edgeLength.max, data.deviation.max' },
  },
  {
    vc: 'VC-MSH-11',
    what: 'convex hull of known point sets',
    expected: hull.cases.map((c) => ({
      id: c.id,
      ...c.expected,
      ...(c.discretisation ? { relBound: c.discretisation.relBound_64x32 } : {}),
    })),
    tolerance: { value: 1e-9, relative: true, torus: 'below continuous value by <= relBound' },
    source: '(b) data/convex_hull_cases.json',
    grade: 'A',
    proves: ['FR-MSH-12', 'TR-MSH-04'],
    cli: { run: `llull convex_hull points=[...] ${D}; llull mass_properties entityId=$hull ${D}`, assert: 'data.volume' },
  },
  {
    vc: 'VC-MSH-12',
    what: 'Minkowski cube 10 (+) icosphere r 2 (levels 1..3): exact polyhedral volume; continuous limit',
    expected: {
      polyhedral: mink.cube_plus_ball.polyhedral.map((p) => ({ element: p.structuringElement, volume: p.expectedVolumeExactPolyhedral })),
      continuous: mink.cube_plus_ball.continuousVolume,
    },
    tolerance: { value: 1e-9, relative: true },
    source: '(b) data/minkowski_cases.json; zonotope formula (README 4.3); Steiner formula',
    grade: 'A',
    proves: ['FR-MSH-13', 'FR-MSH-04', 'TR-MSH-04'],
    cli: { run: `llull run plans/target_hull_minkowski_offset.json ${D}`, assert: 'mass_properties data.volume' },
  },
  {
    vc: 'VC-MSH-13',
    what: 'Minkowski cube 10 (+) cube 3',
    expected: { volume: mink.cube_plus_cube.expectedVolume },
    tolerance: { value: 1e-12, relative: true },
    source: '(b) closed form',
    grade: 'A',
    proves: ['FR-MSH-13'],
    cli: { run: `llull minkowski_sum a=$cube b=$small op=sum ${D}`, assert: 'data.volume' },
  },
  {
    vc: 'VC-MSH-14',
    what: 'Minkowski difference (erosion): cube 10 (-) cube 3, cube 10 (-) icosphere r 2',
    expected: { cubeMinusCube: mink.cube_minus_cube.expectedVolume, cubeMinusBall: mink.cube_minus_ball.expectedVolume },
    tolerance: { value: 1e-9, relative: true },
    source:
      '(b) closed form; the icosphere has vertices on the axes (width 4 = 2r, data/minkowski_cases.json) so its support along +-e_i is exactly r',
    grade: 'A',
    proves: ['FR-MSH-13'],
    cli: { run: `llull minkowski_sum a=$cube b=$small op=difference ${D}`, assert: 'data.volume' },
  },
  {
    vc: 'VC-MSH-15',
    what: 'offset_mesh level set (vertex tolerance 0.01 mm)',
    expected: off.cases.filter((c) => c.id !== 'sphere_shell'),
    tolerance: off.tolerance,
    source: '(b) data/offset_shell_cases.json',
    grade: 'A',
    proves: ['FR-MSH-14', 'TR-MSH-04'],
    cli: { run: `llull offset_mesh id=$s distance=1 method=level_set tolerance=0.01 ${D}`, assert: 'data.volume' },
  },
  {
    vc: 'VC-MSH-16',
    what: 'hollow_mesh sphere R 10 wall 1 (sealed cavity)',
    expected: off.cases.find((c) => c.id === 'sphere_shell'),
    tolerance: { rule: off.tolerance.rule, eps: 0.01, absBound: r12(4 * Math.PI * (100 + 81) * 0.01) },
    source: '(b) closed form; |dV| <= (A_outer + A_inner) * eps',
    grade: 'A',
    proves: ['FR-MSH-15'],
    cli: { run: `llull hollow_mesh id=$s wallThickness=1 resolution=0.2 ${D}`, assert: 'data.volume' },
  },
  {
    vc: 'VC-MSH-17',
    what: 'cut_mesh of the unit cube by planes, capped',
    expected: cut.cases,
    tolerance: { value: 1e-12, relative: true },
    source: '(b) data/plane_cut_cases.json',
    grade: 'A',
    proves: ['FR-MSH-16'],
    cli: {
      run: `llull cut_mesh id=$cube plane={origin:[0.5,0.5,0.5],normal:[1,1,1]} keep=negative cap=true ${D}`,
      assert: 'data.volume, data.capArea',
    },
  },
  {
    vc: 'VC-MSH-18',
    what: 'mesh booleans of two cubes on the mesh engine, with the native OCC kernel installed (routing) and with Manifold',
    expected: bool.cases,
    tolerance: { value: 1e-12, relative: true },
    source: '(b) data/boolean_cases.json',
    grade: 'A',
    proves: ['FR-MSH-17', 'TR-MSH-09'],
    cli: { run: `llull boolean op=union a=$A b=$B engine=mesh ${D}`, assert: 'mass_properties data.volume, data.area; result has no brep' },
  },
  {
    vc: 'VC-MSH-19',
    what: 'sculpt draw brush displaced volume on the flat grid (4 falloffs)',
    expected: sculpt.cases,
    tolerance: { discrete: 1e-9, relative: true },
    source: '(b) data/sculpt_cases.json (exact on the grid; continuous for reference)',
    grade: 'A',
    proves: ['FR-MSH-18', 'TR-MSH-08'],
    cli: { run: `llull run plans/target_sculpt_quad_brep.json ${D}`, assert: 'steps[2].data.displacedVolume' },
  },
  {
    vc: 'VC-MSH-20',
    what: 'sculpt invariants: flatten (strength 1, constant falloff) after draw restores z = 0 inside the brush; grab by v = [0,0,s] equals draw along +Z',
    expected: { flattenMaxAbsZ: 0, grabEqualsDraw: true },
    tolerance: 1e-12,
    source: '(b) brush definitions TECHNICAL_SPEC 5.7',
    grade: 'A',
    proves: ['FR-MSH-18'],
    cli: { run: `llull sculpt_mesh id=$patch brush=flatten ... ${D}`, assert: 'data.maxDisplacement' },
  },
  {
    vc: 'VC-MSH-21',
    what: 'sculpt symmetry and replay: mirrored stroke symmetric to 1e-12; regenerate (L8 replay) gives identical vertex arrays',
    expected: { symmetryError: 0, replayIdentical: true },
    tolerance: 1e-12,
    source: '(b) data/sculpt_cases.json symmetry rule; AF-13',
    grade: 'A',
    proves: ['FR-MSH-18', 'FR-MSH-19', 'FR-MSH-28'],
    cli: { run: `llull regenerate ${D}`, assert: 'mesh sha256 equal' },
  },
  {
    vc: 'VC-MSH-22',
    what: 'quad_remesh + fit_subdivision_to_mesh + exact B-spline solid of an icosphere R 10 (all built and measured)',
    expected: {
      allQuads: true,
      quadCount: '545..614 for targetQuadCount 600 (within 15 %; measured 614 on icosphere l4, 609 on l5, 545 through the float32 STL)',
      valence:
        'eight valence-3 vertices (cube topology), every other vertex valence 4 (l4: {3: 8, 4: 608}); the sum of (4 - valence) is 8 by Euler; one valence-5 vertex appears on l5',
      cageHausdorffToSource: '<= 0.1 (measured 0.0663 l4, 0.0624 l5, 0.0824 through the STL; mean 0.029 / 0.031)',
      bsplineFaces: 'quads x 4^(levels - 1) = 2456 for 614 quads at levels 2, all bspline, one closed solid, on the native kernel',
      unfittedLimitVsSphere:
        'volume 4097.719 (-2.17 % of 4188.790), area 1238.371 (-1.45 % of 1256.637): the Catmull-Clark limit of the cage lies inside it',
      maxDeviationAfterFit:
        '<= 0.05 (fit_subdivision_to_mesh, both directions, level-4 limit mesh): measured 0.0078 on the l4 icosphere (input 0.095, 1 round), 0.0201 through the plan (remeshed STL, input 0.100)',
      fittedLimitVsSphere:
        'exact limit-patch volume -0.10 % (4184.6 of 4188.790), area -0.067 % of 1256.637 (before the fit -2.17 % / -1.45 %)',
    },
    tolerance: 'bounds',
    source:
      '(c) measured with the implementation (server/tests/quadRemeshNative.test.ts); QuadriFlow face count grows linearly with the requested resolution [S8]',
    grade: 'C',
    proves: ['FR-MSH-22', 'FR-MSH-23', 'TR-MSH-10'],
    cli: {
      run: `llull run plans/target_quad_remesh.json --kernel occt ${D}; llull run plans/target_sculpt_quad_brep.json --kernel occt ${D}`,
      assert: 'steps[2].data.quads, steps[3].data.volume; sculpt plan steps[7].data.maxDeviation <= 0.05',
    },
  },
  {
    vc: 'VC-MSH-23',
    what: 'segment_mesh + mesh_to_brep prismatic of a tessellated plate 40 x 30 x 5 with a through hole r 5 (llull export_stl, 64 segments)',
    expected: { groups: { plane: 6, cylinder: 1 }, cylinderRadius: 5, brepVolume: r12(plate) },
    tolerance: { radius: 1e-9, volume: 1e-9, relative: true },
    source: '(b) closed form; the STL vertices lie exactly on the cylinder r 5',
    grade: 'A',
    proves: ['FR-MSH-20', 'FR-MSH-21', 'TR-MSH-10'],
    cli: {
      run: `llull segment_mesh id=$plate featureAngleDeg=30 ${D}; llull mesh_to_brep id=$plate mode=prismatic --kernel occt ${D}`,
      assert: 'data.groups, mass_properties data.volume (method exact)',
    },
  },
  {
    vc: 'VC-MSH-24',
    what: 'mesh_to_brep faceted: one planar face per triangle, volume = mesh volume',
    expected: { faces: 320, volume: ico.levels[2].volume },
    tolerance: { value: 1e-9, relative: true },
    source: '(b) data/icosphere_convergence.json level 2',
    grade: 'A',
    proves: ['FR-MSH-21'],
    cli: { run: `llull mesh_to_brep id=$ico mode=faceted --kernel occt ${D}`, assert: 'inspect_topology faces, mass_properties volume' },
  },
  {
    vc: 'VC-MSH-25',
    what: 'symmetric deviation of two parallel planar grids 0.5 apart (different triangulations)',
    expected: { forwardMax: 0.5, backwardMax: 0.5, hausdorff: 0.5, mean: 0.5, rms: 0.5 },
    tolerance: 1e-12,
    source: '(b) closed form',
    grade: 'A',
    proves: ['FR-MSH-25'],
    cli: { run: `llull measure_deviation id=$a referenceId=$b symmetric=true ${D}`, assert: 'data.hausdorff' },
  },
  {
    vc: 'VC-MSH-26',
    what: 'stable error codes of a wrong plan',
    expected: 'plans/target_bad_plan_codes.json expect',
    tolerance: 'exact',
    source: '(b) TECHNICAL_SPEC 7.1',
    grade: 'A',
    proves: ['FR-MSH-30', 'FR-MSH-35', 'TR-MSH-11'],
    cli: { run: `llull run plans/target_bad_plan_codes.json --validate ${D}`, assert: 'steps[*].error.code' },
  },
  {
    vc: 'VC-MSH-27',
    what: 'unverified propagation, provenance and named defaults',
    expected: {
      importNoSha: { unverified: true },
      derivedDecimate: { unverified: true },
      weldTolerance: { defaulted: true, source: 'llull default 1e-6 x bbox diagonal' },
      provenance: ['algorithm', 'engine', 'params', 'inputSha256'],
    },
    tolerance: 'exact',
    source: '(b) FR-MSH-31..33',
    grade: 'A',
    proves: ['FR-MSH-31', 'FR-MSH-32', 'FR-MSH-33', 'TR-MSH-13'],
    cli: {
      run: `llull import_mesh_file file=x.stl units=mm ${D}; llull decimate_mesh id=$m ratio=0.5 ${D}; llull check_mesh ids=[$m] ${D}`,
      assert: 'data.unverified, data.provenance, findings MESH_CHECK_INPUT_UNVERIFIED',
    },
  },
  {
    vc: 'VC-MSH-28',
    what: 'check_mesh purpose print',
    expected: {
      cleanIcosphere: 'pass',
      openHemisphere: 'fail MESH_CHECK_NOT_CLOSED',
      thinWallBox: 'fail MESH_CHECK_WALL_THIN (0.4 mm < 0.8 mm)',
      defectMesh: 'fail MESH_CHECK_NON_MANIFOLD + MESH_CHECK_SELF_OVERLAP + MESH_CHECK_DEGENERATE',
    },
    tolerance: 'exact',
    source: '(b) constructed cases',
    grade: 'A',
    proves: ['FR-MSH-26', 'TR-MSH-12'],
    cli: { run: `llull check_mesh ids=[...] purpose=print minWallThickness=0.8 ${D}`, assert: 'data.status, data.findings[*].code' },
  },
  {
    vc: 'VC-MSH-29',
    what: 'large mesh: noisy icosphere l8 (1 310 720 triangles) on the native engine: decimate to 100k, Taubin 10, remesh L 0.2; TS engine refuses above its cap',
    expected: {
      licences: 'resources/native/licenses holds the notice of every third-party component linked into llull-compute (TR-MSH-15)',
      native: 'completes; times TBD - measure (budgets TECHNICAL_SPEC 8)',
      ts: 'MESH_ENGINE_CAP_EXCEEDED + NATIVE_TOOL_MISSING without llull-compute',
    },
    tolerance: 'TBD',
    source: '(c) TBD - measure',
    grade: 'C',
    proves: ['FR-MSH-02', 'FR-MSH-34', 'TR-MSH-03', 'TR-MSH-14', 'TR-MSH-15'],
    cli: { run: `llull decimate_mesh id=$big targetTriangles=100000 --progress --timeout 120 ${D}`, assert: 'data.triangles, report.ms' },
  },
  {
    vc: 'VC-MSH-30',
    what: "baseline plan on today's llull",
    expected: 'plans/baseline_mesh_today.json expect',
    tolerance: 'see plan',
    source: '(b) data/icosphere_convergence.json',
    grade: 'A',
    proves: ['FR-MSH-27'],
    cli: { run: `llull run plans/baseline_mesh_today.json --kernel manifold ${D}`, assert: 'plan expect' },
  },
  {
    vc: 'VC-MSH-31',
    what: 'asset-backed mesh: document stays small, export uses full resolution, replay without the asset refuses',
    expected: {
      documentBytesMax: 'TBD - set from measurement (target: LOD <= 50 000 triangles)',
      exportTriangles: 1310720,
      missingAsset: 'MESH_ASSET_MISSING',
    },
    tolerance: 'exact counts',
    source: '(b) design rule TR-MSH-05',
    grade: 'A (counts)',
    proves: ['FR-MSH-02', 'FR-MSH-27', 'TR-MSH-05', 'TR-MSH-06'],
    cli: {
      run: `llull mesh import big.stl --units mm --json; llull attach_mesh_asset assetKey=<key> ${D}; llull export_stl entityIds=[$m] format=binary --save out.stl ${D}`,
      assert: 'data.triangleCount',
    },
  },
  {
    vc: 'VC-MSH-32',
    what: 'TS engine vs native engine identical results on VC-05/06/08/19 inputs',
    expected: { identicalSha256: true },
    tolerance: 'bit-identical',
    source: '(b) RS1 rule 3 pattern (llull-geomq)',
    grade: 'A',
    proves: ['FR-MSH-28', 'TR-MSH-02', 'TR-MSH-03', 'TR-MSH-16'],
    cli: { run: 'server test: run each op with ctx.meshProcessing = ts and = native', assert: 'mesh sha256' },
  },
  {
    vc: 'VC-MSH-33',
    what: 'CLI audit: llull search mesh finds the commands; describe shows a unit on every numeric param; guide has a mesh section',
    expected: { paramsWithoutUnit: 0, resultNumbersWithoutUnit: 0 },
    tolerance: 'exact',
    source: '(b) AF-01..04, AF-10',
    grade: 'A',
    proves: ['FR-MSH-35', 'FR-MSH-36', 'TR-MSH-07'],
    cli: { run: 'llull search mesh --json; llull describe decimate_mesh --json; llull guide', assert: 'contract test' },
  },
  {
    vc: 'VC-MSH-34',
    what: 'UI review overlays (face groups, deviation map, boundary loops) do not change the document',
    expected: { documentUnchanged: true },
    tolerance: 'exact',
    source: '(b) L1/L4',
    grade: 'A',
    proves: ['FR-MSH-37'],
    cli: { run: 'component test', assert: 'store document deep-equal' },
  },
  {
    vc: 'VC-MSH-35',
    what: 'repair_mesh mode wrap on a self-overlapping union soup of two spheres R 10, centres 10 apart',
    expected: { closed: true, selfIntersections: 0, volume: r12(union), area: r12(unionArea) },
    tolerance: { rule: 'level set eps 0.01: |dV| <= A * eps', absBound: r12(unionArea * 0.01) },
    source: '(b) lens volume pi (4R + d)(2R - d)^2 / 12; union area 2 * 4 pi R^2 - 2 * 2 pi R h, h = R - d/2',
    grade: 'A',
    proves: ['FR-MSH-07'],
    cli: { run: `llull repair_mesh id=$soup mode=wrap tolerance=0.01 ${D}`, assert: 'data.volumeAfter' },
  },
  {
    vc: 'VC-MSH-36',
    what: 'subdivide_mesh method midpoint (linear) on the icosahedron: faces x4, area and volume unchanged',
    expected: { faces: 80, area: r12(20 * Math.sqrt(3)), volume: hull.cases[1].expected.volume },
    tolerance: { value: 1e-12, relative: true },
    source: '(b) linear subdivision keeps the geometry',
    grade: 'A',
    proves: ['FR-MSH-11'],
    cli: { run: `llull subdivide_mesh id=$ico method=midpoint levels=1 ${D}`, assert: 'data.faces, data.volume' },
  },
  {
    vc: 'VC-MSH-37',
    what: 'fit a NURBS patch to the tilted planar grid (z = 0.3x + 0.2y)',
    expected: { maxDeviation: 0, area: qem.cases[1].expectedArea },
    tolerance: { deviation: 1e-9, area: 1e-9 },
    source: '(b) a plane is reproduced exactly by any B-spline fit of degree >= 1',
    grade: 'A',
    proves: ['FR-MSH-24'],
    cli: { run: `llull fit_surface_to_mesh id=$grid degree=3 controlPoints=[8,8] ${D}`, assert: 'data.maxDeviation' },
  },
  {
    vc: 'VC-MSH-38',
    what: 'shrinkwrap_mesh nearest-point projection of an icosphere R 12 l3 onto an icosphere R 10 l4 target',
    expected: { maxDistanceToTarget: 0, vertexCount: 642 },
    tolerance: 1e-12,
    source: '(b) closest-point projection lands on the target by definition (BVH closest point, llull-bvh)',
    grade: 'A',
    proves: ['FR-MSH-38'],
    cli: {
      run: `llull shrinkwrap_mesh id=$a targetId=$b mode=nearest ${D}; llull measure_deviation id=$b referenceId=$a ${D}`,
      assert: 'data.max',
    },
  },
  {
    vc: 'VC-MSH-39',
    what: 'displace_mesh by a constant height 0.5 over the open grid 20 x 20 (no refinement)',
    expected: { sweptVolumeBetweenSurfaces: 200, maxDisplacement: 0.5 },
    tolerance: { value: 1e-12, relative: true },
    source: '(b) h * A for a translation along the (constant) normal',
    grade: 'A',
    proves: ['FR-MSH-39'],
    cli: { run: `llull displace_mesh id=$grid expression=0.5 ${D}`, assert: 'data.displacedVolume' },
  },
];

fs.writeFileSync(
  path.join(here, 'expected_results.json'),
  JSON.stringify(
    {
      gap: 'MSH',
      pack: 'docs/design/07-mesh-modeling',
      generated: '2026-10-22',
      generatedBy: 'generate_expected_results.mjs from data/*.json',
      notes:
        'Values: (a) quoted from a source, (b) derived analytically / reference code run (derivation in source), (c) TBD with the tool to measure. Source ids refer to validation/sources.md. Only grade A values gate pass/fail.',
      cases,
    },
    null,
    1,
  ) + '\n',
);
process.stdout.write(`wrote expected_results.json (${cases.length} cases)\n`);
