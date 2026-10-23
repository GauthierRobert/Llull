/**
 * Process-plant slice of the document (`CadDocument.plant`, plant README D2: one additive slice with one sub-record per area), owned by
 * the domain plugins in `packages/domain-aec/src/plant/<area>/`. Built so far: `piping` (02 RTE, the subset the V2 auto-router needs:
 * tie-in ports, lines, runs). Lengths in the document unit (mm in plant documents), directions are unit vectors.
 */

import type { Vec3 } from '@core/model/vectors';
import type { CatalogModel } from './catalog/types';
import type { SpecModel } from './spec/types';

/** Butt weld, flanged, socket weld, screwed, plain end, wafer, lug (02 RTE §3.1). */
type EndType = 'BW' | 'FL' | 'SW' | 'SC' | 'PL' | 'WAF' | 'LUG';

/** A connection point. `direction` = outward unit normal of the connection face, pointing toward the pipe. */
interface PortSpec {
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

/** Reference of a run end to a port (nozzles, run ends and branches join with 03 EQP / 02 M2). */
export interface PortRef {
  readonly kind: 'tieIn';
  readonly id: string;
}

export interface PipeLine {
  readonly id: string;
  /** Explicit or from the template `{dn}-{service}-{sequence}-{spec}[-{insulationCode}{thickness}]`; unique. */
  readonly lineNumber: string;
  readonly service: string;
  readonly sequence: string;
  /** Spec name (01 PSC). Not resolved against a catalogue until 01 PSC lands: lines are reported unverified. */
  readonly spec: string;
  readonly dn: number;
  readonly designPressureBarG?: number;
  readonly designTempC?: number;
  readonly insulation?: { readonly code: string; readonly thicknessMm: number };
  readonly from?: string;
  readonly to?: string;
}

/** A run end: at a port (`ref`) or open at `point`. */
interface RunEnd {
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
  readonly autoRoute?: AutoRouteRecord;
}

export interface PipingModel {
  readonly tieIns: Readonly<Record<string, TieInPoint>>;
  readonly tieInOrder: readonly string[];
  readonly lines: Readonly<Record<string, PipeLine>>;
  readonly lineOrder: readonly string[];
  /** Each run derives one read-only display entity whose id is the run id. */
  readonly runs: Readonly<Record<string, PipeRun>>;
  readonly runOrder: readonly string[];
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
