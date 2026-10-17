/**
 * STEP -> exact healed B-rep solids (`GeometryKernel.importShapes`, aerospace 01 TR-KRN-20..24, MVP on opencascade.js 1.1.1 / OCCT 7.4.0p1).
 * Bindings used (checked against this build): STEPControl_Reader_1 (ReadFile, NbRootsForTransfer, TransferRoots, OneShape), ShapeFix_Shape_2
 * (SetPrecision / SetMaxTolerance / SetMinTolerance, Perform, Status), BRepBuilderAPI_Sewing, ShapeFix_Solid_1.SolidFromShell, BRepCheck_Analyzer,
 * BRep_Tool.Tolerance_1/2/3 + IsClosed_1, ShapeAnalysis_FreeBounds_2, BRepTools.Write_2 / FS.
 * @invariant the scratch path is short and fixed (see occtStep.ts); the reader runs with the build defaults (millimetres, precision from the file):
 *   this build does not register the `read.*` statics, so `options.precision` drives healing and sewing only
 * @invariant the BRepTools text of a healed solid is the blob payload: same file + options -> same text
 * @failure unreadable / empty transfer -> { error: 'unreadable' }, TESSELLATED_* only -> 'tessellated_only', no solid after sewing -> 'no_solid'
 */

import type { ImportedSolid, ImportShapesOptions, ImportShapesResult } from '@core/geometry/kernelPorts';
import { release } from '@core/geometry/nativeObject';
import { errorMessage } from '@lib/errorMessage';
import { uniqueSubShapes } from './occtTopology';
import type { OccApi, OccHandle, OccShape, OccSewing } from './occtTypes';

const SCRATCH_STEP = '/in.step';
const SCRATCH_BREP = '/out.brep';
const TESSELLATED = /TESSELLATED_|TRIANGULATED_FACE|COMPLEX_TRIANGULATED/;

interface StepReader extends OccHandle {
  ReadFile(path: string): { value: number };
  NbRootsForTransfer(): number;
  TransferRoots(): number;
  NbShapes(): number;
  OneShape(): OccShape;
}

interface Validity extends OccHandle {
  IsValid_2(): boolean;
}

interface Fixer extends OccHandle {
  SetPrecision(value: number): void;
  SetMaxTolerance(value: number): void;
  SetMinTolerance(value: number): void;
  Perform(progress: unknown): boolean;
  Shape(): OccShape;
  Status(status: unknown): boolean;
}

interface FreeBounds extends OccHandle {
  GetClosedWires(): OccShape;
  GetOpenWires(): OccShape;
}

const isValid = (api: OccApi, shape: OccShape): boolean => {
  const check = new api.BRepCheck_Analyzer(shape, true) as Validity;
  const valid = check.IsValid_2();
  release(check);
  return valid;
};

const countOf = (api: OccApi, shape: OccShape, kind: 'TopAbs_EDGE' | 'TopAbs_FACE' | 'TopAbs_SHELL'): number => {
  const subShapes = uniqueSubShapes(api, shape, kind);
  subShapes.forEach(release);
  return subShapes.length;
};

/** Largest vertex / edge / face tolerance (mm). */
function maxToleranceOf(api: OccApi, shape: OccShape): number {
  const readers = [
    ['TopAbs_VERTEX', 'Vertex_1', 'Tolerance_3'],
    ['TopAbs_EDGE', 'Edge_1', 'Tolerance_2'],
    ['TopAbs_FACE', 'Face_1', 'Tolerance_1'],
  ] as const;
  let max = 0;
  for (const [kind, cast, tolerance] of readers) {
    for (const sub of uniqueSubShapes(api, shape, kind)) {
      const typed = api.TopoDS[cast](sub) as OccShape;
      max = Math.max(max, api.BRep_Tool[tolerance](typed) as number);
      release(typed);
      release(sub);
    }
  }
  return max;
}

/** Edges on the free boundary of `shape` (0 for a closed shell); 0 when ShapeAnalysis cannot answer. */
function freeEdgeCount(api: OccApi, shape: OccShape, tolerance: number): number {
  try {
    const bounds = new api.ShapeAnalysis_FreeBounds_2(shape, tolerance, false, false) as FreeBounds;
    const [closed, open] = [bounds.GetClosedWires(), bounds.GetOpenWires()];
    const edges = countOf(api, closed, 'TopAbs_EDGE') + countOf(api, open, 'TopAbs_EDGE');
    [closed, open, bounds].forEach(release);
    return edges;
  } catch {
    return 0;
  }
}

/** Every face a plane bounded by three edges: a mesh saved as B-rep. */
function isFaceted(api: OccApi, shape: OccShape): boolean {
  const faces = uniqueSubShapes(api, shape, 'TopAbs_FACE');
  let faceted = faces.length > 0;
  for (const face of faces) {
    if (faceted) {
      const typed = api.TopoDS.Face_1(face) as OccShape;
      const adaptor = new api.BRepAdaptor_Surface_2(typed, true) as OccHandle & { GetType(): unknown };
      const planar = adaptor.GetType() === api.GeomAbs_SurfaceType.GeomAbs_Plane;
      [adaptor, typed].forEach(release);
      faceted = planar && countOf(api, face, 'TopAbs_EDGE') === 3;
    }
    release(face);
  }
  return faceted;
}

/** BRepTools text of `shape` through the Emscripten FS; null when the write fails. */
function brepText(api: OccApi, shape: OccShape): string | null {
  const noProgress = new api.Handle_Message_ProgressIndicator_1() as OccHandle;
  try {
    if (api.BRepTools.Write_2(shape, SCRATCH_BREP, noProgress) !== true) return null;
    return api.FS.readFile(SCRATCH_BREP, { encoding: 'utf8' }) as string;
  } finally {
    release(noProgress);
    try {
      api.FS.unlink(SCRATCH_BREP);
    } catch {
      /* never written */
    }
  }
}

/** The shape `BRepTools.Write` text `brep` describes (blob payload); null when OCC cannot read it. */
export function readBrepText(api: OccApi, brep: string): OccShape | null {
  api.FS.writeFile(SCRATCH_BREP, brep);
  const shape = new api.TopoDS_Shape() as OccShape;
  const builder = new api.BRep_Builder() as OccHandle;
  const noProgress = new api.Handle_Message_ProgressIndicator_1() as OccHandle;
  try {
    if (api.BRepTools.Read_2(shape, SCRATCH_BREP, builder, noProgress) === true && !shape.IsNull()) return shape;
    release(shape);
    return null;
  } finally {
    [noProgress, builder].forEach(release);
    try {
      api.FS.unlink(SCRATCH_BREP);
    } catch {
      /* never written */
    }
  }
}

/** Sub-shapes of `kind` that sit outside any `avoid` ancestor (free shells outside solids, loose faces outside shells). */
function outside(api: OccApi, shape: OccShape, kind: string, avoid: string): OccShape[] {
  const exp = new api.TopExp_Explorer_2(shape, api.TopAbs_ShapeEnum[kind], api.TopAbs_ShapeEnum[avoid]) as OccHandle & {
    More(): boolean;
    Current(): OccShape;
    Next(): void;
  };
  const found: OccShape[] = [];
  for (; exp.More(); exp.Next()) found.push(exp.Current());
  release(exp);
  return found;
}

interface Candidate {
  readonly shape: OccShape;
  readonly validAsRead: boolean;
  readonly sewn: boolean;
}

/** Close the loose shells / faces of the transfer into solids; the shells that stay open are described in `skipped`. */
function sewLoose(api: OccApi, loose: readonly OccShape[], precision: number, skipped: string[]): Candidate[] {
  const sewing = new api.BRepBuilderAPI_Sewing(precision * 10, true, true, true, false) as OccSewing;
  for (const piece of loose) sewing.Add(piece);
  const noProgress = new api.Handle_Message_ProgressIndicator_1() as OccHandle;
  sewing.Perform(noProgress);
  release(noProgress);
  const sewn = sewing.SewedShape();
  const found: Candidate[] = [];
  for (const shell of sewn.IsNull() ? [] : uniqueSubShapes(api, sewn, 'TopAbs_SHELL')) {
    const typed = api.TopoDS.Shell_1(shell) as OccShape;
    if (api.BRep_Tool.IsClosed_1(typed) === true) {
      const fixSolid = new api.ShapeFix_Solid_1() as OccHandle & { SolidFromShell(shell: OccShape): OccShape };
      found.push({ shape: fixSolid.SolidFromShell(typed), validAsRead: false, sewn: true });
      release(fixSolid);
    } else {
      skipped.push(`open shell with ${freeEdgeCount(api, typed, precision)} free edges after sewing at ${precision * 10} mm`);
    }
    [typed, shell].forEach(release);
  }
  [sewn, sewing].forEach(release);
  return found;
}

function healed(api: OccApi, shape: OccShape, options: ImportShapesOptions): { shape: OccShape; actions: string[] } {
  const fixer = new api.ShapeFix_Shape_2(shape) as Fixer;
  fixer.SetPrecision(options.precision);
  fixer.SetMaxTolerance(options.maxTolerance);
  fixer.SetMinTolerance(options.precision / 10);
  const noProgress = new api.Handle_Message_ProgressIndicator_1() as OccHandle;
  fixer.Perform(noProgress);
  const actions = fixer.Status(api.ShapeExtend_Status.ShapeExtend_DONE) ? ['shape_fix'] : [];
  const result = fixer.Shape();
  [noProgress, fixer].forEach(release);
  return { shape: result, actions };
}

function reportOf(api: OccApi, candidate: Candidate, options: ImportShapesOptions): ImportedSolid | null {
  const toleranceBefore = maxToleranceOf(api, candidate.shape);
  const fixed = options.heal ? healed(api, candidate.shape, options) : { shape: candidate.shape, actions: [] };
  const solids = uniqueSubShapes(api, fixed.shape, 'TopAbs_SOLID');
  const final = solids.length === 1 ? (solids[0] as OccShape) : fixed.shape;
  const maxToleranceMm = maxToleranceOf(api, final);
  const brep = brepText(api, final);
  const report: ImportedSolid | null =
    brep === null
      ? null
      : {
          brep,
          validAsRead: candidate.validAsRead,
          validAfterHeal: isValid(api, final),
          actions: [
            ...(candidate.sewn ? ['sewn'] : []),
            ...fixed.actions,
            ...(maxToleranceMm > toleranceBefore * (1 + 1e-9) ? ['tolerance_grown'] : []),
          ],
          maxToleranceMm,
          freeEdges: freeEdgeCount(api, final, options.precision),
          faces: countOf(api, final, 'TopAbs_FACE'),
          faceted: isFaceted(api, final),
        };
  solids.forEach(release);
  if (fixed.shape !== candidate.shape) release(fixed.shape);
  return report;
}

function transferred(
  api: OccApi,
  text: string,
): { shape: OccShape; roots: number } | { error: 'unreadable' | 'tessellated_only'; detail: string } {
  api.FS.writeFile(SCRATCH_STEP, text);
  const reader = new api.STEPControl_Reader_1() as StepReader;
  try {
    if (reader.ReadFile(SCRATCH_STEP).value !== api.IFSelect_ReturnStatus.IFSelect_RetDone.value)
      return { error: 'unreadable', detail: 'the file is not a readable ISO 10303-21 STEP file' };
    const roots = reader.NbRootsForTransfer();
    const count = roots > 0 ? reader.TransferRoots() : 0;
    const shape = count > 0 && reader.NbShapes() > 0 ? reader.OneShape() : null;
    if (shape !== null && !shape.IsNull()) return { shape, roots };
    return TESSELLATED.test(text)
      ? { error: 'tessellated_only', detail: 'the file holds TESSELLATED_* geometry only; the B-rep reader transferred nothing' }
      : { error: 'unreadable', detail: `${roots} root entities, none transferred to a shape` };
  } finally {
    release(reader);
    try {
      api.FS.unlink(SCRATCH_STEP);
    } catch {
      /* never written */
    }
  }
}

/** Read, census, heal, sew and serialize the solids of a STEP file (see the module doc for the invariants). */
export function importStepShapes(api: OccApi, text: string, options: ImportShapesOptions): ImportShapesResult {
  let read: ReturnType<typeof transferred>;
  try {
    read = transferred(api, text);
  } catch (error) {
    return { error: 'unreadable', detail: errorMessage(error) };
  }
  if (!('shape' in read)) return read;
  const { shape, roots } = read;
  const solids = uniqueSubShapes(api, shape, 'TopAbs_SOLID');
  const looseShells = outside(api, shape, 'TopAbs_SHELL', 'TopAbs_SOLID');
  const looseFaces = outside(api, shape, 'TopAbs_FACE', 'TopAbs_SHELL');
  const openShells = looseShells.filter((shell) => api.BRep_Tool.IsClosed_1(api.TopoDS.Shell_1(shell)) !== true).length;
  const census = {
    roots,
    solids: solids.length,
    shells: countOf(api, shape, 'TopAbs_SHELL'),
    openShells,
    faces: countOf(api, shape, 'TopAbs_FACE'),
  };
  const skipped: string[] = [];
  const candidates: Candidate[] = solids.map((solid) => ({ shape: solid, validAsRead: isValid(api, solid), sewn: false }));
  const loose = [...looseShells, ...looseFaces];
  if (loose.length > 0 && options.sew) candidates.push(...sewLoose(api, loose, options.precision, skipped));
  else if (loose.length > 0) skipped.push(`${looseShells.length} loose shells and ${looseFaces.length} loose faces (sew is off)`);
  const imported = candidates.flatMap((candidate) => reportOf(api, candidate, options) ?? []);
  [...loose, ...candidates.map((candidate) => candidate.shape), shape].forEach(release);
  if (imported.length === 0)
    return {
      error: 'no_solid',
      detail: `${census.solids} solids, ${census.shells} shells (${census.openShells} open), ${census.faces} faces; ${skipped.join('; ')}`,
    };
  return { solids: imported, census, skipped };
}
