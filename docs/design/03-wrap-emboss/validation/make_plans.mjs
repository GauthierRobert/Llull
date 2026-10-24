#!/usr/bin/env node
// WRP build_project plans (`llull run plans/<file>.json --doc t.llull.json --json`). `baseline_*` runs on today's llull (existing commands
// only); `target_*` use the commands proposed in TECHNICAL_SPEC §4 (unbuilt commands are listed in `unbuiltCommands` of each plan's
// sidecar entry in expected_results.json and in validation/README.md §1).
//   node make_plans.mjs        writes plans/*.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'plans');
mkdirSync(dir, { recursive: true });
const write = (name, steps) => writeFileSync(join(dir, name), `${JSON.stringify(steps, null, 1)}\n`);

// 1. Baseline (exists today): the full-band emboss as a union of two cylinders, a planar emboss by extrude + union, a painted decal.
write('baseline_band_and_planar_emboss.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'body' },
  { command: 'add_cylinder', params: { radius: 21, height: 10, position: [0, 0, 0] }, as: 'band' },
  { command: 'boolean', params: { op: 'union', a: '$body', b: '$band' }, as: 'banded' },
  { command: 'mass_properties', params: { entityId: '$banded' } },
  { command: 'add_box', params: { size: [60, 40, 10], anchor: 'min', position: [100, 0, 0] }, as: 'plate' },
  { command: 'draw_rectangle', params: { width: 30, height: 10, position: [115, 15, 10] }, as: 'rect' },
  { command: 'extrude_profile', params: { id: '$rect', depth: 1 }, as: 'boss' },
  { command: 'boolean', params: { op: 'union', a: '$plate', b: '$boss' }, as: 'plateEmbossed' },
  { command: 'mass_properties', params: { entityId: '$plateEmbossed' } },
  { command: 'add_decal', params: { id: '$banded', text: 'LLULL', at: [21, 0, 0], normal: [1, 0, 0], height: 5 } },
  { command: 'mass_properties', params: { entityId: '$banded' } },
]);

// 2. Target: wrapped text emboss and deboss on a cylinder (exact, faceSlab-based), with the numeric check.
write('target_cylinder_text_emboss.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'body' },
  { command: 'mass_properties', params: { entityId: '$body' } },
  { command: 'add_text', params: { content: 'LLULL', position: [0, 0, 0], height: 10, anchor: 'center', font: 'Fira Sans' }, as: 'label' },
  { command: 'text_outline', params: { id: '$label' } },
  {
    command: 'emboss_on_face',
    params: {
      id: '$body',
      face: { faceNear: [20, 0, 0] },
      profileIds: ['$label'],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [20, 0, 0] }, angleDeg: 0 },
    },
    as: 'embossed',
  },
  { command: 'mass_properties', params: { entityId: '$embossed' } },
  { command: 'check_wrap', params: { ids: ['$embossed'] } },
  { command: 'render_view', params: { view: 'front', isolate: '$embossed' } },
]);

// 3. Target: rectangle emboss / deboss on a cylinder (closed-form volumes 307.5 / 292.5).
write('target_cylinder_rect_emboss_deboss.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'a' },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [100, 0, 0] }, as: 'b' },
  { command: 'draw_rectangle', params: { width: 30, height: 10, position: [-15, -5, 0] }, as: 'rect' },
  {
    command: 'emboss_on_face',
    params: { id: '$a', face: { faceNear: [20, 0, 0] }, profileIds: ['$rect'], mode: 'emboss', depth: 1, placement: { method: 'develop' } },
    as: 'raised',
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$b',
      face: { faceNear: [120, 0, 0] },
      profileIds: ['$rect'],
      mode: 'deboss',
      depth: 1,
      placement: { method: 'develop' },
    },
    as: 'sunk',
  },
  { command: 'mass_properties', params: { entityId: '$raised' } },
  { command: 'mass_properties', params: { entityId: '$sunk' } },
  { command: 'check_wrap', params: { ids: ['$raised', '$sunk'] } },
]);

// 4. Target: curves wrapped on a cone (length-preserving development) and a scribe split line.
write('target_cone_wrap_scribe.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cone', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'cone' },
  { command: 'unwrap_face', params: { id: '$cone', face: { faceNear: [10, 0, 20] } } },
  {
    command: 'draw_polyline',
    params: {
      points: [
        [-10, 0],
        [10, 0],
      ],
    },
    as: 'seg',
  },
  { command: 'draw_arc', params: { center: [0, 0], radius: 4 }, as: 'ring' },
  {
    command: 'wrap_to_face',
    params: {
      id: '$cone',
      face: { faceNear: [10, 0, 20] },
      entityIds: ['$seg', '$ring'],
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [10, 0, 20] }, angleDeg: 90 },
    },
    as: 'onCone',
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$cone',
      face: { faceNear: [10, 0, 20] },
      profileIds: ['$ring'],
      mode: 'scribe',
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [10, 0, 20] } },
    },
    as: 'scribed',
  },
  { command: 'inspect_faces', params: { entityId: '$scribed' } },
  { command: 'check_wrap', params: { ids: ['$onCone', '$scribed'] } },
]);

// 5. Target: doubly curved face, geodesic (exponential-map) wrap with the distortion report (VC-WRP-08, 28). The disk a 10 stretches by 2.65 %, a 20 by 10.3 %: both exceed
// the named 2 % default, so the plan names its limits (0.05 for the wrap and the badge, 0.2 for the wide disk, which check_wrap then fails against 0.05).
write('target_sphere_geodesic_wrap.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_sphere', params: { radius: 25, position: [0, 0, 0] }, as: 'ball' },
  { command: 'draw_arc', params: { center: [0, 0], radius: 10 }, as: 'disk' },
  { command: 'draw_arc', params: { center: [0, 0], radius: 20 }, as: 'wide' },
  {
    command: 'wrap_to_face',
    params: {
      id: '$ball',
      face: { faceNear: [0, 0, 25] },
      entityIds: ['$disk'],
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } },
      maxLengthStrain: 0.05,
    },
    as: 'onBall',
  },
  {
    command: 'wrap_to_face',
    params: {
      id: '$ball',
      face: { faceNear: [0, 0, 25] },
      entityIds: ['$wide'],
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } },
      maxLengthStrain: 0.2,
    },
    as: 'onBallWide',
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$ball',
      face: { faceNear: [0, 0, 25] },
      profileIds: ['$disk'],
      mode: 'emboss',
      depth: 0.5,
      maxLengthStrain: 0.05,
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } },
    },
    as: 'badge',
  },
  { command: 'check_wrap', params: { ids: ['$onBall', '$badge'], maxLengthStrain: 0.05 } },
  { command: 'check_wrap', params: { ids: ['$onBallWide'], maxLengthStrain: 0.05 } },
]);

// 5b. Target: curves lying on faces (VC-WRP-37 geodesics on the cylinder, a great circle on a sphere, an equator of a torus) and a split line (VC-WRP-17: a sketch circle
// projected onto the cylinder cuts one patch out of its side face).
write('target_curves_on_face_and_split.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'body' },
  ...[
    [1, 10],
    [0.5, 0],
    [2, 5],
  ].map(([theta, z], k) => ({
    command: 'create_curve_on_face',
    params: {
      id: '$body',
      face: { faceNear: [20, 0, 0] },
      mode: 'geodesic',
      from: [20, 0, 0],
      to: [20 * Math.cos(theta), 20 * Math.sin(theta), z],
    },
    as: `geodesic${k + 1}`,
  })),
  { command: 'add_sphere', params: { radius: 25, position: [100, 0, 0] }, as: 'ball' },
  {
    command: 'create_curve_on_face',
    params: {
      id: '$ball',
      face: { faceNear: [100, 0, 25] },
      mode: 'geodesic',
      from: [100, 0, 25],
      to: [100 + 25 * Math.sin(0.5), 0, 25 * Math.cos(0.5)],
    },
    as: 'greatCircle',
  },
  { command: 'add_torus', params: { ringRadius: 10, tubeRadius: 3, position: [200, 0, 0] }, as: 'ring' },
  {
    command: 'create_curve_on_face',
    params: {
      id: '$ring',
      face: { faceNear: [213, 0, 0] },
      mode: 'geodesic',
      from: [213, 0, 0],
      to: [200 + 13 * Math.cos(0.3), 13 * Math.sin(0.3), 0],
    },
    as: 'equator',
  },
  { command: 'create_sketch_plane', params: { plane: 'yz', offset: 30 }, as: 'side' },
  { command: 'draw_arc', params: { center: [0, 0], radius: 6 }, as: 'mask' },
  { command: 'place_on_sketch_plane', params: { ids: ['$mask'], plane: '$side' } },
  { command: 'project_to_face', params: { id: '$body', entityIds: ['$mask'], direction: [-1, 0, 0] }, as: 'projected' },
  { command: 'mass_properties', params: { entityId: '$body' } },
  { command: 'split_face_by_curves', params: { id: '$body', curveIds: ['$projected', '$projected[1]'] }, as: 'split' },
  { command: 'mass_properties', params: { entityId: '$split' } },
]);

// 5c. Target: decals and knurls (VC-WRP-23 wrap decal, VC-WRP-24 cosmetic knurl, VC-WRP-39 modeled knurl).
write('target_decal_and_knurl.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'drum' },
  {
    command: 'add_decal',
    params: { id: '$drum', text: 'LLULL', at: [20, 0, 0], normal: [1, 0, 0], height: 5, width: 30, mapping: 'wrap' },
  },
  {
    command: 'add_decal',
    params: { id: '$drum', text: 'LLULL', at: [20, 0, 10], normal: [1, 0, 0], height: 5, width: 30, mapping: 'wrap', font: 'Fira Sans' },
  },
  { command: 'add_cylinder', params: { radius: 10, height: 40, position: [100, 0, 0] }, as: 'rod' },
  { command: 'add_knurl', params: { id: '$rod', face: { faceNear: [110, 0, 0] }, pattern: 'straight', pitch: 1 } },
  { command: 'add_cylinder', params: { radius: 10, height: 40, position: [200, 0, 0] }, as: 'grip' },
  {
    command: 'add_knurl',
    params: { id: '$grip', face: { faceNear: [210, 0, 0] }, pattern: 'straight', pitch: 1, model: 'geometry' },
    as: 'knurled',
  },
  { command: 'mass_properties', params: { entityId: '$knurled' } },
]);

// 5d. Target: single-line engraving, text bent along an arc, and a dimple pattern (VC-WRP-38).
write('target_engrave_curve_text_pattern.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'body' },
  {
    command: 'add_text',
    params: { content: 'LLULL', position: [0, 0, 0], height: 8, anchor: 'center', verticalAnchor: 'cap_middle', font: 'LLULL Single Line' },
    as: 'serial',
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$body',
      face: { faceNear: [20, 0, 0] },
      profileIds: ['$serial'],
      mode: 'engrave',
      depth: 0.4,
      toolWidth: 0.8,
      placement: { method: 'develop' },
    },
    as: 'engraved',
  },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [100, 0, 0] }, as: 'badge' },
  { command: 'draw_arc', params: { center: [0, -60], radius: 70, startAngle: 1.2, endAngle: 1.95 }, as: 'baseline' },
  {
    command: 'add_text',
    params: { content: 'LLULL', position: [0, 0, 0], height: 5, anchor: 'center', font: 'Fira Sans', onCurve: { curveId: '$baseline' } },
    as: 'bent',
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$badge',
      face: { faceNear: [120, 0, 0] },
      profileIds: ['$bent'],
      mode: 'emboss',
      depth: 0.5,
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [120, 0, 0] } },
    },
    as: 'lettered',
  },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [200, 0, 0] }, as: 'grip' },
  { command: 'draw_rectangle', params: { width: 2, height: 2, position: [-1, -1, 0] }, as: 'dimple' },
  {
    command: 'pattern_on_face',
    params: {
      id: '$grip',
      face: { faceNear: [220, 0, 0] },
      seedProfileIds: ['$dimple'],
      mode: 'emboss',
      depth: 0.5,
      grid: { countX: 12, countY: 3, pitchX: 5, pitchY: 6 },
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [200 + 20 * Math.cos(-0.5), 20 * Math.sin(-0.5), -6] } },
    },
    as: 'studded',
  },
  { command: 'mass_properties', params: { entityId: '$engraved' } },
  { command: 'mass_properties', params: { entityId: '$lettered' } },
  { command: 'mass_properties', params: { entityId: '$studded' } },
  { command: 'check_wrap', params: { ids: ['$engraved', '$lettered', '$studded'] } },
]);

// 5e. The WRP golden plan (native kernel): a bottle revolved from a polygon (plane bottom, cylinder body, cone shoulder, cylinder neck), a Fira Sans label embossed on the body, a
// NOTE: the cylinder face of a revolution has its OCC axis pointing to -z, and a chart is a view from outside with y along that axis, so the placements below turn the sketch by 180 degrees to stand upright.
// single-line serial number engraved, a dimple pattern, a split line round the body, a knurled neck, and the audit. Golden: tests/ native snapshot in server/tests/wrpGolden.test.ts.
write('golden_wrp_native.json', [
  { command: 'set_units', params: { units: 'mm' } },
  {
    command: 'revolve_profile',
    params: {
      profile: [
        [0, 0],
        [20, 0],
        [20, 50],
        [10, 60],
        [10, 80],
        [0, 80],
      ],
      axis: 'z',
      segments: 64,
    },
    as: 'bottle',
  },
  { command: 'add_text', params: { content: 'LLULL', position: [0, 0, 0], height: 8, anchor: 'center', font: 'Fira Sans' }, as: 'label' },
  {
    command: 'emboss_on_face',
    params: {
      id: '$bottle',
      face: { faceNear: [20, 0, 25] },
      profileIds: ['$label'],
      mode: 'emboss',
      depth: 0.6,
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [20, 0, 25] }, angleDeg: 180 },
    },
    as: 'branded',
  },
  {
    command: 'add_text',
    params: {
      content: 'SN 0042',
      position: [0, 0, 0],
      height: 4,
      anchor: 'center',
      verticalAnchor: 'cap_middle',
      font: 'LLULL Single Line',
    },
    as: 'serial',
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$branded',
      face: { faceNear: [20, 0, 10] },
      profileIds: ['$serial'],
      mode: 'engrave',
      depth: 0.3,
      toolWidth: 0.5,
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [20, 0, 10] }, angleDeg: 180 },
    },
    as: 'engraved',
  },
  { command: 'draw_rectangle', params: { width: 2, height: 2, position: [-1, -1, 0] }, as: 'dimple' },
  {
    command: 'pattern_on_face',
    params: {
      id: '$engraved',
      face: { faceNear: [20, 0, 40] },
      seedProfileIds: ['$dimple'],
      mode: 'deboss',
      depth: 0.4,
      grid: { countX: 8, countY: 2, pitchX: 6, pitchY: 6 },
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [20, 0, 40] }, angleDeg: 180 },
    },
    as: 'dimpled',
  },
  {
    command: 'create_curve_on_face',
    params: { id: '$dimpled', face: { faceNear: [-20, 0, 18] }, mode: 'isoparametric', through: [-20, 0, 18], direction: 'u' },
    as: 'seam',
  },
  { command: 'split_face_by_curves', params: { id: '$dimpled', curveIds: ['$seam'] }, as: 'zoned' },
  {
    command: 'add_knurl',
    params: { id: '$zoned', face: { faceNear: [10, 0, 70] }, pattern: 'straight', pitch: 1.5, model: 'geometry' },
    as: 'finished',
  },
  { command: 'mass_properties', params: { entityId: '$finished' } },
  { command: 'check_wrap', params: {} },
]);

// 6. Target: projection vs wrap on the same cylinder (numeric reason to prefer wrap for text).
write('target_projection_vs_wrap.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0], axis: [0, 0, 1] }, as: 'body' },
  { command: 'create_sketch_plane', params: { plane: 'yz', offset: 30 }, as: 'side' },
  {
    command: 'draw_polyline',
    params: {
      points: [
        [-15, 0],
        [15, 0],
      ],
    },
    as: 'seg',
  },
  { command: 'place_on_sketch_plane', params: { ids: ['$seg'], plane: '$side' } },
  { command: 'project_to_face', params: { id: '$body', entityIds: ['$seg'], direction: [-1, 0, 0] }, as: 'projected' },
  {
    command: 'wrap_to_face',
    params: {
      id: '$body',
      face: { faceNear: [20, 0, 0] },
      entityIds: ['$seg'],
      placement: { method: 'develop', anchor: { chart: [0, 0], on: [20, 0, 0] } },
    },
    as: 'wrapped',
  },
  { command: 'check_wrap', params: { ids: ['$projected', '$wrapped'] } },
]);

// 7. Target: deliberately wrong plan (VC-WRP-30). build_project aborts at the first failing step (step 7); the driver replays steps 8-11
// one by one as single CLI calls on the document left by steps 1-6, each must refuse with its documented code.
write('target_bad_inputs.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'body' },
  { command: 'add_sphere', params: { radius: 25, position: [100, 0, 0] }, as: 'ball' },
  { command: 'draw_rectangle', params: { width: 130, height: 10, position: [-65, -5, 0] }, as: 'tooWide' },
  {
    command: 'draw_polyline',
    params: {
      points: [
        [0, 0],
        [5, 5],
      ],
    },
    as: 'open',
  },
  { command: 'draw_rectangle', params: { width: 4, height: 4, position: [-2, -2, 0] }, as: 'small' },
  {
    command: 'emboss_on_face',
    params: {
      id: '$body',
      face: { faceNear: [20, 0, 0] },
      profileIds: ['$tooWide'],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'develop' },
    },
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$body',
      face: { faceNear: [20, 0, 0] },
      profileIds: ['$open'],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'develop' },
    },
  },
  {
    command: 'wrap_to_face',
    params: { id: '$ball', face: { faceNear: [100, 0, 25] }, entityIds: ['$open'], placement: { method: 'develop' } },
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$body',
      face: { faceNear: [20, 0, 0] },
      profileIds: ['$small'],
      mode: 'deboss',
      depth: 25,
      placement: { method: 'develop' },
    },
  },
  { command: 'import_font', params: { path: 'not-a-font.txt', base64: 'dGhpcyBpcyBub3QgYSBmb250IGZpbGU=' } },
]);

console.warn('wrote plans/*.json');
