/**
 * Solver job of a topology study: the pure function the host transport calls to turn the document into the optimiser's input (grid, masks,
 * nodal loads and gravity per load case, fixed dofs, material, objective, settings in voxel units).
 */

import type { FeaConstraint, UnitSystem } from '@core/model/analysis';
import type { TopologyArtifactGrid, TopologyStudy, WorldAxis } from '@core/model/topology';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { displayOnlyMeshIds, displayOnlyMessage } from '@core/geometry/mesh/displayOnly';
import { toMetres } from '@core/model/units';
import { is3D, type CadDocument } from '@core/model/types';
import { analysisLengthMetres } from '../shared/defaults';
import { caseOf } from '../shared/access';
import { stressPerMpa } from '../decks/units';
import { topologyInputHash, topologySettingsHash } from './hash';
import { forceLoad, gravityPerVoxel, pressureLoad } from './loads';
import { dofComponents, isMappingFailure, mapTarget, nodeSets, type MappedTarget } from './mapping';
import { densityOf, elasticOf } from './material';
import { regionMasks, voxelsAroundNodes } from './regions';
import { artifactGrid, domainTriangles, gridOver, insideMask, isGridRefusal, type TopologyGrid } from './voxel';

interface TopologyLoadCase {
  readonly name: string;
  readonly weight: number;
  /** Sparse nodal force (analysis force unit): `values[i]` acts on dof `dofs[i]`. */
  readonly dofs: readonly number[];
  readonly values: readonly number[];
  /** Force a fully solid voxel weighs under the case's gravity loads, per grid component (analysis force unit); absent without gravity. */
  readonly gravity?: readonly number[];
}

const GRID_AXES: readonly WorldAxis[] = ['x', 'y', 'z'];

export interface TopologyJob {
  readonly studyId: string;
  readonly analysisId: string;
  readonly unitSystem: UnitSystem;
  readonly dimension: 2 | 3;
  /** Grid placement and counts as stored in the artifact. Voxel index = i + nx (j + ny k); node index = i + (nx + 1) (j + (ny + 1) k); dof = dimension * node + component. */
  readonly grid: TopologyArtifactGrid;
  /** One byte per voxel (0 / 1), length nx * ny * nz. */
  readonly active: Uint8Array;
  readonly keepIn: Uint8Array;
  readonly keepOut: Uint8Array;
  /** Constrained dofs, ascending (every one is fixed to 0). */
  readonly fixedDofs: readonly number[];
  readonly loadCases: readonly TopologyLoadCase[];
  readonly material: {
    /** Young's modulus in the stress unit of `unitSystem`. */
    readonly youngsModulus: number;
    readonly poisson: number;
    readonly source: string;
    readonly unverifiedReasons: readonly string[];
  };
  /** 2D only: plane-stress thickness in the length unit of `unitSystem` (3D: 1). */
  readonly thickness: number;
  readonly volumeFraction: number;
  /** `maxCompliance` in the force x length unit of `unitSystem`. */
  readonly objective: { readonly kind: 'min_compliance' } | { readonly kind: 'min_volume'; readonly maxCompliance: number };
  /** Solver settings; lengths are in voxels. */
  readonly settings: {
    readonly penal: number;
    readonly eminRatio: number;
    readonly move: number;
    readonly changeTol: number;
    readonly maxIterations: number;
    /** The effective radius: the study's, raised to half the minimum member size when that is larger. */
    readonly filter: { readonly kind: 'sensitivity' | 'density'; readonly radiusVoxels: number };
    readonly threshold: number;
    readonly optimizer: 'oc' | 'mma';
    readonly projection?: { readonly beta: number; readonly eta: number; readonly betaStart: number; readonly betaEvery: number };
    /** GRID axis (x = i, y = j, z = k) the design is uniform along. */
    readonly extrusion?: WorldAxis;
    /** The minimum member rule as applied (document units and voxels). */
    readonly minMemberRule?: { readonly minMemberSize: number; readonly radiusVoxels: number; readonly raised: boolean };
  };
  readonly inputHash: string;
  readonly settingsHash: string;
}

interface TopologyJobRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

export type TopologyJobResult = { readonly ok: true; readonly job: TopologyJob } | TopologyJobRefusal;

const refuse = (code: string, message: string, ids: readonly string[] = []): TopologyJobRefusal => ({ ok: false, code, message, ids });

/** Dofs (by grid axis index 0..2) a constraint fixes on a grid, or an explanation when it cannot be expressed. */
function constrainedAxes(grid: TopologyGrid, constraint: FeaConstraint, mapped: MappedTarget): number[] | string {
  const inPlane = (worldAxis: number): number => grid.axes.indexOf(worldAxis);
  if (constraint.kind === 'fixed' || constraint.kind === 'pinned') return [...Array(dofComponents(grid)).keys()];
  if (constraint.kind === 'symmetry') {
    const normal = mapped.normal;
    if (normal === undefined) return 'a symmetry constraint needs a facesNear point';
    const world = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
    if (Math.abs(normal[world] ?? 0) < 0.999) return 'a symmetry face must be perpendicular to a coordinate axis';
    const axis = inPlane(world);
    return axis < dofComponents(grid) ? [axis] : [];
  }
  const axes: number[] = [];
  for (const [name, value] of Object.entries(constraint.dofs ?? {})) {
    const world = ['ux', 'uy', 'uz'].indexOf(name);
    if (world < 0) continue;
    if (value !== 0) return `a non-zero prescribed displacement (${name} = ${value}) is not supported`;
    const axis = inPlane(world);
    if (axis < dofComponents(grid)) axes.push(axis);
  }
  return axes;
}

/** The GRID axis of a world extrusion axis, or an explanation when it is the normal of a 2D grid. */
function extrusionAxis(grid: TopologyGrid, axis: WorldAxis): { readonly axis: WorldAxis } | { readonly error: string } {
  const index = grid.axes.indexOf(GRID_AXES.indexOf(axis));
  const name = GRID_AXES[index];
  return index < 0 || index >= grid.dimension || name === undefined
    ? { error: `extrusion axis ${axis} is the normal of the 2D grid plane` }
    : { axis: name };
}

/**
 * Builds the job of `study` from the document.
 * @failure an asset-backed solid of the domain or of a region that the document holds only as its display mesh -> MESH_ASSET_LOD_ONLY
 * @failure unknown analysis / invalid domain / grid above the cap / unmappable target / no supports or loads / unsupported load or constraint
 *   kind / mixed or missing material / min_volume without mma -> a coded refusal (TOP_*), never a throw
 */
export function buildTopologyJob(doc: CadDocument, study: TopologyStudy): TopologyJobResult {
  const regionIds = [...study.keepIn, ...study.keepOut].flatMap((region) =>
    region.kind === 'entity' ? [region.entityId] : region.kind === 'box' ? [] : [region.target.entityId],
  );
  const lodOnly = displayOnlyMeshIds(doc, [...study.designDomain, ...regionIds]);
  if (lodOnly.length > 0) return refuse('MESH_ASSET_LOD_ONLY', displayOnlyMessage(lodOnly), lodOnly);
  const analysisCase = caseOf(doc, study.analysisId);
  if (analysisCase === undefined) return refuse('TOP_ANALYSIS_MISSING', `no analysis '${study.analysisId}'`, [study.analysisId]);
  const triangles = domainTriangles(doc, study.designDomain);
  if (!Array.isArray(triangles)) return refuse(triangles.code, triangles.message, triangles.ids);
  const grid = gridOver(study, triangles);
  if (isGridRefusal(grid)) return refuse(grid.code, grid.message, [study.id]);
  const active = insideMask(triangles, grid);
  const activeCount = active.reduce((sum, flag) => sum + flag, 0);
  if (activeCount === 0)
    return refuse('TOP_DOMAIN_INVALID', 'no voxel centre lies inside the design domain: use a smaller voxel', study.designDomain);
  const keepIn = regionMasks(doc, grid, active, study.keepIn);
  if ('error' in keepIn) return refuse('TOP_REGION_OUTSIDE_DOMAIN', `keep-in region ${keepIn.index}: ${keepIn.error}`, [study.id]);
  const keepOut = regionMasks(doc, grid, active, study.keepOut);
  if ('error' in keepOut) return refuse('TOP_REGION_OUTSIDE_DOMAIN', `keep-out region ${keepOut.index}: ${keepOut.error}`, [study.id]);

  const elastic = elasticOf(doc, study);
  if (typeof elastic === 'string') return refuse('TOP_SETUP_INVALID', elastic, study.designDomain);
  const { settings } = study;
  if (study.objective.kind === 'min_volume' && settings.optimizer !== 'mma')
    return refuse('TOP_OPTIMIZER_MISMATCH', 'the min_volume objective needs optimizer mma', [study.id]);
  const extruded = study.manufacturing.extrusion === undefined ? undefined : extrusionAxis(grid, study.manufacturing.extrusion.axis);
  if (extruded !== undefined && 'error' in extruded) return refuse('TOP_SETUP_INVALID', extruded.error, [study.id]);
  const extrusion = extruded?.axis;

  const unitSystem = analysisCase.unitSystem;
  const lengthFactor = toMetres(doc, 1) / analysisLengthMetres(unitSystem);
  const idealization = analysisCase.parts[study.designDomain[0] ?? ''];
  const thicknessDoc = idealization?.kind === 'plane_stress' ? idealization.thickness : grid.thickness;
  const thickness = study.dimension === 2 ? thicknessDoc * lengthFactor : 1;
  const voxelAnalysis = study.voxel * lengthFactor;
  const voxelVolume = study.dimension === 3 ? voxelAnalysis ** 3 : voxelAnalysis ** 2 * thickness;

  const sets = nodeSets(grid, active);
  const trianglesOf = (entityId: string): ReturnType<typeof entityToTriangles> | null => {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    return entity !== undefined && is3D(entity) ? entityToTriangles(entity, doc) : null;
  };
  const supportNodes: number[] = [];
  const fixed = new Set<number>();
  for (const id of analysisCase.constraintOrder) {
    const constraint = analysisCase.constraints[id];
    if (constraint === undefined) continue;
    const surface = study.designDomain.includes(constraint.target.entityId) ? trianglesOf(constraint.target.entityId) : null;
    if (surface === null) return refuse('TOP_TARGET_UNMAPPED', `constraint '${id}' is not on a design-domain entity`, [id]);
    const mapped = mapTarget(grid, sets, surface, constraint.target);
    if (isMappingFailure(mapped)) return refuse('TOP_TARGET_UNMAPPED', `constraint '${id}': ${mapped.error}`, [id]);
    const axes = constrainedAxes(grid, constraint, mapped);
    if (typeof axes === 'string') return refuse('TOP_SETUP_INVALID', `constraint '${id}': ${axes}`, [id]);
    supportNodes.push(...mapped.nodes);
    for (const node of mapped.nodes) for (const axis of axes) fixed.add(dofComponents(grid) * node + axis);
  }
  const byCase = new Map<string, { dofs: Map<number, number>; gravity: number[] | null }>();
  const loadNodes: number[] = [];
  let density: number | string | null = null;
  for (const id of analysisCase.loadOrder) {
    const load = analysisCase.loads[id];
    if (load === undefined) continue;
    const accumulated = byCase.get(load.loadCase) ?? { dofs: new Map<number, number>(), gravity: null };
    if (load.kind === 'gravity') {
      density ??= densityOf(doc, study, unitSystem);
      if (typeof density === 'string') return refuse('TOP_SETUP_INVALID', `gravity '${id}': ${density}`, [id]);
      const perVoxel = gravityPerVoxel(load, grid, density, voxelVolume);
      if (typeof perVoxel === 'string') return refuse('TOP_SETUP_INVALID', perVoxel, [id]);
      accumulated.gravity = (accumulated.gravity ?? perVoxel.map(() => 0)).map((value, component) => value + (perVoxel[component] ?? 0));
      byCase.set(load.loadCase, accumulated);
      continue;
    }
    if (load.kind === 'moment' || load.target === undefined)
      return refuse(
        'TOP_SETUP_INVALID',
        `load '${id}' (${load.kind}) is not supported: force and pressure loads on a target, and gravity, are`,
        [id],
      );
    const surface = trianglesOf(load.target.entityId);
    if (surface === null || !study.designDomain.includes(load.target.entityId))
      return refuse('TOP_LOAD_OUTSIDE_DOMAIN', `load '${id}' is not on a design-domain entity`, [id]);
    const mapped = mapTarget(grid, sets, surface, load.target);
    if (isMappingFailure(mapped)) return refuse('TOP_TARGET_UNMAPPED', `load '${id}': ${mapped.error}`, [id]);
    const forces = load.kind === 'force' ? forceLoad(load, grid, mapped) : pressureLoad(load, grid, mapped, lengthFactor ** 2);
    if (typeof forces === 'string') return refuse('TOP_SETUP_INVALID', forces, [id]);
    forces.dofs.forEach((dof, i) => accumulated.dofs.set(dof, (accumulated.dofs.get(dof) ?? 0) + (forces.values[i] ?? 0)));
    byCase.set(load.loadCase, accumulated);
    loadNodes.push(...mapped.nodes);
  }
  if (fixed.size === 0)
    return refuse('TOP_SETUP_INVALID', 'the analysis has no support that fixes a degree of freedom of the grid', [analysisCase.id]);
  if (byCase.size === 0) return refuse('TOP_SETUP_INVALID', 'the analysis has no force, pressure or gravity load', [analysisCase.id]);

  const protectedVoxels = settings.protectLoadSupport.value ? voxelsAroundNodes(grid, active, [...supportNodes, ...loadNodes], 1) : null;
  const keepInFinal = Uint8Array.from(
    keepIn.mask,
    (flag, voxel) => (flag | (protectedVoxels?.[voxel] ?? 0)) & ~(keepOut.mask[voxel] ?? 0) & 1,
  );
  const keepOutFinal = Uint8Array.from(keepOut.mask);
  const count = (mask: Uint8Array): number => mask.reduce((sum, flag) => sum + flag, 0);
  const weights = study.objective.loadCaseWeights;
  const loadCases = [...byCase.entries()].map(([name, { dofs, gravity }]): TopologyLoadCase => {
    const ordered = [...dofs.entries()].sort((a, b) => a[0] - b[0]);
    return {
      name,
      weight: Object.hasOwn(weights, name) ? (weights[name] ?? 1) : 1,
      dofs: ordered.map(([dof]) => dof),
      values: ordered.map(([, value]) => value),
      ...(gravity === null ? {} : { gravity }),
    };
  });
  const minMemberSize = study.manufacturing.minMemberSize;
  const radiusDoc = minMemberSize === undefined ? settings.filter.radius.value : Math.max(settings.filter.radius.value, minMemberSize / 2);
  const radiusVoxels = radiusDoc / study.voxel;
  const { projection } = settings;
  return {
    ok: true,
    job: {
      studyId: study.id,
      analysisId: analysisCase.id,
      unitSystem,
      dimension: study.dimension,
      grid: artifactGrid(grid, { active: activeCount, keepIn: count(keepInFinal), keepOut: count(keepOutFinal) }),
      active,
      keepIn: keepInFinal,
      keepOut: keepOutFinal,
      fixedDofs: [...fixed].sort((a, b) => a - b),
      loadCases,
      material: {
        youngsModulus: elastic.E * stressPerMpa(unitSystem),
        poisson: elastic.nu,
        source: elastic.source,
        unverifiedReasons: elastic.unverifiedReasons,
      },
      thickness,
      volumeFraction: study.volumeFraction,
      objective:
        study.objective.kind === 'min_volume'
          ? { kind: 'min_volume', maxCompliance: study.objective.maxCompliance }
          : { kind: 'min_compliance' },
      settings: {
        penal: settings.penal.value,
        eminRatio: settings.eminRatio.value,
        move: settings.move.value,
        changeTol: settings.changeTol.value,
        maxIterations: settings.maxIterations.value,
        filter: { kind: settings.filter.kind, radiusVoxels },
        threshold: settings.threshold.value,
        optimizer: settings.optimizer,
        ...(projection === undefined
          ? {}
          : {
              projection: {
                beta: projection.beta.value,
                eta: projection.eta.value,
                betaStart: projection.betaStart.value,
                betaEvery: projection.betaEvery.value,
              },
            }),
        ...(extrusion === undefined ? {} : { extrusion }),
        ...(minMemberSize === undefined
          ? {}
          : { minMemberRule: { minMemberSize, radiusVoxels, raised: minMemberSize / 2 > settings.filter.radius.value } }),
      },
      inputHash: topologyInputHash(doc, study),
      settingsHash: topologySettingsHash(settings),
    },
  };
}
