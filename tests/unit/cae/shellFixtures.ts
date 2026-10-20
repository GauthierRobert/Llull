/** Fixtures of the M6 shell tests: a plate document, a sheet-metal L part, a composite laminate and a fake exact kernel answering as a thin plate. */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { FaceDetail } from '@core/geometry/kernelPorts';
import type { CompositesModel } from '@core/model/composites';
import type { SheetMetalModel } from '@core/model/sheetMetal';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';

export const ctxWith = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });

export const must = (doc: CadDocument, command: string, params: Record<string, unknown>, ctx?: ExecutionContext): CadDocument => {
  const result = ctx === undefined ? execute(doc, command, params) : execute(doc, command, params, ctx);
  if (result.rejected === true) throw new Error(`${command}: ${result.summary}`);
  return result.document;
};

export interface Plate {
  readonly doc: CadDocument;
  readonly plateId: string;
  readonly analysisId: string;
}

/** Steel plate 100 x 50 x 2 (box, min corner at the origin: z in [0, 2]) in an analysis of `analysisType`, not yet a part. */
export function plateDocument(analysisType = 'static', size: Vec3 = [100, 50, 2]): Plate {
  let doc = createEmptyDocument();
  const box = execute(doc, 'add_box', { size, position: [0, 0, 0], anchor: 'min' });
  const plateId = box.affected[0] ?? '';
  doc = must(box.document, 'create_material', { name: 'steel', density: 0.00785 });
  doc = must(doc, 'add_material_model', {
    material: 'steel',
    id: 'elastic',
    model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
    basis: 'unspecified',
    source: { citation: 'test' },
  });
  doc = must(doc, 'define_constitutive_set', { material: 'steel', set: { id: 'linear', elastic: 'elastic' }, makeDefault: true });
  doc = must(doc, 'assign_material', { materialName: 'steel', entityIds: [plateId] });
  const created = execute(doc, 'create_analysis', { name: 'plate', analysisType });
  return { doc: created.document, plateId, analysisId: created.affected[0] ?? '' };
}

/** Sheet-metal L: flat f1 (10 x 20, z = 0 reference, material up, T 1) bent up 90 degrees (inside radius 2) into flat f2 (10 x 15). */
export function sheetMetal(sourceEntity: string, withForm = false): SheetMetalModel {
  return {
    rules: { r1: { name: 'r1', material: 'al', thickness: 1, insideRadius: 2, k: { standard: 'ansi', value: 0.44 } } },
    radiusTable: [],
    parts: {
      'sm-1': {
        id: 'sm-1',
        rule: 'r1',
        root: 'f1',
        side: 'up',
        sourceEntity,
        order: ['f1', 'b1', 'f2', ...(withForm ? ['fm'] : [])],
        nodes: {
          f1: {
            id: 'f1',
            type: 'flat',
            frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
            outline: [
              [0, 0],
              [0, -20],
              [10, -20],
              [10, 0],
            ],
            cutouts: [
              {
                points: [
                  [4, -12],
                  [6, -12],
                  [6, -10],
                  [4, -10],
                ],
              },
            ],
          },
          b1: {
            id: 'b1',
            type: 'bend',
            from: 'f1',
            to: 'f2',
            lineInFrom: [
              [0, 0],
              [10, 0],
            ],
            angle: Math.PI / 2,
            insideRadius: 2,
          },
          f2: {
            id: 'f2',
            type: 'flat',
            frame: { origin: [0, 3, 3], xDir: [1, 0, 0], normal: [0, -1, 0] },
            outline: [
              [0, 0],
              [10, 0],
              [10, 15],
              [0, 15],
            ],
            cutouts: [],
          },
          ...(withForm
            ? {
                fm: {
                  id: 'fm',
                  type: 'form' as const,
                  on: 'f1',
                  form: {
                    kind: 'bead' as const,
                    start: [2, -5] as const,
                    end: [8, -5] as const,
                    radius: 2,
                    depth: 1,
                    endShape: 'round' as const,
                    direction: 'up' as const,
                  },
                },
              }
            : {}),
        },
      },
    },
  };
}

/** Composite part 'cp-1' on `entityId`: [0 / 90] of a UD tape (0.125 thick), whole-face plies. */
export function composites(entityId: string, zoned = false, core = false): CompositesModel {
  const ply = (id: string, order: number, orientation: number): CompositesModel['plies'][string] => ({
    id,
    name: id,
    partId: 'cp-1',
    order,
    sequence: 'A',
    materialName: 'tape',
    orientation,
    rosetteId: 'ro-1',
    boundary: zoned && order === 1 ? { kind: 'polygons', polygons: [] } : { kind: 'whole_face' },
  });
  return {
    materials: {
      tape: {
        name: 'tape',
        form: core ? 'core_foam' : 'ud_tape',
        E1: 135000,
        E2: 10000,
        G12: 5000,
        G23: 3500,
        nu12: 0.3,
        plyThickness: 0.125,
        density: 0.0016,
        basis: 'mean',
        source: 'test datasheet',
      },
    },
    rosettes: { 'ro-1': { id: 'ro-1', name: 'ro', origin: [0, 0, 2], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'translational' } },
    parts: {
      'cp-1': {
        id: 'cp-1',
        name: 'skin',
        toolFaces: [{ entityId, faceNear: [50, 25, 2] }],
        laminateSide: 'positive_normal',
        rosetteId: 'ro-1',
        surface: { type: 'plane', origin: [0, 0, 2], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
        outline: [],
      },
    },
    zones: {},
    plies: { p1: ply('p1', 0, 0), p2: ply('p2', 1, 90) },
    plyOrder: ['p1', 'p2'],
    waivers: {},
  };
}

const face = (
  index: number,
  surface: FaceDetail['surface'],
  centroid: Vec3,
  area: number,
  normal?: Vec3,
  samples: Vec3[] = [],
): FaceDetail => ({ index, surface, area, centroid, ...(normal !== undefined ? { normal } : {}), samples });

/** Fake exact kernel answering for a 100 x 50 x 2 plate (faces 0 bottom, 1 top, 2..5 sides), optionally with an extra unpaired cylinder face. */
export function plateKernel(options: { readonly cylinder?: boolean; readonly noQuery?: boolean } = {}): GeometryKernel {
  const sides = [
    face(
      2,
      'plane',
      [0, 25, 1],
      100,
      [-1, 0, 0],
      [
        [0, 1, 0.5],
        [0, 49, 1.5],
      ],
    ),
    face(
      3,
      'plane',
      [100, 25, 1],
      100,
      [1, 0, 0],
      [
        [100, 1, 0.5],
        [100, 49, 1.5],
      ],
    ),
    face(
      4,
      'plane',
      [50, 0, 1],
      200,
      [0, -1, 0],
      [
        [1, 0, 0.5],
        [99, 0, 1.5],
      ],
    ),
    face(
      5,
      'plane',
      [50, 50, 1],
      200,
      [0, 1, 0],
      [
        [1, 50, 0.5],
        [99, 50, 1.5],
      ],
    ),
  ];
  const details = [
    face(
      0,
      'plane',
      [50, 25, 0],
      5000,
      [0, 0, -1],
      [
        [10, 10, 0],
        [90, 40, 0],
      ],
    ),
    face(
      1,
      'plane',
      [50, 25, 2],
      5000,
      [0, 0, 1],
      [
        [10, 10, 2],
        [90, 40, 2],
      ],
    ),
    ...sides,
    ...(options.cylinder === true ? [face(6, 'cylinder', [0, 0, 10], 4000)] : []),
  ];
  const square = (z: number): { positions: number[]; indices: number[]; uv: number[] } => ({
    positions: [0, 0, z, 100, 0, z, 100, 50, z, 0, 50, z],
    indices: [0, 1, 2, 0, 2, 3],
    uv: [],
  });
  return {
    evaluate: () => ({}) as never,
    exportStep: () => null,
    tessellate: () => null,
    ...(options.noQuery === true
      ? {}
      : {
          faceQuery: {
            faceDetails: () => details,
            faceContains: () => true,
            tessellateFace: (_shape: unknown, index: number) => (index === 0 ? square(0) : index === 1 ? square(2) : null),
            distance: (_shape: unknown, points: readonly Vec3[]) => points.map(() => ({ distance: 0, signed: 0, face: 0 })),
          },
        }),
  } as unknown as GeometryKernel;
}
