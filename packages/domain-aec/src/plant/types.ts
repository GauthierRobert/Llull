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
 * `runEnd`: the open end of another run. Branches join with 02 M2.
 */
export type PortRef =
  | { readonly kind: 'tieIn'; readonly id: string }
  | { readonly kind: 'nozzle'; readonly equipmentId: string; readonly nozzleId: string }
  | { readonly kind: 'runEnd'; readonly runId: string; readonly end: 'start' | 'end' };

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
  readonly insulation?: { readonly code: string; readonly thicknessMm: number };
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

export interface PipeRun {
  readonly id: string;
  readonly lineId: string;
  readonly start: RunEnd;
  readonly end: RunEnd;
  /** Interior points of intersection; legs = [start, ...pis, end]. */
  readonly pis: readonly Vec3[];
  /** Overrides the spec's elbow-angle tolerance (degrees) for this run; named in results. */
  readonly angleToleranceDeg?: number;
  readonly autoRoute?: AutoRouteRecord;
}

export interface PipingModel {
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
  /** Elbow centre of the PI (PCF CENTRE-POINT); bolt sets: the joint centre. */
  readonly centre?: Vec3;
  /** Pipe pieces only: cut length and the index of the leg the piece lies on. */
  readonly cutLength?: number;
  readonly leg?: number;
  /** Elbows: the actual turn; the nominal angle is in `typeKey`. */
  readonly angleDeg?: number;
  /** Elbows: arc radius of the centreline, tangent to both ports. */
  readonly radius?: number;
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
  readonly kind: 'buttWeld' | 'socketWeld' | 'threaded' | 'flanged' | 'fittingToFitting';
  readonly parts: readonly [string, string];
  readonly position: Vec3;
  /** Weld root gap (butt weld) or gasket thickness (flanged), mm. */
  readonly gapMm: number;
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
