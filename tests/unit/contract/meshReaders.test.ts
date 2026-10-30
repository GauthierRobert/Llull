/**
 * TECHNICAL_SPEC 13.11 audit as a contract: every source file that reads the triangles of an entity (`entityToTriangles`, `solidTriangles`,
 * `meshTriangles`, `collectExportParts`) is listed here with who answers for an asset-backed mesh. A new reader fails this test until it is
 * listed, so a command that computes from triangles cannot silently read the display level of detail.
 *   - commands: these commands must carry `annotations.readsMeshTriangles` (execute swaps in the stored mesh);
 *   - assets: the code reads `ctx.meshAssets` itself (exports, mesh commands);
 *   - host: a pure builder run by the host without execute; it refuses a display-only body by name and the host hands it a full-resolution document;
 *   - display: the result is a picture or a preview of the display mesh, by design;
 *   - helper: the callers are the commands of the other entries;
 *   - derived: the entity is derived by a plugin, never asset-backed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCommand } from '@core/commands/registry';
import { listCommands } from '@core/commands/commandTable';

const READERS =
  /\b(entityToTriangles|entityTrianglePositions|solidTriangles|meshTriangles|localTriangles|collectExportParts|collectExportTriangles)\b/;
/** Wider: the construction tree of a solid, mass integration, and direct reads of mesh arrays. A file that defines commands and matches is checked command by command. */
const WIDE =
  /\b(recipeOf|operandRecipe|exactRecipe|exactOrMesh|meshRecipeOf|bodyMassProperties|resolveMassProperties|technicalView|assemblyParts|loadSolidMesh)\b|\.mesh\.(positions|indices)\b/;
const COMMAND_NAME = /defineCommand\(\{\s*name: '([a-z0-9_]+)'/g;
const DEFINING = new Set([
  'core/src/geometry/entityTriangles.ts',
  'core/src/geometry/solidTriangles.ts',
  'core/src/geometry/tessellation.ts',
  'core/src/geometry/mesh/assets.ts',
]);

type Answer =
  | { readonly commands: readonly string[] }
  | { readonly assets: string }
  | { readonly display: string }
  | { readonly helper: string }
  | { readonly host: string }
  | { readonly derived: string };

const DEFORM = [
  'bend_body',
  'twist_body',
  'taper_body',
  'stretch_body',
  'scale_nonuniform',
  'deform_by_point',
  'flow_on_surface',
  'flow_along_curve',
  'deform_lattice',
  'deform_curve_to_curve',
  'morph_bodies',
];

const AUDIT: Readonly<Record<string, Answer>> = {
  'core/src/codegen/featureProgram.ts': { commands: ['export_code'] },
  'core/src/codegen/skinLowering.ts': { commands: ['export_code'] },
  'core/src/commands/edit/decals.ts': { commands: ['add_decal'] },
  'core/src/commands/deform/sourceMesh.ts': { commands: DEFORM },
  'core/src/commands/deform/target.ts': { commands: DEFORM },
  'core/src/commands/exchange/export3mf.ts': { assets: 'collectExportParts with ctx.meshAssets' },
  'core/src/commands/exchange/exportFormats.ts': { assets: 'collectExportParts with ctx.meshAssets' },
  'core/src/commands/exchange/exportGltf.ts': { assets: 'collectExportParts + withFullResolution' },
  'core/src/commands/exchange/exportStl.ts': { assets: 'collectExportParts with ctx.meshAssets' },
  'core/src/commands/exchange/exportUrdf.ts': { commands: ['export_urdf'] },
  'core/src/commands/exchange/gltfScene.ts': { assets: 'export_gltf builds its scene from withFullResolution' },
  'core/src/commands/exchange/meshToSolid.ts': { commands: ['mesh_to_solid'] },
  'core/src/commands/mesh/meshCommon.ts': { assets: 'loadSolidMesh reads the asset before this branch' },
  'core/src/commands/render/polygons.ts': { display: 'render_view / render_motion / render_walkthrough draw the display mesh' },
  'core/src/commands/surface/surfaceShared.ts': { commands: ['analyze_draft', 'check_continuity', 'measure_deviation'] },
  'core/src/geometry/instanceExpansion.ts': { helper: 'bakes a component child; callers are the commands of the other entries' },
  'core/src/geometry/resolveMassProperties.ts': { commands: ['mass_properties', 'geometric_validation_properties', 'bill_of_materials'] },
  'core/src/geometry/technicalView.ts': { commands: ['export_sheet_svg'] },
  'domain-aec/src/scan/designPrimitives.ts': { commands: ['cloud_to_model_deviation', 'check_asbuilt_clash'] },
  'domain-aero/src/aerodynamics/geometryArea.ts': { commands: ['frontal_area', 'compute_aero_drag', 'road_load_power'] },
  'domain-aero/src/cfd/flowSurface.ts': { commands: ['prepare_cfd_case', 'check_cfd'] },
  'domain-aero/src/fasteners/stackMeasure.ts': {
    commands: ['insert_fastener_stack', 'insert_fastener_row', 'check_fastener_layout', 'select_fastener'],
  },
  'domain-aero/src/sheetmetal/foldPiece.ts': { derived: 'sheet-metal pieces are derived solids' },
  'domain-cae/src/topology/job.ts': {
    host: 'buildTopologyJob is run by the server, not execute: it refuses MESH_ASSET_LOD_ONLY on a display-only body and the server hands it withFullResolution',
  },
  'domain-cae/src/topology/rebuild.ts': { commands: ['suggest_rebuild', 'compare_to_topology'] },
  'domain-cae/src/topology/regions.ts': { commands: ['set_topology_regions'] },
  'domain-cae/src/topology/voxel.ts': { commands: ['create_topology_study'] },
  'domain-implicit/src/solidMesh.ts': {
    commands: [
      'field_from_solid',
      'create_implicit_body',
      'edit_field',
      'regenerate_implicit_bodies',
      'check_implicit',
      'implicit_properties',
      'evaluate_field',
      'section_field',
      'lattice_properties',
      'infill_solid',
      'create_scalar_field',
      'add_voronoi_lattice',
      'combine_fields',
    ],
  },
  'kernel-manifold/src/manifoldKernel.ts': { helper: 'doc comment only; the kernel gets triangles from the command that annotates' },
  'protocol/src/preview.ts': { display: '/preview draws the display mesh' },
};

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourcesUnder(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

const packages = path.join(import.meta.dirname, '..', '..', '..', 'packages');
const readers = readdirSync(packages)
  .filter((name) => statSync(path.join(packages, name, 'src'), { throwIfNoEntry: false })?.isDirectory() === true)
  .flatMap((name) => sourcesUnder(path.join(packages, name, 'src')))
  .map((file) => path.relative(packages, file).split(path.sep).join('/'))
  .filter((file) => !DEFINING.has(file))
  .filter((file) => READERS.test(readFileSync(path.join(packages, file), 'utf8')))
  .sort();

describe('every reader of entity triangles is accounted for (TECHNICAL_SPEC 13.11 audit)', () => {
  it('the files that read triangles are exactly the audited ones', () => {
    expect(readers).toEqual(Object.keys(AUDIT).sort());
  });

  it('each command named in the audit exists and carries readsMeshTriangles', () => {
    for (const [file, answer] of Object.entries(AUDIT)) {
      if (!('commands' in answer)) continue;
      for (const name of answer.commands) {
        const command = getCommand(name);
        expect(command, `${file}: no command ${name}`).toBeDefined();
        const reads = command?.annotations?.readsMeshTriangles;
        expect(reads === true || reads === 'document', `${name} (${file}) must be annotated readsMeshTriangles`).toBe(true);
      }
    }
  });

  it('whole-document readers carry the explicit form', () => {
    expect(getCommand('bill_of_materials')?.annotations?.readsMeshTriangles).toBe('document');
    expect(getCommand('export_sheet_svg')?.annotations?.readsMeshTriangles).toBe(true);
    expect(typeof getCommand('export_sheet_svg')?.annotations?.wholeDocumentWhen).toBe('function');
  });

  it('a command that only draws or stores ids is not annotated', () => {
    for (const name of ['create_drawing_view', 'add_section_view', 'add_detail_view', 'measure_bounding_box'])
      expect(getCommand(name)?.annotations?.readsMeshTriangles, name).toBeUndefined();
  });
});

/** Commands defined in a file that matches WIDE and that still do not read triangles, with the reason. */
const NOT_READERS: Readonly<Record<string, string>> = {
  analyze_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  attach_mesh_asset: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  check_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  convex_hull: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  cut_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  fill_mesh_holes: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  fit_subdivision_to_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  fit_surface_to_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  offset_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  hollow_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  mesh_to_brep: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  minkowski_sum: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  remesh_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  segment_mesh: 'reads the stored mesh through ctx.meshAssets itself (loadSolidMesh)',
  measure_bounding_box: 'bounds come from asset.bounds (exact), no triangle is read',
  break_sketch_link: 'metadata only',
  flat_pattern: 'works on a derived sheet-metal part',
  materialize_flat_pattern: 'works on a derived sheet-metal part',
  set_gravity: 'no mass is read',
  delete_dynamics_item: 'no mass is read',
};

describe('every command of a file that builds or integrates solids is annotated or excused (second guard)', () => {
  const found = readdirSync(packages)
    .filter((name) => statSync(path.join(packages, name, 'src'), { throwIfNoEntry: false })?.isDirectory() === true)
    .flatMap((name) => sourcesUnder(path.join(packages, name, 'src')))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => WIDE.test(text) && text.includes('defineCommand('))
    .flatMap(({ text }) => [...text.matchAll(COMMAND_NAME)].map((match) => match[1] as string));

  it('no unexcused unannotated command', () => {
    const offenders = found.filter((name) => {
      const reads = getCommand(name)?.annotations?.readsMeshTriangles;
      return reads !== true && reads !== 'document' && NOT_READERS[name] === undefined;
    });
    expect(offenders).toEqual([]);
  });

  it('the excuses name real, unannotated commands in matching files', () => {
    for (const name of Object.keys(NOT_READERS)) {
      expect(found.includes(name), name).toBe(true);
      expect(getCommand(name)?.annotations?.readsMeshTriangles, name).toBeUndefined();
    }
  });
});

describe('a query degrades, a result that is written refuses (TECHNICAL_SPEC 13.11.7)', () => {
  const annotated = listCommands().filter((command) => {
    const reads = command.annotations?.readsMeshTriangles;
    return reads === true || reads === 'document';
  });

  it('every annotated export_* command is flagged writesArtifact', () => {
    const offenders = annotated.filter((c) => c.name.startsWith('export_') && c.annotations?.writesArtifact !== true).map((c) => c.name);
    expect(offenders).toEqual([]);
  });

  it('writesArtifact is only on readOnly commands that read triangles (a mutating command refuses anyway)', () => {
    const flagged = listCommands().filter((c) => c.annotations?.writesArtifact === true);
    expect(flagged.length).toBeGreaterThan(5);
    for (const command of flagged) {
      expect(command.annotations?.readOnly, command.name).toBe(true);
      expect(annotated.includes(command), command.name).toBe(true);
    }
  });
});
