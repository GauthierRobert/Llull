/**
 * The `llull-compute explicit` job of an explicit case (TR-EXP-70): mesh, materials, initial velocities, rigid walls and controls in the case
 * unit system. Pure: the host writes it into a job folder (server/src/native/explicitJobFiles.ts).
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { ExplicitSpec } from '@core/model/explicit';
import type { Vec3 } from '@core/model/vectors';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { analysisLengthMetres } from '../shared/defaults';
import { explicitInputHash } from './hash';
import { explicitMaterial, type ExplicitMaterial } from './laws';
import { feaTetMesh, structuredHexMesh, type ExplicitMesh } from './mesh';
import { explicitCase, supportedUnits } from './model';

interface ExplicitJobWall {
  readonly name: string;
  /** Case length unit. */
  readonly point: Vec3;
  /** Unit normal. */
  readonly normal: Vec3;
}

export interface ExplicitJob {
  readonly analysisId: string;
  readonly inputHash: string;
  readonly unitSystem: string;
  readonly units: { readonly length: string; readonly stress: string; readonly energy: string; readonly force: string };
  readonly mesh: ExplicitMesh;
  readonly materials: readonly ExplicitMaterial[];
  /** Johnson–Cook D1–D5 per entry of `materials` (null: no failure law). */
  readonly materialFailure: readonly (readonly number[] | null)[];
  /** Index into `materials` per element (hex8 first, then tet4). */
  readonly elementMaterial: readonly number[];
  /** Part index per element (position in the sorted part ids). */
  readonly elementPart: readonly number[];
  /** Contacts with their sides as part indices. */
  readonly contacts: readonly {
    readonly name: string;
    readonly kind: 'surface_to_surface' | 'nodes_to_surface' | 'self';
    readonly a: readonly number[];
    readonly b: readonly number[];
    readonly friction: { readonly static: number; readonly dynamic: number; readonly decay: number };
    readonly penaltyScale: number;
  }[];
  /** 3 values per node, case velocity unit. */
  readonly initialVelocity: readonly number[];
  readonly gravity: Vec3;
  readonly walls: readonly ExplicitJobWall[];
  readonly spec: ExplicitSpec;
  readonly unverifiedReasons: readonly string[];
}

export type ExplicitJobResult =
  | { readonly ok: true; readonly job: ExplicitJob }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly ids: readonly string[] };

const scaled = (vector: Vec3, factor: number): Vec3 => [vector[0] * factor, vector[1] * factor, vector[2] * factor];

const refuse = (code: string, message: string, ids: readonly string[]): ExplicitJobResult => ({ ok: false, code, message, ids });

/**
 * @failure unknown / non-explicit case or no controls -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE / EXP_CONTROLS_MISSING; other unit systems ->
 *   EXP_UNITS_UNSUPPORTED; no parts / mesh refusals -> EXP_MESH_UNSUPPORTED; fea_mesh without a mesh artifact -> EXP_MESH_MISSING; material
 *   refusals -> EXP_MATERIAL_*; neither an initial velocity nor gravity -> EXP_NO_EXCITATION
 */
export function buildExplicitJob(doc: CadDocument, analysisId: string, meshArtifact: FeMeshArtifact | null): ExplicitJobResult {
  const found = explicitCase(doc, analysisId);
  if ('code' in found) return refuse(found.code, found.message, [analysisId]);
  const { analysisCase, spec } = found;
  if (spec === undefined)
    return refuse('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls: set_explicit_controls`, [analysisId]);
  const units = supportedUnits(analysisCase);
  if (units === null) return refuse('EXP_UNITS_UNSUPPORTED', `unit system ${analysisCase.unitSystem} is not supported`, [analysisId]);
  const partIds = Object.keys(analysisCase.parts).sort();
  if (partIds.length === 0)
    return refuse('EXP_MESH_UNSUPPORTED', `analysis '${analysisId}' has no parts (set_part_idealization)`, [analysisId]);
  const lengthToAnalysis = toMetres(doc, 1) / analysisLengthMetres(analysisCase.unitSystem);
  let mesh: ExplicitMesh | { code: string; message: string; ids: readonly string[] };
  if (spec.mesh.kind === 'structured_hex') mesh = structuredHexMesh(doc, analysisCase, spec.mesh.size, lengthToAnalysis);
  else if (meshArtifact === null)
    return refuse('EXP_MESH_MISSING', `analysis '${analysisId}' uses mesh fea_mesh but has no current mesh artifact: run fea_mesh`, [
      analysisId,
    ]);
  else mesh = feaTetMesh(meshArtifact);
  if ('code' in mesh) return refuse(mesh.code, mesh.message, mesh.ids);

  const materials: ExplicitMaterial[] = [];
  const partMaterial = new Map<string, number>();
  for (const entityId of partIds) {
    const material = explicitMaterial(doc, analysisCase, entityId);
    if ('code' in material) return refuse(material.code, material.message, [entityId]);
    let index = materials.findIndex((known) => known.materialId === material.materialId);
    if (index < 0) index = materials.push(material) - 1;
    partMaterial.set(entityId, index);
  }
  const failures = spec.failure ?? {};
  const withoutStrength = materials.find((material) => Object.hasOwn(failures, material.materialId) && material.johnsonCook === undefined);
  if (withoutStrength !== undefined)
    return refuse(
      'EXP_MATERIAL_INCOMPLETE',
      `material '${withoutStrength.materialId}' has Johnson-Cook failure constants but no Johnson-Cook strength law (its plastic strain drives the damage)`,
      [analysisId],
    );
  const materialFailure = materials.map((material) =>
    Object.hasOwn(failures, material.materialId) ? (failures[material.materialId]?.D ?? null) : null,
  );
  const velocities = new Map(Object.values(spec.initialVelocities).map((entry) => [entry.entityId, entry.velocity] as const));
  const gravity: Vec3 = spec.gravity ?? [0, 0, 0];
  if (velocities.size === 0 && gravity.every((component) => component === 0))
    return refuse('EXP_NO_EXCITATION', `analysis '${analysisId}' has no initial velocity and no gravity`, [analysisId]);
  const initialVelocity = mesh.nodePart.flatMap((part) => [...(velocities.get(part) ?? [0, 0, 0])]);
  const walls = spec.rigidWallOrder.flatMap((id) => {
    const wall = spec.rigidWalls[id];
    if (wall === undefined) return [];
    const length = Math.hypot(...wall.normal);
    return [{ name: wall.name, point: scaled(wall.point, lengthToAnalysis), normal: scaled(wall.normal, 1 / length) }];
  });
  return {
    ok: true,
    job: {
      analysisId,
      inputHash: explicitInputHash(doc, analysisCase),
      unitSystem: analysisCase.unitSystem,
      units,
      mesh,
      materials,
      materialFailure,
      elementPart: mesh.elementPart.map((part) => partIds.indexOf(part)),
      contacts: (spec.contactOrder ?? []).flatMap((id) => {
        const contact = spec.contacts?.[id];
        if (contact === undefined) return [];
        const parts = (ids: readonly string[]): number[] => ids.map((entityId) => partIds.indexOf(entityId)).filter((index) => index >= 0);
        return [
          {
            name: contact.name,
            kind: contact.kind,
            a: parts(contact.a),
            b: parts(contact.b),
            friction: contact.friction,
            penaltyScale: contact.penaltyScale.value,
          },
        ];
      }),
      elementMaterial: mesh.elementPart.map((part) => partMaterial.get(part) ?? 0),
      initialVelocity,
      gravity,
      walls,
      spec,
      unverifiedReasons: [...new Set(materials.flatMap((material) => material.unverifiedReasons))],
    },
  };
}
