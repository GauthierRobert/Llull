/** cfd_prepare engine (TECHNICAL_SPEC §5.1): turns a case into a pass / warn / fail report before anything is solved. Pure; the kernel is injected. */

import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { CfdCase, CfdQuality, CfdSolver } from '@core/model/cfd';
import { caseHashOf } from './caseDoc';
import type { DefaultNote } from './caseParams';
import { CFD_REMEDIATION } from './codes';
import { blockageRatio, boxContains, MAX_BLOCKAGE, sizeDomain, type DomainSizing } from './domainSizing';
import { collectBodies, leafBounds } from './flowSurface';
import { scale3, add3 } from '@lib/vec3';
import { CELLS_PER_REFERENCE_LENGTH, estimateCase, type Estimate } from './memoryEstimate';
import { resolveFlow, type FlowState } from './regime';
import { findSmallFeatures, type SmallFeature } from './smallFeatures';
import { prepareSurface, type SurfaceStage } from './surfaceStage';
import { isMirrorSymmetric } from './symmetry';
import { frontalArea, voxelise, type VoxelReport } from './voxel';
import { MAX_REPORTED_POINTS } from './topology';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_run';
export type CheckRow = {
  readonly code: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly remediation?: string;
} & Record<string, unknown>;

export interface PrepareOptions {
  /** Overrides the case quality (and its cellsPerReferenceLength). */
  readonly quality?: CfdQuality | undefined;
  /** Device memory in bytes the estimate is checked against; absent = the memory check is not run. */
  readonly deviceMemoryBytes?: number | undefined;
}

export interface PrepareReport {
  readonly caseId: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly solver: CfdSolver | null;
  readonly flow: FlowState | null;
  readonly checks: CheckRow[];
  readonly surface: Record<string, unknown> | null;
  readonly smallFeatures: SmallFeature[];
  readonly domain: (Omit<DomainSizing, 'defaults'> & { readonly frame: Record<string, Vec3> }) | null;
  readonly frontalAreaM2: number | null;
  readonly blockageRatio: number | null;
  readonly grid: { readonly cellsPerReferenceLength: number; readonly targetCellM: number };
  readonly estimate: Estimate | null;
  readonly geometryHash: string | null;
  readonly caseHash: string;
  readonly defaults: DefaultNote[];
  readonly warnings: string[];
  readonly notes: string[];
}

const row = (code: string, status: CheckStatus, message: string, extra: Record<string, unknown> = {}): CheckRow => ({
  code,
  status,
  message,
  ...((status === 'fail' || status === 'warn') && { remediation: CFD_REMEDIATION[code] ?? '' }),
  ...extra,
});

const gigabytes = (bytes: number): string => `${(bytes / 1e9).toPrecision(3)} GB`;

function surfaceRows(stage: SurfaceStage): CheckRow[] {
  const { edges, closed, built, intersections } = stage;
  const defect = edges.openEdges + edges.nonManifoldEdges + edges.misorientedEdges;
  const kernelBlocked = built.method === 'display_triangles' && built.overlaps.length > 0;
  return [
    kernelBlocked
      ? row('CFD_KERNEL_REQUIRED', 'fail', `${built.overlaps.length} pair(s) of bodies overlap or touch and no kernel union is available`, {
          pairs: built.overlaps.map(([a, b]) => [a, b]),
        })
      : row('CFD_KERNEL_REQUIRED', 'pass', `bodies unioned by: ${built.method}`),
    closed
      ? row('CFD_GEOMETRY_NOT_WATERTIGHT', 'pass', 'every edge is shared by exactly two triangles with opposite orientation', {
          openEdges: 0,
          nonManifoldEdges: 0,
          misorientedEdges: 0,
        })
      : row(
          'CFD_GEOMETRY_NOT_WATERTIGHT',
          'fail',
          `${edges.openEdges} open edge(s), ${edges.nonManifoldEdges} non-manifold edge(s), ${edges.misorientedEdges} inconsistently oriented edge(s)` +
            (defect === 0 ? ' (the surface has no triangle)' : ''),
          {
            openEdges: edges.openEdges,
            nonManifoldEdges: edges.nonManifoldEdges,
            misorientedEdges: edges.misorientedEdges,
            openAt: edges.openAt,
            nonManifoldAt: edges.nonManifoldAt,
            misorientedAt: edges.misorientedAt,
          },
        ),
    intersections === null
      ? row(
          'CFD_GEOMETRY_SELF_INTERSECTING',
          'not_run',
          kernelBlocked ? 'skipped: overlapping bodies need a kernel union first' : 'skipped: too many triangles',
        )
      : intersections.pairs === 0
        ? row('CFD_GEOMETRY_SELF_INTERSECTING', 'pass', 'no intersecting triangle pair (coplanar overlaps are not detected)', { pairs: 0 })
        : row('CFD_GEOMETRY_SELF_INTERSECTING', 'fail', `${intersections.pairs} intersecting triangle pair(s)`, {
            pairs: intersections.pairs,
            examples: intersections.examples.slice(0, MAX_REPORTED_POINTS),
          }),
  ];
}

/** Maps a position (case frame, metres) back to the case entity whose bounds contain it, smallest box first. */
function attributor(doc: CadDocument, stage: SurfaceStage, cfdCase: CfdCase, margin: number): (point: Vec3) => string | null {
  const { leaves } = collectBodies(doc, cfdCase);
  const boxes = leafBounds(doc, leaves);
  const { frame, metresPerUnit } = stage;
  return (point) => {
    const world = scale3(add3(add3(scale3(frame.x, point[0]), scale3(frame.y, point[1])), scale3(frame.z, point[2])), 1 / metresPerUnit);
    const slack = margin / metresPerUnit;
    const hits = boxes
      .filter(({ min, max }) =>
        [0, 1, 2].every((axis) => (world[axis] ?? 0) >= (min[axis] ?? 0) - slack && (world[axis] ?? 0) <= (max[axis] ?? 0) + slack),
      )
      .map((box) => ({ box, volume: [0, 1, 2].reduce((v, axis) => v * ((box.max[axis] ?? 0) - (box.min[axis] ?? 0) + 1e-12), 1) }))
      .sort((a, b) => a.volume - b.volume);
    return hits[0]?.box.ownerId ?? null;
  };
}

function voxelStats(stage: SurfaceStage, h: number): { voxel: VoxelReport | null; relativeError: number | null; bound: number | null } {
  if (!stage.closed || !(stage.volumeM3 > 0)) return { voxel: null, relativeError: null, bound: null };
  const voxel = voxelise(stage.surface, stage.bounds.min, stage.bounds.max, h);
  if (voxel === null) return { voxel: null, relativeError: null, bound: null };
  return {
    voxel,
    relativeError: Math.abs(voxel.volumeM3 - stage.volumeM3) / stage.volumeM3,
    bound: (stage.areaM2 * (Math.sqrt(3) / 2) * h) / stage.volumeM3,
  };
}

function emptyReport(cfdCase: CfdCase, checks: CheckRow[], flow: FlowState | null, warnings: string[]): PrepareReport {
  const n = cfdCase.cellsPerReferenceLength ?? CELLS_PER_REFERENCE_LENGTH[cfdCase.quality];
  return {
    caseId: cfdCase.id,
    status: 'fail',
    solver: flow?.solver ?? null,
    flow,
    checks,
    surface: null,
    smallFeatures: [],
    domain: null,
    frontalAreaM2: null,
    blockageRatio: null,
    grid: { cellsPerReferenceLength: n, targetCellM: cfdCase.reference.lengthM / n },
    estimate: null,
    geometryHash: null,
    caseHash: caseHashOf(cfdCase),
    defaults: [],
    warnings,
    notes: [],
  };
}

/**
 * The §5.1 report of one case. Never throws, never changes the document.
 * @invariant deterministic for a given document, case, kernel and options; `geometryHash` is that of the oriented welded surface
 * @failure no 3D solid -> a fail row CFD_NO_GEOMETRY and no surface; every other defect is a row, not a refusal
 */
export function prepareCase(
  doc: CadDocument,
  cfdCase: CfdCase,
  kernel: GeometryKernel | null,
  options: PrepareOptions = {},
): PrepareReport {
  const resolved = resolveFlow(cfdCase);
  const flow = resolved.ok ? resolved.state : null;
  const checks: CheckRow[] = [
    resolved.ok
      ? row(
          'CFD_REGIME_MISMATCH',
          'pass',
          `Mach ${resolved.state.machNumber.toPrecision(4)} -> ${resolved.state.regime}, solver ${resolved.state.solver}`,
        )
      : row(resolved.code, 'fail', resolved.message),
  ];
  const { leaves, skipped2D } = collectBodies(doc, cfdCase);
  const warnings = skipped2D.length > 0 ? [`2D entities skipped: ${skipped2D.join(', ')}`] : [];
  if (leaves.length === 0) {
    checks.push(row('CFD_NO_GEOMETRY', 'fail', 'the case has no 3D solid after the exclusions'));
    return emptyReport(cfdCase, checks, flow, warnings);
  }
  checks.push(row('CFD_NO_GEOMETRY', 'pass', `${leaves.length} solid(s) in the flow body`));
  const stage = prepareSurface(doc, cfdCase, leaves, kernel);
  if (stage.surface.triangles.length === 0) {
    checks.push(row('CFD_GEOMETRY_NOT_WATERTIGHT', 'fail', 'the bodies have no usable triangle'));
    return emptyReport(cfdCase, checks, flow, warnings);
  }
  checks.push(...surfaceRows(stage));
  if (stage.flipped) warnings.push('the surface was inward oriented (negative signed volume): winding reversed');
  if (stage.degenerate > 0) warnings.push(`${stage.degenerate} degenerate triangle(s) dropped`);

  const defaults: DefaultNote[] = [
    { path: 'weld.toleranceBodyLengths', value: 1e-6, source: 'TECHNICAL_SPEC §5.1 step 3' },
    { path: 'smallFeature.cells', value: 2, source: 'TECHNICAL_SPEC §5.1 step 7 (features below 2 cells vanish on the grid)' },
  ];
  const quality = options.quality;
  const n =
    quality !== undefined
      ? CELLS_PER_REFERENCE_LENGTH[quality]
      : (cfdCase.cellsPerReferenceLength ?? CELLS_PER_REFERENCE_LENGTH[cfdCase.quality]);
  if (quality !== undefined || cfdCase.cellsPerReferenceLength === undefined)
    defaults.push({
      path: 'grid.cellsPerReferenceLength',
      value: n,
      source: 'quality draft / standard / fine = 64 / 128 / 256 (TECHNICAL_SPEC §5.1 step 6)',
    });
  const h = cfdCase.reference.lengthM / n;

  const features = stage.closed ? findSmallFeatures(stage.surface, h, attributor(doc, stage, cfdCase, h)) : null;
  checks.push(
    features === null
      ? row('CFD_SMALL_FEATURE', 'not_run', 'skipped: the surface is not watertight')
      : features.total === 0
        ? row('CFD_SMALL_FEATURE', 'pass', `no feature below 2 cells (h = ${h.toPrecision(4)} m)`, { count: 0 })
        : row(
            'CFD_SMALL_FEATURE',
            'warn',
            `${features.total} feature(s) below 2 cells (h = ${h.toPrecision(4)} m); smallest ${features.features[0]?.sizeM.toPrecision(3)} m`,
            { count: features.total },
          ),
  );

  const mach = flow?.machNumber ?? 0;
  const sizing = sizeDomain(cfdCase, stage.bounds, mach);
  defaults.push(...sizing.defaults);
  const halved = cfdCase.domain.symmetryPlane === 'xz';
  if (halved && !isMirrorSymmetric(stage.surface, 1e-4 * stage.lengthM))
    checks.push(
      row('CFD_PARAM_INVALID', 'fail', 'domain.symmetryPlane xz is set but the body is not mirror-symmetric about y = 0 within 1e-4 L'),
    );
  if (cfdCase.domain.rule === 'custom' && !boxContains(sizing.box, stage.bounds))
    checks.push(
      row('CFD_PARAM_INVALID', 'fail', 'the custom domain box does not contain the body', { box: sizing.box, body: stage.bounds }),
    );

  const frontal = stage.closed ? frontalArea(stage.surface, stage.bounds.min, stage.bounds.max) : null;
  const blockage = frontal === null ? null : blockageRatio(frontal, sizing.box, halved);
  checks.push(
    blockage === null
      ? row('CFD_BLOCKAGE_TOO_HIGH', 'not_run', 'skipped: the surface is not watertight')
      : blockage > MAX_BLOCKAGE
        ? row('CFD_BLOCKAGE_TOO_HIGH', 'fail', `blockage ${(blockage * 100).toFixed(2)} % exceeds ${MAX_BLOCKAGE * 100} %`, {
            blockageRatio: blockage,
            limit: MAX_BLOCKAGE,
          })
        : row('CFD_BLOCKAGE_TOO_HIGH', 'pass', `blockage ${(blockage * 100).toFixed(3)} % <= ${MAX_BLOCKAGE * 100} %`, {
            blockageRatio: blockage,
            limit: MAX_BLOCKAGE,
          }),
  );

  const solver = flow?.solver ?? null;
  const estimate =
    solver === null
      ? null
      : estimateCase({
          solver,
          cellsPerReferenceLength: n,
          referenceLengthM: cfdCase.reference.lengthM,
          domain: sizing.box,
          body: stage.bounds,
          surfaceAreaM2: halved ? stage.areaM2 / 2 : stage.areaM2,
          deviceMemoryBytes: options.deviceMemoryBytes,
        });
  checks.push(memoryRow(estimate));

  const { voxel, relativeError, bound } = voxelStats(stage, h);
  const { min, max } = stage.bounds;
  const domainView: PrepareReport['domain'] = {
    box: sizing.box,
    rule: sizing.rule,
    lengthScaleM: sizing.lengthScaleM,
    basis: sizing.basis,
    frame: { x: stage.frame.x, y: stage.frame.y, z: stage.frame.z },
  };
  const status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return {
    caseId: cfdCase.id,
    status,
    solver,
    flow,
    checks,
    surface: {
      method: stage.built.method,
      bodies: leaves.length,
      vertices: stage.surface.vertices.length / 3,
      triangles: stage.surface.triangles.length / 3,
      degenerateDropped: stage.degenerate,
      closed: stage.closed,
      flipped: stage.flipped,
      areaM2: stage.areaM2,
      volumeM3: stage.volumeM3,
      bounds: { min, max },
      extentsM: [0, 1, 2].map((axis) => (max[axis] ?? 0) - (min[axis] ?? 0)),
      lengthM: stage.lengthM,
      voxelCellM: voxel?.cellSizeM ?? null,
      voxelCells: voxel?.cells ?? null,
      voxelVolumeM3: voxel?.volumeM3 ?? null,
      voxelVolumeRelativeError: relativeError,
      voxelVolumeBoundRelative: bound,
    },
    smallFeatures: features?.features ?? [],
    domain: domainView,
    frontalAreaM2: frontal,
    blockageRatio: blockage,
    grid: { cellsPerReferenceLength: n, targetCellM: h },
    estimate,
    geometryHash: stage.geometryHash,
    caseHash: caseHashOf(cfdCase),
    defaults,
    warnings: [...warnings, ...stage.built.notes],
    notes: [
      'the domain is sized in the alpha = beta = 0 frame (x along flowAxis, z along upAxis); angles of attack rotate the free stream inside it',
      'small-feature, thin-wall and gap tests use the display tessellation; coplanar triangle overlaps are not detected',
    ],
  };
}

function memoryRow(estimate: Estimate | null): CheckRow {
  if (estimate === null) return row('CFD_MEMORY_EXCEEDED', 'not_run', 'skipped: no solver (regime error)');
  const need = `${estimate.cells.toExponential(3)} cells, ${gigabytes(estimate.bytes)}`;
  if (estimate.fitsDevice === null)
    return row('CFD_MEMORY_EXCEEDED', 'not_run', `${need}; no deviceMemoryBytes given to compare with`, { bytes: estimate.bytes });
  return estimate.fitsDevice
    ? row('CFD_MEMORY_EXCEEDED', 'pass', `${need} fit the device`, { bytes: estimate.bytes })
    : row(
        'CFD_MEMORY_EXCEEDED',
        'fail',
        `${need} exceed the device budget; the largest fitting resolution is ${estimate.largestFittingCellsPerReferenceLength} cells per reference length`,
        { bytes: estimate.bytes, largestFittingCellsPerReferenceLength: estimate.largestFittingCellsPerReferenceLength },
      );
}
