import { describe, expect, it, vi } from 'vitest';
import type { Entity } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { OcctFactory } from '@kernel-occt/occtKernel';

interface Fake {
  readonly kernel: GeometryKernel;
  readonly leaked: () => number;
}

/** Fake OCC API: every handle it hands out is tracked; `leaked()` counts the ones never deleted. */
async function makeFakeKernel(): Promise<Fake> {
  vi.resetModules(); // the real module caches the first API it loads
  const { createOcctKernel } = await import('@kernel-occt/occtKernel');
  const created: object[] = [];
  const deleted = new Set<object>();
  const handle = <T extends object>(fields: T): T & { delete(): void } => {
    const object = {
      ...fields,
      delete(): void {
        deleted.add(object);
      },
    };
    created.push(object);
    return object;
  };
  const construct = (fields: object = {}) =>
    function (): object {
      return handle(fields);
    };
  const oneShotExplorer = function (): object {
    let visited = false;
    return handle({
      More: (): boolean => !visited,
      Current: () => handle({}),
      Next: (): void => {
        visited = true;
      },
    });
  };
  const triangulation = {
    IsNull: (): boolean => false,
    get: () => ({
      NbNodes: (): number => 3,
      NbTriangles: (): number => 1,
      Node: (i: number) =>
        handle({
          X: (): number => i,
          Y: (): number => 0,
          Z: (): number => 0,
          Transform: (): void => undefined,
        }),
      Triangle: () => handle({ Value: (j: number): number => j }),
    }),
    delete: (): void => undefined,
  };
  const builder = (extra: object = {}) =>
    function (): object {
      return handle({
        Build: (): void => undefined,
        IsDone: (): boolean => true,
        Shape: () => handle({}),
        Add_2: (): void => undefined,
        ...extra,
      });
    };
  const api = {
    TopAbs_ShapeEnum: { TopAbs_FACE: 'face', TopAbs_SHAPE: 'shape' },
    TopAbs_Orientation: { TopAbs_REVERSED: { value: 1 } },
    ChFi3d_FilletShape: { ChFi3d_Rational: 0 },
    gp_Pnt_3: construct(),
    BRepPrimAPI_MakeBox_2: construct({ Shape: () => handle({}) }),
    BRepMesh_IncrementalMesh_2: construct({ Perform: (): void => undefined }),
    TopExp_Explorer_2: oneShotExplorer,
    TopLoc_Location_1: construct({ Transformation: () => handle({}) }),
    TopoDS: {
      Face_1: () => handle({ Orientation_1: () => ({ value: 0 }) }),
      Shell_1: () => handle({}),
      Edge_1: () => handle({}),
    },
    BRep_Tool: { Triangulation: () => handle(triangulation) },
    BRepBuilderAPI_MakePolygon_1: construct({
      Add_1: (): void => undefined,
      Close: (): void => undefined,
      IsDone: (): boolean => true,
      Wire: () => handle({}),
    }),
    BRepBuilderAPI_MakeFace_15: construct({ IsDone: (): boolean => true, Face: () => handle({}) }),
    BRepBuilderAPI_Sewing: construct({
      Add: (): void => undefined,
      Perform: (): void => undefined,
      SewedShape: () => handle({}),
    }),
    Handle_Message_ProgressIndicator_1: construct(),
    BRepBuilderAPI_MakeSolid_1: builder({ Add: (): void => undefined }),
    BRepFilletAPI_MakeFillet: builder(),
  };
  const factory: OcctFactory = () => Promise.resolve(api as never);
  const kernel = await createOcctKernel({ factory });
  return { kernel, leaked: () => created.filter((object) => !deleted.has(object)).length };
}

describe('occt kernel releases WASM handles', () => {
  it('deletes the nodes, triangles, faces and triangulations read while meshing', async () => {
    const fake = await makeFakeKernel();
    const box = {
      id: 'b',
      kind: 'box',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [1, 1, 1],
      layerId: 'layer-default',
      color: '#888888',
    } as unknown as Entity;

    const mesh = fake.kernel.tessellate(box);

    expect(mesh?.positions).toEqual([1, 0, 0, 2, 0, 0, 3, 0, 0]);
    expect(mesh?.indices).toEqual([0, 1, 2]);
    expect(fake.leaked()).toBe(0);
  });

  it('deletes the faces, wires, shells, edges and result shapes of a fillet', async () => {
    const fake = await makeFakeKernel();
    const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };

    const mesh = fake.kernel.filletEdges(triangle, [], 0.1);

    expect(mesh?.indices).toEqual([0, 1, 2]);
    expect(fake.leaked()).toBe(0);
  });
});
