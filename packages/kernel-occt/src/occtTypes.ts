/**
 * @layer kernel
 * Minimal typings for the subset of the OCC WASM API the kernel uses, plus the two handle helpers.
 */

/** Minimal typings for the subset of the OCC WASM API this kernel uses. */
export interface OccHandle {
  delete(): void;
}

export interface OccShape extends OccHandle {
  ShapeType(): unknown;
  Orientation_1(): { value: number };
}

export interface OccTriangulation extends OccHandle {
  IsNull(): boolean;
  get(): {
    NbTriangles(): number;
    NbNodes(): number;
    Node(i: number): OccHandle & {
      X(): number;
      Y(): number;
      Z(): number;
      Transform(placement: OccHandle): void;
    };
    Triangle(i: number): OccHandle & { Value(j: number): number };
  };
}

export interface OccExplorer extends OccHandle {
  More(): boolean;
  Current(): OccShape;
  Next(): void;
}

export interface OccTopoDS {
  Face_1(shape: OccShape): OccShape;
  Edge_1(shape: OccShape): OccShape;
  Shell_1(shape: OccShape): OccShape;
}

/** Boolean operation or fillet builder: `Build` then `Shape`. */
export interface OccBuilder extends OccHandle {
  Build(): void;
  IsDone(): boolean;
  Shape(): OccShape;
}

export interface OccOffsetMaker extends OccHandle {
  PerformByJoin(...args: readonly unknown[]): void;
  IsDone(): boolean;
  Shape(): OccShape;
}

export interface OccFilletMaker extends OccBuilder {
  Add_2(radius: number, edge: OccShape): void;
}

export interface OccMakePolygon extends OccHandle {
  Add_1(pt: OccHandle): void;
  Close(): void;
  IsDone(): boolean;
  Wire(): OccShape;
}

export interface OccMakeFace extends OccHandle {
  IsDone(): boolean;
  Face(): OccShape;
}

export interface OccSewing extends OccHandle {
  Add(shape: OccShape): void;
  Perform(progress: unknown): void;
  SewedShape(): OccShape;
}

export interface OccMakeSolid extends OccBuilder {
  Add(shell: OccShape): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OccApi = any; // The WASM binding is extremely wide; all narrowing is done above.

export function explorer(api: OccApi, shape: OccShape, kind: string): OccExplorer {
  return new api.TopExp_Explorer_2(
    shape,
    api.TopAbs_ShapeEnum[kind],
    api.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ) as OccExplorer;
}

/** Free a WASM heap object; OCC may already have released it, so failures are ignored. */
export function release(handle: OccHandle | null): void {
  try {
    handle?.delete();
  } catch {
    /* already released */
  }
}
