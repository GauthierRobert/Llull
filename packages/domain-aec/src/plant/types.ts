/**
 * Process-plant slice of the document (`CadDocument.plant`, plant README D2: one additive slice with one sub-record per area), owned by
 * the domain plugins in `packages/domain-aec/src/plant/<area>/`. Built so far: `piping` (02 RTE M1: tie-in ports, lines, runs = the stored
 * intent; parts and joints are derived, never stored, and appear as `RoutedPart` / `Joint` below). Lengths in the document unit (mm in
 * plant documents), directions are unit vectors.
 */

import type { Vec3 } from '@core/model/vectors';
import type { CatalogModel } from './catalog/types';
import type { SpecModel } from './spec/types';

/** Butt weld, flanged, socket weld, screwed, plain end, wafer, lug (02 RTE §3.1). */
export type EndType = 'BW' | 'FL' | 'SW' | 'SC' | 'PL' | 'WAF' | 'LUG';

/** A connection point. `direction` = outward unit normal of the connection face, pointing toward the pipe. */
export interface PortSpec {
  readonly position: Vec3;
  readonly direction: Vec3;
  /** Nominal size DN. */
  readonly dn: number;
  readonly endType: EndType;
  readonly rating?: string;
  readonly facing?: 'RF' | 'FF' | 'RTJ';
}

export interface TieInPoint {
  readonly id: string;
  readonly tag: string;
  readonly kind: 'tie_in' | 'battery_limit';
  readonly port: PortSpec;
}

/**
 * Reference of a run end to a port. `nozzle`: `equipmentId` = equipment element id, `nozzleId` = nozzle mark (port id `<tag>:<mark>`, 03 EQP).
 * `runEnd`: the open end of another run. `branch`: the branch point `branchId` of header run `runId` (02 M2: the start of a branch run).
 */
export type PortRef =
  | { readonly kind: 'tieIn'; readonly id: string }
  | { readonly kind: 'nozzle'; readonly equipmentId: string; readonly nozzleId: string }
  | { readonly kind: 'runEnd'; readonly runId: string; readonly end: 'start' | 'end' }
  | { readonly kind: 'branch'; readonly runId: string; readonly branchId: string };

/** A declared slope: `value` in `unit` (percent of the plan length, ratio = drop / run, or degrees), `fall` = the pipe descends along the flow. */
export interface Slope {
  readonly value: number;
  readonly unit: 'percent' | 'ratio' | 'deg';
  readonly fall: boolean;
}

/** Insulation of a line: thickness from the spec's insulation table (`source: 'spec'`, the table row is named) or given explicitly. */
export interface LineInsulation {
  readonly code: string;
  readonly thicknessMm: number;
  readonly material?: string;
  /** The material was given by the user, not read from the spec row: a re-read of the table keeps it. */
  readonly materialExplicit?: boolean;
  readonly source: 'spec' | 'explicit';
  /** `spec` source: which table row gave the thickness (`H dn<=100 T<=200C`). */
  readonly row?: string;
}

export interface PipeLine {
  readonly id: string;
  /** Explicit or from the template `{dn}-{service}-{sequence}-{spec}[-{insulationCode}{thickness}]`; unique. */
  readonly lineNumber: string;
  readonly service: string;
  readonly sequence: string;
  /** Id of a spec in `doc.plant.spec` (01 PSC): the newest revision is used by every derivation. */
  readonly spec: string;
  readonly dn: number;
  readonly designPressureBarG?: number;
  readonly designTempC?: number;
  readonly insulation?: LineInsulation;
  /** Declared slope of the whole line (a gravity drain): `check_piping` reports legs that rise against it (RTE_ADVERSE_SLOPE) and low / high points (RTE_POCKET). */
  readonly slope?: Slope;
  readonly from?: string;
  readonly to?: string;
}

/** A run end: at a port (`ref`) or open at `point`. */
export interface RunEnd {
  readonly ref?: PortRef;
  readonly point: Vec3;
  readonly direction?: Vec3;
}

/** How an auto-routed run was found (`auto_route_pipe`): the validated solution's numbers and the engine that produced them. */
interface AutoRouteRecord {
  readonly problemHash: string;
  /** Integer micrometres: lattice length + bends x bend cost + elevation penalties. */
  readonly cost: number;
  readonly bends: number;
  readonly expansions: number;
  readonly optimal: boolean;
  /** `ts` (in-process reference A*), `llull-route` (native) or any other source named by the solution. */
  readonly engine: string;
}

/** A catalogue component placed in a leg of a run (valve, reducer): its centre is `centreDistance` from the start point of intersection of leg `leg`. */
export interface InlineComponent {
  /** Step-scoped id (`valve-8.1`). */
  readonly id: string;
  /** Catalogue component type: `valveGate`, `valveGlobe`, ..., `reducerConcentric`. */
  readonly type: string;
  readonly tag?: string;
  /** Leg index in the run (legs = [start, ...pis, end]). */
  readonly leg: number;
  /** Centre of the component along the leg, from the leg start, document units. */
  readonly centreDistance: number;
  /** Reducers: outlet DN (the run continues at this size). */
  readonly dn2?: number;
  /** Valves: unit vector from the valve centre toward the handwheel. */
  readonly stemDirection?: Vec3;
}

/** A branch off a header run: the branch run `branchRunId` starts at the point `distance` along leg `leg` of the header centreline. */
export interface BranchPoint {
  /** Step-scoped id (`branch-9.2`). */
  readonly id: string;
  readonly leg: number;
  readonly distance: number;
  readonly branchRunId: string;
}

export interface PipeRun {
  readonly id: string;
  readonly lineId: string;
  /** Nominal size at the run start; absent = the line's DN (a branch run carries its own size). Reducers change it along the run. */
  readonly dn?: number;
  /** Valves and reducers placed in the legs (absent = none). */
  readonly inline?: readonly InlineComponent[];
  /** Branches taken off this run (absent = none). */
  readonly branches?: readonly BranchPoint[];
  readonly start: RunEnd;
  readonly end: RunEnd;
  /** Interior points of intersection; legs = [start, ...pis, end]. */
  readonly pis: readonly Vec3[];
  /** Slope declared per leg (index = leg, null = none); absent = no leg declared one. Kept in step with `pis` by `edit_route`. */
  readonly legSlopes?: ReadonlyArray<Slope | null>;
  /** Overrides the spec's elbow-angle tolerance (degrees) for this run; named in results. */
  readonly angleToleranceDeg?: number;
  /**
   * Set when the run no longer derives (a port was moved or removed, a nozzle was resized, ...): its display entities are dropped until a
   * command makes it derivable again. `piping_takeoff` lists such runs. A moved port is first followed by orthogonal stretch (02 M3);
   * `RTE_STRETCH_FAILED` is the mark when the stretch is not possible.
   */
  readonly broken?: { readonly code: string; readonly reason: string };
  readonly autoRoute?: AutoRouteRecord;
}

/** Project settings of the piping plugin (`set_piping_settings`). */
export interface PipingSettings {
  /** Line-number template, e.g. `{dn}-{service}-{sequence}-{spec}[-{insulationCode}{insulationThickness}]`; absent = the default (02 RTE §5.9). */
  readonly lineNumberTemplate?: string;
}

export interface PipingModel {
  readonly settings?: PipingSettings;
  readonly tieIns: Readonly<Record<string, TieInPoint>>;
  readonly tieInOrder: readonly string[];
  readonly lines: Readonly<Record<string, PipeLine>>;
  readonly lineOrder: readonly string[];
  readonly runs: Readonly<Record<string, PipeRun>>;
  readonly runOrder: readonly string[];
  /** Ids of the read-only display entities derived from each run (`<runId>/<kind>-<k>`), in route order. */
  readonly entityIds: Readonly<Record<string, readonly string[]>>;
}

/** A port of a derived part: `direction` points out of the part, toward whatever connects there. */
export interface PartPort {
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly dn: number;
  readonly endType: EndType;
  readonly rating?: string;
  readonly facing?: 'RF' | 'FF' | 'RTJ';
}

/** One catalogue part of a run, derived from the stored intent and the spec (never stored; ids depend only on route order). */
export interface RoutedPart {
  /** `${runId}/${kind}-${k}`, k counted per kind from 1 in route order. */
  readonly id: string;
  readonly runId: string;
  readonly kind: 'pipe' | 'elbow' | 'tee' | 'olet' | 'stubIn' | 'reducer' | 'flange' | 'gasket' | 'boltSet' | 'valve' | 'inline' | 'cap';
  /** `<spec>/<component id>/<size>`, e.g. `CS150/E90-LR/4`. */
  readonly catalogueKey: string;
  /** Takeoff key: PSC component type plus bend radius, e.g. `elbow90LR`, `flangeWeldNeck`. */
  readonly typeKey: string;
  readonly dn: number;
  readonly dn2?: number;
  readonly ports: readonly PartPort[];
  /** Elbow / tee / valve centre (PCF CENTRE-POINT); bolt sets: the joint centre. */
  readonly centre?: Vec3;
  /** Pipe pieces only: cut length and the index of the leg the piece lies on. */
  readonly cutLength?: number;
  readonly leg?: number;
  /** Elbows: the actual turn; the nominal angle is in `typeKey`. */
  readonly angleDeg?: number;
  /** Elbows: arc radius of the centreline, tangent to both ports. */
  readonly radius?: number;
  /** Inline components: the stored `InlineComponent.id` (valve, reducer and the flange sets next to it); branch fittings: the `BranchPoint.id`. */
  readonly componentId?: string;
  /** Inline components: the tag (`XV-1001`). */
  readonly tag?: string;
  /** Valves: unit vector from the centre toward the handwheel. */
  readonly stemDirection?: Vec3;
  /** Olets and stub-ins: the header pipe piece they sit on (their first port is welded to it, not to another port). */
  readonly onPart?: string;
  /** Bolt sets: stud count. */
  readonly studs?: number;
  /** Row dimensions the display geometry reads (outside diameter, wall, thickness, ring diameters ...), mm. */
  readonly dims: Readonly<Record<string, number>>;
  /** Not every dimension of the catalogue row is grade A (AF-32). */
  readonly unverified: boolean;
}

/** A connection between two parts, or a part and an external port (`parts` then holds the port id). */
export interface Joint {
  /** `${runId}/joint-${k}` in route order. */
  readonly id: string;
  readonly kind: 'buttWeld' | 'branchWeld' | 'socketWeld' | 'threaded' | 'flanged' | 'fittingToFitting';
  readonly parts: readonly [string, string];
  readonly position: Vec3;
  /** Weld root gap (butt weld), socket root gap (socket weld) or gasket thickness (flanged), mm. */
  readonly gapMm: number;
  /** Socket-weld and threaded joints: how far the pipe goes into the fitting, mm (the pipe piece cut length includes it). */
  readonly engagementMm?: number;
  /** Flanged joints: the gasket and bolt set that belong to it. */
  readonly accessories?: readonly string[];
}

export interface PlantModel {
  readonly piping?: PipingModel;
  /** 01 PSC: user-imported piping catalogues (the bundled open catalogue lives in code). */
  readonly catalog?: CatalogModel;
  /** 01 PSC M2: pipe specs (every revision) and their branch tables. */
  readonly spec?: SpecModel;
}

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Absent until the first plant command (plugin `piping`, plant 02 RTE: `add_tie_in_point`, `create_pipeline`). */
    plant?: PlantModel;
  }
}
