import { describe, expect, it } from 'vitest';
import type { Entity } from '@core/model/types';
import { createOcctKernel, type OcctFactory } from '@kernel-occt/occtKernel';

/** Fake OCC API: records every constructed handle and which of them were `delete()`d. */
function makeFakeApi(): { factory: OcctFactory; created: object[]; deleted: Set<object> } {
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
  const triangulation = {
    IsNull: (): boolean => false,
    get: () => ({
      NbNodes: (): number => 3,
      NbTriangles: (): number => 1,
      Node: (i: number) => handle({ X: (): number => i, Y: (): number => 0, Z: (): number => 0 }),
      Triangle: () => handle({ Value: (j: number): number => j }),
    }),
    delete: (): void => undefined,
  };
  let faceVisited = false;
  const api = {
    TopAbs_ShapeEnum: { TopAbs_FACE: 'face', TopAbs_SHAPE: 'shape' },
    gp_Pnt_3: function (): object {
      return handle({});
    },
    BRepPrimAPI_MakeBox_2: function (): object {
      return handle({ Shape: () => handle({ ShapeType: (): string => 'solid' }) });
    },
    BRepMesh_IncrementalMesh_2: function (): object {
      return handle({ Perform: (): void => undefined });
    },
    TopExp_Explorer_2: function (): object {
      faceVisited = false;
      return handle({
        More: (): boolean => !faceVisited,
        Current: () => handle({ ShapeType: (): string => 'face' }),
        Next: (): void => {
          faceVisited = true;
        },
      });
    },
    TopLoc_Location_1: function (): object {
      return handle({});
    },
    TopoDS: { Face_1: () => handle({ ShapeType: (): string => 'face' }) },
    BRep_Tool: {
      Triangulation: () => {
        const wrapped = handle(triangulation);
        return wrapped;
      },
    },
  };
  return { factory: () => Promise.resolve(api as never), created, deleted };
}

describe('occt kernel releases WASM handles', () => {
  it('deletes the nodes, triangles, faces and triangulations read while meshing', async () => {
    const fake = makeFakeApi();
    const kernel = await createOcctKernel({ factory: fake.factory });
    const box = {
      id: 'b',
      kind: 'box',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [1, 1, 1],
      layerId: 'layer-default',
      color: '#888888',
    } as unknown as Entity;

    const mesh = kernel.tessellate(box);

    expect(mesh?.positions).toEqual([1, 0, 0, 2, 0, 0, 3, 0, 0]);
    expect(mesh?.indices).toEqual([0, 1, 2]);
    const leaked = fake.created.filter((object) => !fake.deleted.has(object));
    expect(leaked).toHaveLength(0);
  });
});
