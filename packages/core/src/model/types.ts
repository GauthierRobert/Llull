/** Domain model — the single source of truth for a CAD document; changed only by commands. */

import type { Animation, AnimationChannel, AnimationMode } from './animation';
import type { FaceGroup, MeshAssetRef, MeshSource } from './meshProvenance';
import type { BlendProfile, FaceBlendParams, FullRoundParams, JointRadius, SetbackCorner } from './blendTypes';
import { type CurveKind, type SheetKind, isCurve3D, isSheet } from './curveKinds';
import type { PropertyModel } from './propertyModel';
import type { ConstitutiveSet, MaterialModel } from './materialModel';
import type { Vec2, Vec3 } from './vectors';
import type { CageBoundary, CageElementIds, CageEdgeSharpness, CageSymmetry, CageVertexSharpness } from './subdivisionCage';
import type { ExactLeafRecipe } from './sheetSolid';
import type { Decal } from './decal';
import type { TextLayout } from './fonts';
import type { CurveOnFace, EmbossParams } from './wrap';
import type { AssemblyPresentationFields, Joint } from './joints';

export type { Joint, JointKind, JointMateRef } from './joints';
import type { AnalysisModel } from './analysis';
import type { DrawingsModel } from './sheet';
import type { PmiModel } from './pmi';
import type { DynamicsModel } from './dynamics';
import type { PrototypeModel } from './prototype';
import type { ReviewModel } from './review';
import type { DisplayModel } from './display';
import type { CurveSegment } from './curve';
import type { CompositesModel } from './composites';
import type { DocumentExtensions } from './documentExtensions';
import type { DocumentKernelSettings } from './documentKernelSettings';
import type { MaterialLibraryEntry, MaterialRecordInfo } from './materialLibrary';
import type { MaterialFinish } from './materialFinish';
export { FINISH_PATTERNS, type FinishPattern, type MaterialFinish } from './materialFinish';
import type { SheetMetalModel } from './sheetMetal';
import type { FeatureParams, PartRef } from './features';
import type { NurbsCurveData } from '../lib/nurbs/types';
import type { HelixDefinition } from '../lib/helix/types';
import type { SweepDesign, SweepSection, SweepStation } from './sweepOrientation';
import type { LoftSkin } from './loftSkin';
import type { NurbsSurfaceData, UvTrimLoop } from '../lib/nurbs/surfaceTypes';
import type { FaceOpParams } from './faceOps';
import type { DeformParams } from './deform';
import type { SketchPlaneFields } from './sketchPlanes';

/** Re-exported: every model consumer reads its vectors from here. */
export type { Vec2, Vec3 };
export type { Decal };

export type EntityId = string;

export const DOCUMENT_UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const;

export type DocumentUnit = (typeof DOCUMENT_UNITS)[number];

export const SOLID_KINDS = [
  'box',
  'cylinder',
  'sphere',
  'extrusion',
  'mesh',
  'cone',
  'torus',
  'wedge',
  'pyramid',
  'revolution',
  'sweep',
  'loft',
  'subdivision',
] as const;

export type SolidKind = (typeof SOLID_KINDS)[number];

/** 2D drafting kinds. Geometry is LOCAL to the work plane; BaseEntity.position places that plane in 3D. */
export const SHAPE2D_KINDS = [
  'line',
  'polyline',
  'arc',
  'circle',
  'rectangle',
  'point',
  'ellipse',
  'spline',
  'text',
  'dimension',
  'image',
] as const;

export type Shape2DKind = (typeof SHAPE2D_KINDS)[number];

export type EntityKind = SolidKind | Shape2DKind | CurveKind | SheetKind | 'instance';

export interface BaseEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  /** World-space origin (work-plane origin for 2D entities). */
  position: Vec3;
  /** Euler rotation in radians. */
  rotation: Vec3;
  layerId: string;
  /** Hex color, e.g. "#c8553d". */
  color: string;
  /** Set by `set_entity_name`. */
  name?: string;
  /** Set by `set_entity_name`; filtered by `find_entities`. */
  tags?: readonly string[];
  /** Key into `CadDocument.materials`; set by `assign_material`. */
  materialId?: string;
  /** Seed entity of a pattern copy (array_linear / array_polar / pattern_along_path); assign_material on the seed reaches its copies. */
  patternSourceId?: string;
  /** Decals painted on this solid (entity-local frame); set by `add_decal`. */
  decals?: ReadonlyArray<Decal>;
}

export interface BoxEntity extends BaseEntity {
  readonly kind: 'box';
  /** [width, height, depth]. */
  size: Vec3;
}

export interface CylinderEntity extends BaseEntity {
  readonly kind: 'cylinder';
  radius: number;
  height: number;
}

export interface SphereEntity extends BaseEntity {
  readonly kind: 'sphere';
  radius: number;
}

/** Closed XY polygon extruded along Z. */
export interface ExtrusionEntity extends BaseEntity {
  readonly kind: 'extrusion';
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
  /**
   * Exact closed boundary (arcs, Béziers) the exact kernel uses instead of the polygon.
   * @invariant when present `profile` is its tessellation; a command rewriting one rewrites both
   */
  curves?: ReadonlyArray<CurveSegment<Vec2>>;
}

/**
 * Triangle mesh: boolean/fillet/chamfer results, imports, plugin geometry. Created in world space with `position` / `rotation` at zero;
 * like every entity, a later `position` / `rotation` moves it (vertices rotated about the origin, then translated) — in the viewport,
 * the kernel, triangles, bounds and mass properties alike.
 * @invariant `brep`, when present, is the exact construction tree the kernel tessellated into `mesh` (before `position`/`rotation`); a
 *   command that rewrites `mesh` must rewrite or drop `brep`
 */
export interface MeshSolidEntity extends BaseEntity {
  readonly kind: 'mesh';
  mesh: MeshData;
  /** Exact shape recipe of a kernel result; absent for imported / triangle-only meshes. */
  brep?: ShapeRecipe;
  /** Exact `faceSlab` of a ply solid (before `position` / `rotation`); read ONLY by `export_step_ap242` (B-rep if the kernel builds it, else `mesh`). */
  stepSlab?: ShapeRecipe;
  /** Set only on the groove tool of a modelled thread (feature lowering): kernels skip post-boolean face merging on results built from it. */
  threadTool?: true;
  /** Per-face display colours (`set_face_color`), drawn over `color`; resolved on the current `mesh` by `faceColorTriangles`. */
  faceColors?: ReadonlyArray<FaceColor>;
  /** Where the triangles came from and whether that source is pinned (07 MSH); absent on kernel results and on `import_mesh` bodies. */
  meshSource?: MeshSource;
  /** Named triangle ranges from an import (OBJ groups, 3MF objects), `[start, end)` over the triangle order of `mesh.indices`. */
  faceGroups?: ReadonlyArray<FaceGroup>;
  /** Full-resolution triangles in the host's mesh asset store (07 MSH FR-MSH-02); `mesh` is then the display level of detail. */
  asset?: MeshAssetRef;
}

/**
 * Colour of one face of a mesh solid. The face is the smooth patch of `mesh` around `near` (entity-local, before `position` / `rotation`):
 * the triangles connected to the one closest to `near` without crossing a crease, so it follows the face through regeneration.
 */
export interface FaceColor {
  readonly near: Vec3;
  /** Hex `#rrggbb`. */
  readonly color: string;
}

/** Base circle in XY centered at `position`, apex at +Z. */
interface ConeEntity extends BaseEntity {
  readonly kind: 'cone';
  radius: number;
  height: number;
}

/** Centered at `position`; valid when 0 < tubeRadius < ringRadius. */
interface TorusEntity extends BaseEntity {
  readonly kind: 'torus';
  /** Major radius: center to tube center. */
  ringRadius: number;
  /** Minor radius: tube cross-section. */
  tubeRadius: number;
}

/** Right-triangular ramp: full height at z=0, tapering to zero at z=depth. `position` is the lower-front-left corner. */
interface WedgeEntity extends BaseEntity {
  readonly kind: 'wedge';
  /** [width (X), height (Y), depth (Z)], all > 0. */
  size: Vec3;
}

/** Rectangular base centered at `position` (±baseWidth/2 in X, ±baseDepth/2 in Y), apex at +Z. */
interface PyramidEntity extends BaseEntity {
  readonly kind: 'pyramid';
  baseWidth: number;
  baseDepth: number;
  height: number;
}

/**
 * Closed profile revolved about `axis` through `position`; profile points are [radialOffset, axialOffset].
 * @invariant profile.length >= 3
 * @invariant 0 < angle <= 2π
 * @invariant segments >= 3
 * @see revolve_profile
 */
export interface RevolutionEntity extends BaseEntity {
  readonly kind: 'revolution';
  profile: ReadonlyArray<readonly [number, number]>;
  /** Unit vector in local entity space. */
  axis: Vec3;
  /** Sweep in radians; 2π = full revolution. */
  angle: number;
  /** Radial tessellation subdivisions. */
  segments: number;
  /** Exact closed profile boundary; same invariant as `ExtrusionEntity.curves`. */
  curves?: ReadonlyArray<CurveSegment<Vec2>>;
}

/**
 * A cross-section swept along a tangent-continuous 3D path (pipes, rails, ducts, coils) with a rotation-minimizing frame. Path points are
 * local (relative to `position`, then `rotation`).
 * @invariant path is a connected chain of >= 1 segment, G1 at every joint, open (end != start)
 * @see sweep_profile
 */
export interface SweepEntity extends BaseEntity, SweepDesign {
  readonly kind: 'sweep';
  path: ReadonlyArray<CurveSegment<Vec3>>;
  section: SweepSection;
  /**
   * Variable section: rings (SECTION_RING_POINTS points, section coordinates, read as closed Catmull-Rom curves) at path fractions `at`,
   * blended in between; replaces `section` geometry.
   * @invariant >= 2 stations, `at` strictly increasing from 0 to 1, equal ring point counts
   */
  stations?: ReadonlyArray<SweepStation>;
}

/**
 * Solid skinned through ordered 3D section rings (local to `position`), each a closed Catmull-Rom curve through SECTION_RING_POINTS aligned
 * points; `ruled` joins neighbours with straight lines.
 * @invariant >= 2 rings, equal point counts, consistent winding
 * @see loft_sections
 */
export interface LoftEntity extends BaseEntity, LoftSkin {
  readonly kind: 'loft';
  rings: ReadonlyArray<ReadonlyArray<Vec3>>;
  ruled: boolean;
  /**
   * Exact sections (loft v3, local to `position`): one open cubic curve per section, closed by a straight edge when its ends differ. The
   * exact kernel skins them unresampled; `rings` is then only the dense display / Manifold fallback sampled from them.
   * @invariant one per ring; equal Bézier span counts and closing-edge status
   */
  sections?: ReadonlyArray<NurbsCurveData>;
}

/**
 * Freeform solid: a polygon control cage (local to `position`; closed unless `boundary` is set) refined `levels` times by Catmull-Clark subdivision; cage edges
 * listed in `creases` stay infinitely sharp, `edgeSharpness` / `vertexSharpness` hold semi-sharp values.
 * @invariant 2-manifold cage (closed, or open with boundary edges when `boundary` is set), faces wound counter-clockwise seen from outside, 0..4 levels; an edge is in `creases` (infinite) or in
 *   `edgeSharpness` (0 < s < 10), never both; `elementIds` are parallel to `vertices` / `faces` and survive topology edits
 * @see add_subdivision_solid, edit_subdivision_cage, set_cage_crease, set_cage_symmetry
 */
export interface SubdivisionEntity extends BaseEntity {
  readonly kind: 'subdivision';
  vertices: ReadonlyArray<Vec3>;
  faces: ReadonlyArray<ReadonlyArray<number>>;
  creases: ReadonlyArray<readonly [number, number]>;
  levels: number;
  edgeSharpness?: ReadonlyArray<CageEdgeSharpness>;
  vertexSharpness?: ReadonlyArray<CageVertexSharpness>;
  creaseMethod?: 'uniform' | 'chaikin';
  /** Present = open cages are accepted: boundary edges are infinitely sharp and the corner rule is this mode. Absent = closed cage. */
  boundary?: CageBoundary;
  symmetry?: CageSymmetry;
  elementIds: CageElementIds;
}

export interface LineEntity extends BaseEntity {
  readonly kind: 'line';
  start: Vec2;
  end: Vec2;
}

export interface PolylineEntity extends BaseEntity {
  readonly kind: 'polyline';
  /** Minimum 2 points. */
  points: ReadonlyArray<Vec2>;
  closed: boolean;
}

export interface ArcEntity extends BaseEntity {
  readonly kind: 'arc';
  center: Vec2;
  radius: number;
  /** Radians, counter-clockwise from +X. */
  startAngle: number;
  endAngle: number;
}

export interface CircleEntity extends BaseEntity {
  readonly kind: 'circle';
  center: Vec2;
  radius: number;
}

/** Origin at the lower-left corner; width along +X, height along +Y. */
export interface RectangleEntity extends BaseEntity {
  readonly kind: 'rectangle';
  width: number;
  height: number;
}

/** Geometry is `position` alone. */
export interface PointEntity extends BaseEntity {
  readonly kind: 'point';
}

/** Axis-aligned in the local plane; semi-axes > 0. */
export interface EllipseEntity extends BaseEntity {
  readonly kind: 'ellipse';
  center: Vec2;
  radiusX: number;
  radiusY: number;
}

/** Centripetal Catmull-Rom through `points` (periodic when `closed`); no separate control polygon. */
export interface SplineEntity extends BaseEntity {
  readonly kind: 'spline';
  /** Minimum 2 points. */
  points: ReadonlyArray<Vec2>;
  closed: boolean;
}

/**
 * Clamped NURBS curve in 3D; poles are local to `position` / `rotation`.
 * @invariant `nurbsViolation(curve) === null`
 * @see create_nurbs_curve, interpolate_curve, create_conic, edit_nurbs
 */
export interface NurbsCurveEntity extends BaseEntity {
  readonly kind: 'nurbs_curve';
  curve: NurbsCurveData;
  /** Design intent the poles approximate (`add_helix`); local to `position`. */
  analytic?: HelixDefinition;
  /** Set by `wrap_to_face` / `project_to_face`: the face this curve lies on (03 WRP). */
  onFace?: CurveOnFace;
}

/**
 * Open NURBS surface sheet (not a solid: no volume, no kernel leaf); poles are local to `position` / `rotation`.
 * @invariant `surfaceViolation(surface) === null`
 * @see loft_surface, surface_from_points, fill_surface, trim_surface, sew_surfaces, thicken_surface, loft_fuselage
 */
export interface NurbsSurfaceEntity extends BaseEntity {
  readonly kind: 'nurbs_surface';
  surface: NurbsSurfaceData;
  /** Trim loops in the (u, v) plane (`trim_surface` by curve); absent = the natural rectangular boundary. */
  trims?: ReadonlyArray<UvTrimLoop>;
}

/** Annotation anchored at `position`. */
export interface TextEntity extends BaseEntity, TextLayout {
  readonly kind: 'text';
  /** Non-empty. */
  content: string;
  /** Cap-height in model units, > 0. */
  height: number;
  /** Alignment relative to `position`. Default 'left'. */
  anchor?: 'left' | 'center' | 'right';
}

/**
 * Associative dimension; `entityIds` required count by `dimensionKind`: linear/aligned 2 (line or point), radial/diameter 1
 * (circle/arc/ellipse), angular 3 (vertex point + 2 lines, or 3 points) or 2 (two lines; the vertex is their intersection). Dangling refs are flagged by check_model.
 */
export interface DimensionEntity extends BaseEntity {
  readonly kind: 'dimension';
  dimensionKind: 'linear' | 'aligned' | 'radial' | 'diameter' | 'angular';
  entityIds: readonly string[];
  /** Perpendicular distance from measured geometry to the dimension line. Default 5. */
  offset?: number;
  /** Overrides CadDocument.displayPrecision. */
  precision?: number;
  /** Replaces the computed value text. */
  label?: string;
  /** Drawn after the computed value, e.g. '±0.1', '+0.05/-0.02' or 'H7'. Ignored when `label` is set. */
  tolerance?: string;
}

/**
 * Raster underlay (a scanned drawing to trace over). Occupies [0, width] × [0, height] of its work plane, lower-left corner at `position`;
 * pixel (0, 0) is the image's TOP-left corner, +y down.
 * @invariant dataUrl is a base64 `data:image/png` or `data:image/jpeg` URL of pixelWidth × pixelHeight
 * @invariant width, height > 0; 0 <= opacity <= 1
 * @see add_image_underlay, calibrate_underlay, image_to_world
 */
export interface ImageEntity extends BaseEntity {
  readonly kind: 'image';
  dataUrl: string;
  /** Intrinsic raster size, integers > 0. */
  pixelWidth: number;
  pixelHeight: number;
  /** Placed size in document units. */
  width: number;
  height: number;
  opacity: number;
  /** Locked underlays are not pickable in the viewport (they never get in the way of tracing). */
  locked: boolean;
}

/**
 * Placed reference to a Component definition; geometry is never copied.
 * @invariant componentId exists in CadDocument.components
 * @see Component, create_component, insert_instance, explode_instance
 */
export interface InstanceEntity extends BaseEntity {
  readonly kind: 'instance';
  componentId: string;
  /** Per-axis scale about the component origin. Default [1,1,1]. */
  scale?: Vec3;
}

export type Entity =
  | BoxEntity
  | CylinderEntity
  | SphereEntity
  | ExtrusionEntity
  | MeshSolidEntity
  | ConeEntity
  | TorusEntity
  | WedgeEntity
  | PyramidEntity
  | RevolutionEntity
  | SweepEntity
  | LoftEntity
  | SubdivisionEntity
  | LineEntity
  | PolylineEntity
  | ArcEntity
  | CircleEntity
  | RectangleEntity
  | PointEntity
  | EllipseEntity
  | SplineEntity
  | NurbsCurveEntity
  | NurbsSurfaceEntity
  | TextEntity
  | DimensionEntity
  | ImageEntity
  | InstanceEntity;

const SHAPE2D_KIND_SET: ReadonlySet<string> = new Set(SHAPE2D_KINDS);

export function is2D(e: Entity): e is Extract<Entity, { kind: Shape2DKind }> {
  return SHAPE2D_KIND_SET.has(e.kind);
}

/** True for solids, meshes, instances and images; false for planar shapes and 3D curves (no volume, no kernel leaf). */
export function is3D(e: Entity): boolean {
  return !SHAPE2D_KIND_SET.has(e.kind) && !isCurve3D(e) && !isSheet(e);
}

export interface Layer {
  readonly id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Hex tint for the UI, e.g. "#ff0000". */
  color?: string;
}

export interface CameraState {
  target: Vec3;
  /** Spherical orbit angles (radians) + distance. */
  azimuth: number;
  polar: number;
  distance: number;
}

/** Named membership list; members keep their kinds and positions. */
export interface EntityGroup {
  readonly id: string;
  name: string;
  /** All must exist in `entities`. */
  memberIds: EntityId[];
}

/**
 * Named parameter-expression overrides; activating one rewrites `CadDocument.parameters` and replays history.
 * @see create_configuration, activate_configuration
 */
export interface Configuration {
  readonly name: string;
  /** Parameter name -> expression (same format as `Parameter.expression`). */
  parameterValues: Record<string, string>;
}

/** Named numeric parameter; `expression` (literal or reference, e.g. "width * 2") is the source of truth. */
export interface Parameter {
  readonly name: string;
  expression: string;
  /** Last successful evaluation. */
  value: number;
  /** Set when evaluation failed (unknown reference, cycle, parse error). */
  error?: string;
}

/** One recorded command invocation; the history is the constructive recipe (architecture L8). Suppressed steps are skipped on replay. */
export interface FeatureStep {
  /** `step-<n>` (`CadDocument.nextStepNumber`); legacy v1 files keep their old ids. */
  readonly id: string;
  /** Registry command name. */
  readonly name: string;
  readonly params: unknown;
  suppressed?: boolean;
  label?: string;
  /** `CommandResult.affected` at record time; legacy (v1) replay zips it with replayed ids to remap references. */
  affected?: readonly EntityId[];
}

/**
 * Named snapshot of a featureHistory, replayed additively with fresh ids.
 * @see save_recipe, instantiate_recipe
 */
export interface Recipe {
  readonly name: string;
  readonly steps: FeatureStep[];
  label?: string;
}

/**
 * Reusable definition: entities in component-local coordinates, referenced by `InstanceEntity`.
 * @invariant every id in `order` is a key in `entities`
 * @see InstanceEntity, create_component, insert_instance, explode_instance
 */
export interface Component {
  /** Minted by nextId('comp'). */
  readonly id: string;
  name: string;
  entities: Record<EntityId, Entity>;
  order: EntityId[];
  /** Standard part this component is (08 MAT, set by the fasteners plugin); `bill_of_materials` groups by it. */
  readonly partRef?: PartRef;
}

/**
 * A point on an entity: its `position` when `kind` is absent, else a named sub-point of a line, arc, or circle ('center' of a line is its
 * midpoint).
 */
export type EntityRef = { readonly entityId: string } | { readonly entityId: string; readonly kind: 'start' | 'end' | 'center' | 'mid' };

// prettier-ignore
export const DIMENSION_CONSTRAINT_KINDS = ['distance', 'angle', 'radius', 'diameter', 'aligned', 'horizontal_distance', 'vertical_distance', 'point_to_line', 'arc_sweep', 'arc_length', 'slot_length'] as const;

// prettier-ignore
const GEOMETRIC_CONSTRAINT_KINDS = ['coincident', 'parallel', 'perpendicular', 'tangent', 'horizontal', 'vertical', 'equal', 'concentric', 'collinear', 'midpoint', 'symmetric', 'fix', 'point_on_curve', 'curvature'] as const;

export const CONSTRAINT_KINDS = [...GEOMETRIC_CONSTRAINT_KINDS, ...DIMENSION_CONSTRAINT_KINDS] as const;

type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export type DimensionConstraintKind = (typeof DIMENSION_CONSTRAINT_KINDS)[number];

type GeometricConstraintKind = Exclude<(typeof GEOMETRIC_CONSTRAINT_KINDS)[number], 'symmetric'>;

/** Unary kinds (horizontal on a line, fix, radius, ...) store `b` equal to `a`. */
interface ConstraintBase<K extends ConstraintKind> {
  readonly id: string;
  readonly kind: K;
  readonly a: EntityRef;
  readonly b: EntityRef;
}

/**
 * `value` is a literal or a parameter expression. Units: document units for lengths and distances, radians for angles and sweeps.
 * Offsets (horizontal_distance, vertical_distance, point_to_line) are magnitudes; the side of the current sketch is kept.
 */
interface ConstraintTarget {
  readonly value: number | string;
}

/** Mirror axis of `symmetric`: a line (no `kind`) or a point (a named sub-point). */
interface ConstraintAxis {
  readonly axis: EntityRef;
}

/** Solver-driven relation between entities `a` and `b` (see solve_constraints). */
export type Constraint =
  | ConstraintBase<GeometricConstraintKind>
  | (ConstraintBase<'symmetric'> & ConstraintAxis)
  | (ConstraintBase<DimensionConstraintKind> & ConstraintTarget);

/**
 * Couples joints: `driven = driver * ratio + offset` (gears, belts, linkages).
 * @invariant driver and driven exist in doc.joints, driver !== driven, drive graph is acyclic
 * @see add_drive_relation, delete_drive_relation, evaluate_motion
 */
export interface DriveRelation {
  readonly id: string;
  /** Driving joint id. */
  driver: string;
  /** Driven joint id. */
  driven: string;
  ratio: number;
  /** Default 0. */
  offset?: number;
}

/** Document units default to 'mm'; every map/list below is initialized empty by createEmptyDocument. */
export interface CadDocument extends AssemblyPresentationFields, SketchPlaneFields, DocumentExtensions {
  entities: Record<EntityId, Entity>;
  /** Z-order / creation order of entity ids. */
  order: EntityId[];
  layers: Record<string, Layer>;
  layerOrder: string[];
  selection: EntityId[];
  camera: CameraState;
  groups: Record<string, EntityGroup>;
  units: DocumentUnit;
  /** Decimal places for displayed lengths. Default 3. */
  displayPrecision: number;
  /** Keyed by parameter name; evaluated in topological order, cycles/unknown refs set `error`. */
  parameters: Record<string, Parameter>;
  animations: Record<string, Animation>;
  /**
   * Replayable command list: replaying non-suppressed steps from `createEmptyDocument()` regenerates `entities` (architecture L8).
   * `execute()` appends mutating commands; history meta-commands only edit the list.
   */
  featureHistory: FeatureStep[];
  /** Next `step-<n>`; never reused so step-scoped entity ids stay unique. Absent = 1. */
  nextStepNumber?: number;
  /** Design table: variants of parameter expressions. */
  configurations: Record<string, Configuration>;
  /** Keyed by material name; referenced by `BaseEntity.materialId`. */
  materials: Record<string, Material>;
  recipes: Record<string, Recipe>;
  /** Keyed by component id. */
  components: Record<string, Component>;
  /** Keyed by constraint id; `constraintOrder` lists ids in creation order. */
  constraints: Record<string, Constraint>;
  constraintOrder: string[];
  /** Keyed by joint id; `jointOrder` lists ids in creation order. */
  joints: Record<string, Joint>;
  jointOrder: string[];
  /** Keyed by drive relation id; `driveRelationOrder` lists ids in creation order. */
  driveRelations: Record<string, DriveRelation>;
  driveRelationOrder: string[];
  /** Absent until the first sheet command (`create_sheet`). */
  drawings?: DrawingsModel;
  /** Absent until the first PMI command (`set_pmi_standard`, `add_datum_feature`, ...). */
  pmi?: PmiModel;
  /** Absent until the first rigid-body dynamics command (`add_rigid_body`). */
  dynamics?: DynamicsModel;
  /** Absent until the first prototype-review command (`allow_interference`, `set_part_grounded`). */
  prototype?: PrototypeModel;
  /** Absent until the first model-review command (`save_viewpoint`, `create_review_issue`; plant 09 VIS). */
  review?: ReviewModel;
  /** Absent until the first display command (`define_colour_profile`, `apply_service_colour_scheme`; plant 09 VIS). */
  display?: DisplayModel;
  /** Absent until a kernel-provenance command or a v3 save stamps it (`set_modeling_tolerance`, `import_step_exact`). */
  kernelSettings?: DocumentKernelSettings;
  /** Content-addressed binary payloads keyed by sha256 (healed B-rep, original STEP); absent until the first exact import. */
  blobs?: Record<string, DocumentBlob>;
  /** Fonts embedded for outline text (`import_font`, 03 WRP) by id; bytes are `blobs` entries. */
  fonts?: Record<string, import('./fonts').FontRecord>;
  /** Absent until the first exact import with provenance (`import_step_exact`, `import_iges`; aerospace 04 XCH). */
  exchange?: import('./exchange').ExchangeModel;
  /** Absent until the first analysis command (`create_analysis`, plugin `cae`). */
  analysis?: AnalysisModel;
  /** Imported material libraries by id (08 MAT M3); absent until `import_material_library`. */
  materialLibraries?: Record<string, MaterialLibraryEntry>;
  /** Absent until the first composites command (plugin composites, 06 CMP). */
  composites?: CompositesModel;
  /** Absent until the first sheet-metal command (plugin `sheetmetal`, 07 FTR M3). */
  sheetMetal?: SheetMetalModel;
  /** Contact sets / exploded views (`AssemblyPresentationFields`) and sketch planes / links (`SketchPlaneFields`) are inherited. */
}

export type { DocumentKernelSettings, Animation, AnimationChannel, AnimationMode };

/**
 * Content-addressed payload referenced by `brep` recipe leaves.
 * @invariant `sha256` = sha256 of the decoded bytes (UTF-8 text; raw for fonts) = its key in `CadDocument.blobs`; `size` = byte length
 */
export interface DocumentBlob {
  readonly sha256: string;
  readonly mediaType: 'model/x-occt-brep' | 'model/step' | 'model/iges' | 'font/ttf' | 'font/otf' | 'font/x-llull-stroke';
  /** Base64 of the payload text. */
  readonly bytes: string;
  readonly size: number;
}

/**
 * Physical + PBR material. `density` is mass per (document unit)³ so mass = volume × density (mm document: g/mm³, steel ≈ 0.00785).
 * Replaced via `create_material`.
 * @invariant density > 0 and finite (0 only on a `record` material with no density value yet, or an unresolved private stub); color matches
 *   /^#[0-9a-fA-F]{6}$/; metalness, roughness in [0, 1]
 */
export interface Material {
  readonly name: string;
  density: number;
  /** Unit `density` was given in at creation (create_material `densityUnit`); absent = given directly in g/(document unit)³. Still no source. */
  readonly densityUnit?: string;
  /** Where the density comes from (FR-FPR-73): a material with a source is not reported as unsourced by the dynamics mass. */
  readonly source?: string;
  /** Quality of `source`: A measured / verified, B published datasheet, C reconstructed or unchecked. */
  readonly grade?: 'A' | 'B' | 'C';
  /** Aerospace material record (08 MAT M2): designation, specs, licence, export marking, library origin. Absent on a legacy material. */
  readonly record?: MaterialRecordInfo;
  color: string;
  metalness: number;
  roughness: number;
  /** Procedural surface texture (albedo + normal + roughness maps); absent = plain PBR colour. */
  finish?: MaterialFinish;
  /** Property models (PHY-01: k(T), cp(T), E(T), …) defined with define_property_model; read through `propertyModelEval`. */
  readonly propertyModels?: readonly PropertyModel[];
  /** Constitutive / durability laws (PHY-02: add_material_model); read through `materialLaws/*`. */
  readonly materialModels?: readonly MaterialModel[];
  /** Named combinations of material models an analysis picks (PHY-02: define_constitutive_set). */
  readonly constitutiveSets?: readonly ConstitutiveSet[];
  /** Id of the set used when a query names none. */
  readonly defaultConstitutiveSet?: string;
}

export const DEFAULT_LAYER_ID = 'layer-default';

export function createEmptyDocument(): CadDocument {
  return {
    entities: {},
    order: [],
    layers: { [DEFAULT_LAYER_ID]: { id: DEFAULT_LAYER_ID, name: 'Layer 0', visible: true, locked: false } },
    layerOrder: [DEFAULT_LAYER_ID],
    selection: [],
    camera: { target: [0, 0, 0], azimuth: (3 * Math.PI) / 4, polar: Math.PI / 3, distance: 12 },
    groups: {},
    units: 'mm',
    displayPrecision: 3,
    parameters: {},
    animations: {},
    featureHistory: [],
    configurations: {},
    materials: {},
    recipes: {},
    components: {},
    constraints: {},
    constraintOrder: [],
    joints: {},
    jointOrder: [],
    driveRelations: {},
    driveRelationOrder: [],
  };
}

/** World-space triangle mesh. `positions`: flat xyz triples (length 3 × vertexCount); `indices`: flat triangle vertex indices. */
export type MeshData = { readonly positions: ReadonlyArray<number>; readonly indices: ReadonlyArray<number> };

export type BooleanOp = 'union' | 'subtract' | 'intersect';

/**
 * Radius law of one filleted edge: `size` at its start, `sizeEnd` at its end (linear between, constant when absent); `sizes` adds interior
 * control points (`t` in (0, 1) strictly increasing, relative position on the tangent chain, radius `size` there) the radius passes through
 * (BRepFilletAPI_MakeFillet radius law). `interpolation` "linear" joins the points with straight pieces; absent / "smooth" is the kernel's
 * smooth interpolation (default).
 */
export interface EdgeRadius {
  readonly size: number;
  readonly sizeEnd?: number;
  readonly sizes?: ReadonlyArray<{ readonly t: number; readonly size: number }>;
  readonly interpolation?: 'smooth' | 'linear';
  /** Second leg (BLD M2): with it `size` is the leg on the face `sideFace` and `size2` the leg on the other face, document units. */
  readonly size2?: number;
  /** Unique face index of the source shape carrying `size` when `size2` is given. */
  readonly sideFace?: number;
}

/**
 * Shape recipe: the serializable construction tree of a solid, stored on kernel results (`MeshSolidEntity.brep`) and evaluated by the
 * kernel (`@core/geometry/shapeRecipe`).
 */
export type ShapeRecipe =
  /** A solid entity as authored (primitive, profile solid, or a plain triangle mesh). */
  | { readonly op: 'solid'; readonly entity: Entity }
  | { readonly op: 'boolean'; readonly boolean: BooleanOp; readonly a: ShapeRecipe; readonly b: ShapeRecipe }
  /**
   * `edges`: 0-based indices into the source's unique edges (`ShapeTopology.edges`); [] = all. `sizeEnd` (fillet only): radius at each
   * edge's end, varying linearly from `size` at its start. `near`: the mid point of each selected edge at creation (document frame), so code
   * generators can pick the same edges by position when the kernel's edge indices are unavailable; kernels ignore it.
   * `radii` (fillet only): one law per entry of `edges` (same length, edges non-empty); `size` is then the placeholder 0, so a kernel that
   * does not read `radii` refuses instead of rounding every edge with one radius.
   * `faces` (chamfer only, BLD M1): per entry of `edges` the unique face index carrying the first leg `size`; with it, `size2` is the second leg
   * (distance-distance) or `angleDeg` the angle in degrees (0, 90) measured on that face (distance-angle); exactly one of the two. With `sizeEnd` both legs run linearly start to end (BLD M5): `size2` -> `size2End`, no angle.
   */
  | {
      readonly op: 'fillet' | 'chamfer';
      readonly source: ShapeRecipe;
      readonly edges: readonly number[];
      readonly size: number;
      readonly sizeEnd?: number;
      readonly radii?: readonly EdgeRadius[];
      readonly near?: readonly Vec3[];
      readonly faces?: readonly number[];
      readonly size2?: number;
      readonly size2End?: number;
      readonly angleDeg?: number;
      /** Fillet only (BLD M2): conic / curvature section; absent or circular = the rolling ball. A non-circular profile needs constant sizes. */
      readonly profile?: BlendProfile;
      /** Fillet only (BLD M3): setback corners; a vertex without an entry keeps the kernel's rolling-ball corner. */
      readonly corners?: readonly SetbackCorner[];
    }
  /**
   * A rolling-ball blend between two face sets that need not share an edge (BLD M4): `facesA` / `facesB` are unique face indices of the source,
   * `radius` the ball radius in document units, `profile` the section (absent = circular). The faces between the contact lines are consumed.
   */
  | ({ readonly op: 'faceBlend'; readonly source: ShapeRecipe } & FaceBlendParams)
  /** The full round of a rib top (BLD M4): a half-round tangent to `side1`, `side2` and `center`, which it consumes (unique face indices of the source). */
  | ({ readonly op: 'fullRound'; readonly source: ShapeRecipe } & FullRoundParams)
  /** One-piece union of `sources` with every new intersection (joint) edge filleted by `radius`; `joints` (BLD M5) give single joints their own radius. */
  | { readonly op: 'blend'; readonly sources: readonly ShapeRecipe[]; readonly radius: number; readonly joints?: readonly JointRadius[] }
  /** `openNear`: points, each picking the face of the source nearest to it to remove (an open pocket); absent = a sealed internal cavity. */
  | { readonly op: 'shell'; readonly source: ShapeRecipe; readonly thickness: number; readonly openNear?: readonly Vec3[] }
  /** Rotate (M = Rx·Ry·Rz, radians) then translate. */
  | { readonly op: 'place'; readonly source: ShapeRecipe; readonly position: Vec3; readonly rotation: Vec3 }
  /** Uniform scale about the world origin. */
  | { readonly op: 'scale'; readonly source: ShapeRecipe; readonly factor: number }
  /** An exact B-rep held in `CadDocument.blobs[blob]` (`BRepTools::Write` text): imported geometry (01 KRN TR-KRN-21). */
  | { readonly op: 'brep'; readonly blob: string; readonly format: 'occt-brep-v1'; readonly label?: string }
  /** A hole group or pocket cut into a face of `source` (07 FTR); kernels lower it to boolean subtracts (`geometry/featureLowering`). */
  | ({ readonly op: 'feature'; readonly source: ShapeRecipe } & FeatureParams)
  | ExactLeafRecipe
  /** Space deformation of `source` (01 DEF): every point p maps to frame⁻¹(law(frame(p))); the mesh path stays within `output.tolerance`. */
  | ({ readonly op: 'deform'; readonly source: ShapeRecipe } & DeformParams)
  /** Draft, push-pull or split of faces of `source` on its exact B-rep (SC-F1, `model/faceOps`); exact kernels only. */
  | ({ readonly op: 'faceOp'; readonly source: ShapeRecipe } & FaceOpParams)
  /** Emboss, deboss or scribe of regions on a plane / cylinder / cone face (03 WRP); exact kernels. */
  | ({ readonly op: 'emboss'; readonly source: ShapeRecipe } & EmbossParams);
