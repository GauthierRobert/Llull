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

// Fixture font: the pinned Fira Sans Regular (sources.md R24), copied by the test fixture script to fixtures/wrp/.
const FONT = 'fixtures/wrp/FiraSans-Regular.ttf';

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
  { command: 'import_font', params: { path: FONT }, as: 'fira' },
  { command: 'add_cylinder', params: { radius: 20, height: 40, position: [0, 0, 0] }, as: 'body' },
  { command: 'mass_properties', params: { entityId: '$body' } },
  { command: 'add_text', params: { content: 'LLULL', position: [0, 0, 0], height: 10, anchor: 'center', font: '$fira' }, as: 'label' },
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
  { command: 'inspect_faces', params: { id: '$scribed' } },
  { command: 'check_wrap', params: { ids: ['$onCone', '$scribed'] } },
]);

// 5. Target: doubly curved face, geodesic (exponential-map) wrap with the distortion report.
write('target_sphere_geodesic_wrap.json', [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_sphere', params: { radius: 25, position: [0, 0, 0] }, as: 'ball' },
  { command: 'draw_arc', params: { center: [0, 0], radius: 10 }, as: 'disk' },
  {
    command: 'wrap_to_face',
    params: {
      id: '$ball',
      face: { faceNear: [0, 0, 25] },
      entityIds: ['$disk'],
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } },
    },
    as: 'onBall',
  },
  {
    command: 'emboss_on_face',
    params: {
      id: '$ball',
      face: { faceNear: [0, 0, 25] },
      profileIds: ['$disk'],
      mode: 'emboss',
      depth: 0.5,
      placement: { method: 'geodesic', anchor: { chart: [0, 0], on: [0, 0, 25] } },
    },
    as: 'badge',
  },
  { command: 'check_wrap', params: { ids: ['$onBall', '$badge'], maxLengthStrain: 0.05 } },
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
  { command: 'import_font', params: { path: 'fixtures/wrp/not-a-font.txt' } },
]);

console.warn('wrote plans/*.json');
