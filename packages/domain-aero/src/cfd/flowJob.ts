/**
 * The `llull-compute flow` job of a case (TECHNICAL_SPEC §6, M2 as built §13): `case.json` + a binary STL of the unioned flow surface
 * (metres, case frame), built from the prepare report. Pure: the host writes the folder and runs the sidecar. Contract: `llull_flow_lbm::job`.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { CfdCase, CfdQuality } from '@aero/cfd/types';
import { collectBodies } from './flowSurface';
import { toCaseFrame, type CaseFrame } from './frame';
import { prepareCaseWithStage, type CheckRow, type PrepareReport } from './prepare';
import type { SurfaceStage } from './surfaceStage';

export type FlowFaceKind = 'far_field' | 'slip' | 'ground' | 'moving_ground';
export type FlowDevice = 'cpu' | 'gpu' | 'auto';
type FlowSliceField = 'speed' | 'p' | 'ux' | 'uy' | 'uz';

/** Named defaults of the solver settings (TECHNICAL_SPEC §5.3; the job applies the same values). */
export const FLOW_DEFAULTS = {
  latticeMach: 0.1,
  les: true,
  smagorinsky: 0.1,
  maxSteps: 200_000,
  startAveragingTol: 0.005,
  stopTol: 0.001,
  historyCap: 1000,
  device: 'cpu' as FlowDevice,
} as const;

/** `case.json` (camelCase, the Rust `JobFile`). */
export interface FlowCaseJson {
  readonly version: 1;
  readonly caseId: string;
  readonly grid: { readonly cellM: number; readonly minM: Vec3; readonly maxM: Vec3 };
  readonly flow: { readonly speedMS: number; readonly direction: Vec3; readonly densityKgM3: number; readonly viscosityPaS: number };
  readonly reference: { readonly areaM2: number; readonly lengthM: number; readonly momentPointM: Vec3; readonly up: Vec3 };
  readonly faces: {
    readonly xMin: FlowFaceKind;
    readonly xMax: FlowFaceKind;
    readonly yMin: FlowFaceKind;
    readonly yMax: FlowFaceKind;
    readonly zMin: FlowFaceKind;
    readonly zMax: FlowFaceKind;
  };
  readonly bodies: readonly { readonly entityId: string; readonly triangles: readonly [number, number] }[];
  readonly surface: 'surface.stl';
  readonly settings: {
    readonly latticeMach: number;
    readonly les: boolean;
    readonly smagorinsky: number;
    readonly maxSteps: number;
    readonly startAveragingTol: number;
    readonly stopTol: number;
    readonly sampleEvery: number;
    readonly historyCap: number;
    readonly device: FlowDevice;
  };
  readonly outputs: {
    readonly probesM: readonly Vec3[];
    readonly slices: readonly { readonly originM: Vec3; readonly normal: Vec3; readonly field: FlowSliceField }[];
    readonly surfaceFields: readonly string[];
  };
}

export interface FlowJobOptions {
  readonly device?: FlowDevice | undefined;
  readonly maxSteps?: number | undefined;
  readonly latticeMach?: number | undefined;
  readonly les?: boolean | undefined;
  /** Checked against the memory estimate before anything runs (CFD_MEMORY_EXCEEDED). */
  readonly deviceMemoryBytes?: number | undefined;
  readonly quality?: CfdQuality | undefined;
}

export interface FlowJob {
  readonly caseJson: FlowCaseJson;
  /** Binary STL of the flow surface, metres, case frame, triangles grouped per body. */
  readonly stl: Uint8Array;
  readonly triangles: number;
  readonly caseHash: string;
  readonly geometryHash: string;
  /** Name of the kernel that built the surface (the geometry hash depends on it). */
  readonly kernel: string;
  readonly report: PrepareReport;
  /** Named defaults the job applies (AF-31). */
  readonly defaults: readonly { readonly path: string; readonly value: unknown; readonly source: string }[];
  readonly notes: readonly string[];
}

export type FlowJobBuild =
  | { readonly ok: true; readonly job: FlowJob }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly ids: readonly string[];
      readonly checks: readonly CheckRow[];
    };

const refuse = (code: string, message: string, ids: readonly string[], checks: readonly CheckRow[] = []): FlowJobBuild => ({
  ok: false,
  code,
  message,
  ids,
  checks,
});

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Unit free-stream direction in the case frame: α rotates about the lateral axis (nose up = flow from below), β > 0 adds a +y component. */
export function freestreamDirection(alphaDeg: number, betaDeg: number): Vec3 {
  const alpha = toRadians(alphaDeg);
  const beta = toRadians(betaDeg);
  return [Math.cos(alpha) * Math.cos(beta), Math.sin(beta), Math.sin(alpha) * Math.cos(beta)];
}

interface OwnerBox {
  readonly ownerId: string;
  readonly min: Vec3;
  readonly max: Vec3;
}

const AXES = [0, 1, 2] as const;

/** AABBs of the case bodies in the case frame (metres), in entity order, one per owner. */
function ownerBoxes(doc: CadDocument, cfdCase: CfdCase, frame: CaseFrame, metresPerUnit: number): OwnerBox[] {
  const { leaves } = collectBodies(doc, cfdCase);
  const boxes = new Map<string, { min: [number, number, number]; max: [number, number, number] }>();
  for (const leaf of leaves) {
    const { min, max } = entityBoundsInDoc(doc, leaf.entity);
    for (const corner of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const world: Vec3 = [
        ((corner & 1) === 0 ? min[0] : max[0]) * metresPerUnit,
        ((corner & 2) === 0 ? min[1] : max[1]) * metresPerUnit,
        ((corner & 4) === 0 ? min[2] : max[2]) * metresPerUnit,
      ];
      const local = toCaseFrame(frame, world);
      const box = boxes.get(leaf.ownerId) ?? { min: [local[0], local[1], local[2]], max: [local[0], local[1], local[2]] };
      for (const axis of AXES) {
        box.min[axis] = Math.min(box.min[axis], local[axis]);
        box.max[axis] = Math.max(box.max[axis], local[axis]);
      }
      boxes.set(leaf.ownerId, box);
    }
  }
  return [...boxes.entries()].map(([ownerId, box]) => ({ ownerId, min: box.min, max: box.max }));
}

/** Index of the smallest box containing `point` (with `slack`), else the nearest box. */
function ownerOf(point: Vec3, boxes: readonly OwnerBox[], slack: number): number {
  let best = -1;
  let bestVolume = Infinity;
  let nearest = 0;
  let nearestDistance = Infinity;
  boxes.forEach((box, index) => {
    const distance = AXES.reduce<number>((sum, axis) => {
      const outside = Math.max(box.min[axis] - point[axis], 0, point[axis] - box.max[axis]);
      return sum + outside * outside;
    }, 0);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
    if (distance <= slack * slack) {
      const volume = AXES.reduce<number>((v, axis) => v * (box.max[axis] - box.min[axis] + 1e-12), 1);
      if (volume < bestVolume) {
        bestVolume = volume;
        best = index;
      }
    }
  });
  return best >= 0 ? best : nearest;
}

/** Binary STL (84 + 50 n bytes) of the triangles `order` of an indexed surface; normals from the winding. */
function binaryStl(stage: SurfaceStage, order: readonly number[]): Uint8Array {
  const { vertices, triangles } = stage.surface;
  const bytes = new Uint8Array(84 + 50 * order.length);
  const view = new DataView(bytes.buffer);
  const header = 'llull flow surface (metres, case frame)';
  for (let i = 0; i < header.length && i < 80; i += 1) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, order.length, true);
  const vertex = (t: number, k: number): Vec3 => {
    const first = (triangles[t * 3 + k] ?? 0) * 3;
    return [vertices[first] ?? 0, vertices[first + 1] ?? 0, vertices[first + 2] ?? 0];
  };
  order.forEach((t, slot) => {
    const base = 84 + 50 * slot;
    const [a, b, c] = [vertex(t, 0), vertex(t, 1), vertex(t, 2)];
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const axis of AXES) view.setFloat32(base + 4 * axis, n[axis] / length, true);
    [a, b, c].forEach((corner, k) => {
      for (const axis of AXES) view.setFloat32(base + 12 + 12 * k + 4 * axis, corner[axis], true);
    });
    view.setUint16(base + 48, 0, true);
  });
  return bytes;
}

const SLICE_FIELDS: Readonly<Record<string, FlowSliceField>> = {
  speed: 'speed',
  velocity: 'speed',
  mach: 'speed',
  p: 'p',
  pressure: 'p',
  cp: 'p',
  ux: 'ux',
  uy: 'uy',
  uz: 'uz',
};

/**
 * Builds the job of `cfdCase`, or the first refusal.
 * @invariant the STL triangles are the welded, outward surface whose hash is `geometryHash`, reordered so each body's triangles are one range
 * @failure unknown / failing preparation rows -> their code (first fail row); a compressible case -> CFD_REGIME_MISMATCH (the Euler solver is
 *   not built); memory above `deviceMemoryBytes` -> CFD_MEMORY_EXCEEDED
 */
export function buildFlowJob(
  doc: CadDocument,
  cfdCase: CfdCase,
  kernel: GeometryKernel | null,
  options: FlowJobOptions = {},
): FlowJobBuild {
  const { report, stage } = prepareCaseWithStage(doc, cfdCase, kernel, {
    quality: options.quality,
    deviceMemoryBytes: options.deviceMemoryBytes,
  });
  const failing = report.checks.filter((check) => check.status === 'fail');
  const first = failing[0];
  if (first !== undefined)
    return refuse(
      first.code,
      `prepare_cfd_case fails for '${cfdCase.id}': ${failing.map((check) => `${check.code} (${check.message})`).join('; ')}`,
      [cfdCase.id],
      failing,
    );
  if (stage === null || report.flow === null || report.domain === null || report.geometryHash === null)
    return refuse('CFD_NO_GEOMETRY', `case '${cfdCase.id}' has no flow surface`, [cfdCase.id]);
  if (report.solver !== 'lbm')
    return refuse(
      'CFD_REGIME_MISMATCH',
      `case '${cfdCase.id}' is compressible (Mach ${report.flow.machNumber.toPrecision(4)}): the Euler solver is not built (M4); only Mach < 0.3 solves (lbm)`,
      [cfdCase.id],
    );

  const { frame, metresPerUnit } = stage;
  const boxes = ownerBoxes(doc, cfdCase, frame, metresPerUnit);
  const { vertices, triangles } = stage.surface;
  const count = triangles.length / 3;
  const slack = report.grid.targetCellM;
  const owners: number[] = [];
  for (let t = 0; t < count; t += 1) {
    const coordinate = (axis: number): number =>
      [0, 1, 2].reduce((sum, k) => sum + (vertices[(triangles[t * 3 + k] ?? 0) * 3 + axis] ?? 0), 0) / 3;
    const centroid: Vec3 = [coordinate(0), coordinate(1), coordinate(2)];
    owners.push(boxes.length === 0 ? 0 : ownerOf(centroid, boxes, slack));
  }
  const order = [...Array(count).keys()].sort((a, b) => (owners[a] ?? 0) - (owners[b] ?? 0) || a - b);
  const bodies = boxes.map((box, index) => {
    const start = order.findIndex((t) => owners[t] === index);
    const size = owners.filter((owner) => owner === index).length;
    return { entityId: box.ownerId, triangles: [Math.max(start, 0), size] as const };
  });

  const direction = freestreamDirection(cfdCase.freestream.alphaDeg, cfdCase.freestream.betaDeg);
  const halved = cfdCase.domain.symmetryPlane === 'xz';
  const { box } = report.domain;
  const minM: Vec3 = [box.min[0], halved ? Math.max(box.min[1], 0) : box.min[1], box.min[2]];
  const ground: FlowFaceKind = cfdCase.ground.moving ? 'moving_ground' : 'ground';
  const notes: string[] = [];
  const slices = cfdCase.outputs.slices.flatMap((slice) => {
    const field = SLICE_FIELDS[slice.field.toLowerCase()];
    if (field === undefined) {
      notes.push(`slice field '${slice.field}' is not a flow field (speed, p, ux, uy, uz): skipped`);
      return [];
    }
    return [{ originM: toCaseFrame(frame, slice.origin), normal: toCaseFrame(frame, slice.normal), field }];
  });
  const defaults = [
    ...(options.latticeMach === undefined
      ? [
          {
            path: 'settings.latticeMach',
            value: FLOW_DEFAULTS.latticeMach,
            source: 'TECHNICAL_SPEC §5.3 (inflow lattice Mach sets the time step)',
          },
        ]
      : []),
    ...(options.les === undefined
      ? [{ path: 'settings.les', value: true, source: 'TECHNICAL_SPEC §5.3 (BGK + Smagorinsky C_s 0.1)' }]
      : []),
    ...(options.maxSteps === undefined ? [{ path: 'settings.maxSteps', value: FLOW_DEFAULTS.maxSteps, source: 'llull default' }] : []),
    {
      path: 'settings.startAveragingTol',
      value: FLOW_DEFAULTS.startAveragingTol,
      source: 'TECHNICAL_SPEC §5.3 (0.5 % over one flow-through)',
    },
    { path: 'settings.stopTol', value: FLOW_DEFAULTS.stopTol, source: 'TECHNICAL_SPEC §5.3 (0.1 % over two flow-throughs)' },
    { path: 'flow.direction', value: direction, source: 'alpha about the lateral axis, beta > 0 adds +y (case frame)' },
    ...(cfdCase.outputs.surfaceFields.length === 0 ? [{ path: 'outputs.surfaceFields', value: ['p', 'cp'], source: 'llull default' }] : []),
  ];
  const caseJson: FlowCaseJson = {
    version: 1,
    caseId: cfdCase.id,
    grid: { cellM: report.grid.targetCellM, minM, maxM: box.max },
    flow: { speedMS: report.flow.speedMS, direction, densityKgM3: report.flow.densityKgM3, viscosityPaS: report.flow.viscosityPaS },
    reference: {
      areaM2: cfdCase.reference.areaM2,
      lengthM: cfdCase.reference.lengthM,
      momentPointM: toCaseFrame(frame, cfdCase.reference.momentPointM),
      up: [0, 0, 1],
    },
    faces: {
      xMin: 'far_field',
      xMax: 'far_field',
      yMin: halved ? 'slip' : 'far_field',
      yMax: 'far_field',
      zMin: cfdCase.ground.enabled ? ground : 'far_field',
      zMax: 'far_field',
    },
    bodies,
    surface: 'surface.stl',
    settings: {
      latticeMach: options.latticeMach ?? FLOW_DEFAULTS.latticeMach,
      les: options.les ?? FLOW_DEFAULTS.les,
      smagorinsky: FLOW_DEFAULTS.smagorinsky,
      maxSteps: options.maxSteps ?? FLOW_DEFAULTS.maxSteps,
      startAveragingTol: FLOW_DEFAULTS.startAveragingTol,
      stopTol: FLOW_DEFAULTS.stopTol,
      sampleEvery: 0,
      historyCap: FLOW_DEFAULTS.historyCap,
      device: options.device ?? FLOW_DEFAULTS.device,
    },
    outputs: {
      probesM: cfdCase.outputs.probes.map((point) => toCaseFrame(frame, point)),
      slices,
      surfaceFields:
        cfdCase.outputs.surfaceFields.length === 0 ? ['p', 'cp'] : cfdCase.outputs.surfaceFields.map((name) => name.toLowerCase()),
    },
  };
  return {
    ok: true,
    job: {
      caseJson,
      stl: binaryStl(stage, order),
      triangles: count,
      caseHash: report.caseHash,
      geometryHash: report.geometryHash,
      kernel: kernel?.name ?? 'none',
      report,
      defaults,
      notes,
    },
  };
}
