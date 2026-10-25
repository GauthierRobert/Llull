import type { FaceSlabRecipe } from './faceSlab';
import type { Vec3 } from './vectors';

/**
 * The MakePipeShell attempt a `sheetSolid` node may carry (capability `pipeShell`): the spine (`encodeChain`) and the section (a `circle` or an oriented
 * `chain`) as for a pipe, the trihedron `mode` (0 minimal, 1 Frenet, 2 fixed, 3 binormal), the section `direction` of `fixed` / `binormal`, a homothetic
 * scale `law` (flat fraction, scale pairs), the corner `transition`, the pipe `tolerance`, and `probes` (xyz points the result must lie on within `check`).
 */
export interface SheetPipeShell {
  readonly spine: readonly number[];
  readonly circle?: { readonly center: Vec3; readonly normal: Vec3; readonly radius: number };
  readonly chain?: readonly number[];
  readonly mode: number;
  readonly direction: Vec3;
  readonly law?: readonly number[];
  readonly transition: number;
  readonly tolerance: number;
  readonly probes: readonly number[];
  readonly check: number;
}

/**
 * The `sheetSolid` node of a `ShapeRecipe` (02 SWG, TECHNICAL_SPEC 5.5 / 16): the exact solid of a sweep or loft that the pipe operation cannot build (laws,
 * frame modes, rails, end conditions, closed lofts). `faces` are fitted clamped B-spline surfaces (`encodeSurface` layout), sewn at `tolerance` into the
 * lateral shell and closed by planar caps: `caps` 2 = both section ends, 1 = a loft closed to a point at one end, 0 = a sweep or loft round a closed path.
 * `bore` (a hollow round section) holds the inner faces of the same layout, cut out of the capped solid. `pipeShell` is a faster exact builder used only
 * when it reproduces the volume of the fitted solid. The result is placed by `rotation` (Rx·Ry·Rz, radians) then `position`, and its faces are named
 * `<name>:<role>` (persistent names of the entity it stands for). Only an exact kernel with the capability `sheetSolid` builds it; faces are entity-local.
 */
export interface SheetSolidRecipe {
  readonly op: 'sheetSolid';
  readonly faces: readonly (readonly number[])[];
  readonly bore?: readonly (readonly number[])[];
  readonly tolerance: number;
  readonly caps: 0 | 1 | 2;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly name?: string;
  readonly pipeShell?: SheetPipeShell;
}

/** The recipe nodes that hold their exact geometry themselves (no `source`) and that only an exact kernel builds: `faceSlab` and `sheetSolid`. */
export type ExactLeafRecipe = FaceSlabRecipe | SheetSolidRecipe;
