/**
 * Analysis (CAE) data: the FE set-up recorded on `CadDocument.analysis` (05 FEA hand-off, PHY-03 thermal, PHY-04 thermo-mechanical) and the
 * read-only artifact shapes + ports the host transports use. Everything here is JSON-serialisable data; solving lives outside the document.
 * @invariant lengths in a case (target points, mesh sizes, displacements) are in DOCUMENT units; loads/pressures/gravity are in the case
 *   `unitSystem`; temperatures are `Q` quantities
 */

import type { Vec3 } from './vectors';
import type { Quantity } from './quantity';
import type { DurabilityModel } from './durability';
import type { FeTopologyArtifact, TopologyStudy } from './topology';

/** Same structural id as `types.ts` `EntityId` (not imported: types.ts imports this module). */
type EntityId = string;

/** `{ value, unit }` with the 08 unit grammar (`lib/quantity`). */
export type Q = Quantity;

export type AnalysisType =
  | 'static'
  | 'modal'
  | 'buckling'
  | 'heat_steady'
  | 'heat_transient'
  | 'thermo_static'
  | 'coupled_temperature_displacement'
  | 'nonlinear_static';
export type FeSolver = 'calculix' | 'nastran';
export type UnitSystem = 'N-mm-t-s' | 'N-m-kg-s' | 'lbf-in-slinch-s';
export type TemperatureScale = 'degC' | 'K';
export type LoadCategory = 'limit' | 'ultimate';
export type Decision = 'accepted' | 'rejected' | 'redesign';
export type FeElementType = 'C3D4' | 'C3D10' | 'CPS3' | 'CPS6' | 'CPS4' | 'CPS8' | 'S3' | 'S6' | 'S4' | 'S8';
/** A result probe; axisPoint / axisDirection (document units / any non-zero vector) apply to the cylindrical quantities only. */
export interface ResultProbe {
  readonly name: string;
  readonly point: Vec3;
  readonly quantity: ProbeQuantity;
  readonly axisPoint?: Vec3;
  readonly axisDirection?: Vec3;
}

export type ProbeQuantity =
  | 'temperature'
  | 'heat_flux'
  | 'u_mag'
  | 'u_x'
  | 'u_y'
  | 'u_z'
  | 'von_mises'
  | 's_xx'
  | 's_yy'
  | 's_zz'
  | 's_hoop'
  | 's_radial'
  | 's_axial'
  | 'u_radial';

/** Only `solid` is built; the other kinds are 05 backlog and exist so documents stay forward-compatible. */
export type Idealization =
  | { readonly kind: 'solid' }
  | { readonly kind: 'plane_stress'; readonly thickness: number; readonly sourceFacesNear: readonly Vec3[] }
  | {
      readonly kind: 'shell';
      readonly thickness: number | 'auto';
      readonly offset: 'mid' | 'top' | 'bottom';
      readonly midsurface: { readonly maxThickness: number; readonly angularTolDeg: number };
    }
  | { readonly kind: 'beam'; readonly section: string };

/** Points that identify faces / edges / vertices of `entityId`; the mesher resolves them to the nearest topology (never ids). */
export interface FeaTarget {
  readonly entityId: EntityId;
  readonly facesNear?: readonly Vec3[];
  readonly edgesNear?: readonly Vec3[];
  readonly pointsNear?: readonly Vec3[];
  readonly intersectPlane?: { readonly point: Vec3; readonly normal: Vec3 };
}

export interface FeaConstraint {
  readonly id: string;
  readonly name: string;
  readonly kind: 'fixed' | 'pinned' | 'symmetry' | 'displacement';
  /** displacement only; absent DOF = free. Values in document length units (0 = fixed). */
  readonly dofs?: Partial<Record<'ux' | 'uy' | 'uz' | 'rx' | 'ry' | 'rz', number>>;
  readonly target: FeaTarget;
}

export interface FeaLoad {
  readonly id: string;
  readonly name: string;
  readonly loadCase: string;
  readonly category: LoadCategory;
  readonly kind: 'force' | 'pressure' | 'gravity' | 'moment';
  readonly target?: FeaTarget;
  readonly vector?: Vec3;
  readonly magnitude?: number;
  readonly distribution?: 'total' | 'per_node';
  readonly referencePoint?: Vec3;
}

export interface MeshControls {
  readonly mesher: 'gmsh' | 'netgen';
  readonly elementFamily: 'tet' | 'tri' | 'quad' | 'shell_quad' | 'shell_tri' | 'hex_dominant';
  readonly order: 1 | 2;
  readonly globalSize: number;
  readonly minSize?: number;
  readonly refinements: readonly { readonly target: FeaTarget; readonly size: number }[];
  readonly optimize: 'default' | 'netgen' | 'high_order' | 'none';
  /** 'conformal': touching parts are fragmented into one model and share interface nodes (STEP only). Absent = 'separate'. */
  readonly bonding?: 'conformal';
}

export interface FactorSet {
  readonly ultimate: number;
  readonly yield: number;
  readonly extra: readonly { readonly name: string; readonly value: number; readonly justification: string }[];
}

export interface QualitySummary {
  readonly metrics: Readonly<Record<string, { min: number; max: number; p01: number; p99: number; outsideAcceptable: number }>>;
  readonly inverted: number;
}

export interface MeshSummary {
  /** `false` = recorded WITHOUT its artifact (replay on a machine that lacks the store): never trusted, never read as numbers (05 §4.1). */
  readonly verified?: false;
  readonly meshHash: string;
  readonly inputHash: string;
  readonly mesher: string;
  readonly mesherVersion: string;
  readonly nodes: number;
  readonly elements: Readonly<Record<string, number>>;
  readonly quality: QualitySummary;
  readonly warnings: readonly string[];
  readonly faceMap: readonly { entityId: EntityId; faceIndex: number; tag: number; residual: number }[];
}

export interface Named {
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly defaulted: boolean;
}

/** PHY-03 §3.1 thermal results, inside `ResultsSummary.thermal`. */
export interface ThermalResultsSummary {
  readonly temperatureScale: TemperatureScale;
  readonly times: readonly number[];
  readonly maxT: { value: number; at: Vec3; entityId: EntityId; timeS: number };
  readonly minT: { value: number; at: Vec3; entityId: EntityId; timeS: number };
  readonly maxHeatFluxW_m2: { value: number; at: Vec3; timeS: number };
  readonly bcHeatFlowsW: ReadonlyArray<{ bcId: string; timeS: number; valueW: number }>;
  readonly heatBalance: {
    inW: number;
    outW: number;
    storedW: number;
    residualRel: number;
    timeS: number;
    /** Transient only: spread of the residual between two quadratures of the BC flows over the last output interval (coarse outputs). */
    samplingRel?: number;
  };
  readonly probes: ReadonlyArray<{ probeId: string; series: ReadonlyArray<readonly [timeS: number, T: number]> }>;
  readonly propertyRangeExceeded: ReadonlyArray<{
    material: string;
    property: 'k' | 'cp' | 'density';
    validRange: [number, number];
    reached: number;
  }>;
  readonly fieldRefs: ReadonlyArray<{ resultsHash: string; step: number; timeS: number }>;
  readonly physicalConstants?: { stefanBoltzmann: Named; absoluteZero: Named };
}

/** PHY-04 M4b: per-increment results of a transient `coupled_temperature_displacement` step (times in seconds from the step start). */
export interface ThermomechTransientSummary {
  readonly temperatureScale: TemperatureScale;
  readonly series: ReadonlyArray<{
    readonly timeS: number;
    readonly maxVonMises: number;
    readonly maxDisplacement: number;
    readonly maxTemperature: number;
    readonly minTemperature: number;
  }>;
  readonly peakVonMises: { readonly value: number; readonly timeS: number; readonly at: Vec3; readonly entityId: EntityId };
  readonly peakDisplacement: { readonly value: number; readonly timeS: number; readonly at: Vec3 };
}

export interface ResultsSummary {
  /** `false` = recorded WITHOUT its artifact: state `missing`, never read as numbers (see `MeshSummary.verified`). */
  readonly verified?: false;
  readonly resultsHash: string;
  readonly inputHash: string;
  readonly solver: string;
  readonly solverVersion: string;
  readonly loadCases: readonly {
    name: string;
    category: LoadCategory;
    maxVonMises: { value: number; at: Vec3; entityId: EntityId };
    maxDisplacement: { value: number; at: Vec3 };
  }[];
  readonly frequenciesHz?: readonly number[];
  readonly bucklingFactors?: readonly number[];
  readonly units: UnitSystem;
  readonly thermal?: ThermalResultsSummary;
  /** PHY-04 M4b: present iff the case is a transient coupled_temperature_displacement case. */
  readonly thermomechTransient?: ThermomechTransientSummary;
  /** PHY-05: present iff the case is `nonlinear_static`. */
  readonly nonlinear?: NonlinearResultsSummary;
}

/** PHY-05 §3: how the load of one `*STEP` is driven. Increments are fractions of the step time (step time = 1). */
interface IncrementControl {
  readonly initialIncrement: number;
  readonly minIncrement: number;
  readonly maxIncrement: number;
  readonly maxIncrements: number;
}

export type SolutionControl =
  | ({ readonly kind: 'load' } & IncrementControl)
  | ({
      readonly kind: 'displacement';
      readonly target: FeaTarget;
      readonly dof: 'ux' | 'uy' | 'uz';
      /** Document length units, reached at the END of the step (ramped from the previous step's value). */
      readonly value: number;
    } & IncrementControl)
  | { readonly kind: 'arc_length'; readonly initialArcLength: number; readonly maxSteps: number };

export interface AnalysisStep {
  readonly id: string;
  readonly name: string;
  /** Load-case multipliers at the END of the step; a load case not listed keeps its previous value (0 in the first step). */
  readonly multipliers: Readonly<Record<string, number>>;
  readonly amplitude: 'ramp' | 'step';
  readonly control: SolutionControl;
}

export interface CurveProbe {
  readonly id: string;
  readonly name: string;
  readonly load:
    | { readonly kind: 'load'; readonly loadId: string }
    | { readonly kind: 'reaction'; readonly constraintId: string; readonly component: 'x' | 'y' | 'z' | 'magnitude' };
  readonly displacement: { readonly point: Vec3; readonly dof: 'ux' | 'uy' | 'uz' | 'magnitude' };
}

/** Only for `custom`: keys of the ccx `*CONTROLS` FIELD line (R_n, C_n, q_0, q_u, R_p, eps, C_eps, R_l) and TIME INCREMENTATION line (I_0 ... I_T). */
export interface ConvergencePreset {
  readonly name: 'ccx_default' | 'custom';
  readonly field?: Readonly<Partial<Record<'Rn' | 'Cn' | 'q0' | 'qu' | 'Rp' | 'eps' | 'Ceps' | 'Rl', number>>>;
  readonly timeIncrementation?: Readonly<Partial<Record<'I0' | 'IR' | 'IP' | 'IC' | 'IL' | 'IG' | 'IS' | 'IA' | 'IJ' | 'IT', number>>>;
}

/** PHY-05 set-up of a `nonlinear_static` case; absent on every other case type. */
export interface NonlinearSettings {
  /** Absent until `set_nonlinear_controls` states it: the deck is refused without an explicit choice. */
  readonly nlgeom?: boolean;
  readonly convergence: ConvergencePreset;
  readonly steps: Readonly<Record<string, AnalysisStep>>;
  readonly stepOrder: readonly string[];
  /** Part -> id of the constitutive set of its material record; absent = the record's default set. */
  readonly constitutiveSets: Readonly<Record<EntityId, string>>;
  readonly probes: Readonly<Record<string, CurveProbe>>;
  readonly probeOrder: readonly string[];
  readonly outputIncrements: 'all' | 'last_per_step' | { readonly every: number };
}

/** Convergence bookkeeping of a nonlinear solve (CalculiX `.sta`): one row per increment. */
export interface FeConvergenceRow {
  readonly step: number;
  readonly increment: number;
  readonly attempts: number;
  readonly iterations: number;
  readonly totalTime: number;
}

export interface NonlinearResultsSummary {
  readonly nlgeom: boolean;
  /** Every analysis step reached its end time (a run that stops early is a solver failure and is never recorded). */
  readonly completed: boolean;
  readonly steps: ReadonlyArray<{
    stepId: string;
    increments: number;
    cutbacks: number;
    iterations: number;
    lastLoadFactor: number;
    completed: boolean;
  }>;
  readonly curves: ReadonlyArray<{
    probeId: string;
    name: string;
    points: number;
    peakLoad: number;
    dispRange: readonly [number, number];
    curveHash: string;
  }>;
  readonly maxPeeq?: { value: number; at: Vec3; step: number };
}

/** PHY-03 §3.1 thermal set-up (present iff the case type is `heat_*`). */
export interface TableRef {
  readonly csvSha256: string;
  readonly rows: number;
}

/** Film coefficient h(T) of a face: rows [surface temperature on the case scale, h in W/(m^2*K)], strictly increasing temperature, h > 0. */
interface FilmTable {
  readonly points: ReadonlyArray<readonly [temperature: number, filmCoefficient: number]>;
}

export interface Amplitude {
  readonly id: string;
  readonly name: string;
  readonly points: ReadonlyArray<readonly [timeS: number, factor: number]>;
  readonly generatedFrom?: { kind: 'sine' | 'ramp' | 'table'; params: Readonly<Record<string, number>> };
}

export type ThermalBc =
  | { readonly kind: 'temperature'; readonly value: Q; readonly target: FeaTarget }
  | { readonly kind: 'surface_flux'; readonly value: Q; readonly target: FeaTarget }
  | { readonly kind: 'heat_generation'; readonly value: Q; readonly mode: 'density' | 'total'; readonly entityId: EntityId }
  | { readonly kind: 'concentrated_flux'; readonly value: Q; readonly target: FeaTarget }
  | {
      readonly kind: 'film';
      readonly filmCoefficient: Q | { readonly table: TableRef | FilmTable };
      readonly sinkTemperature: Q;
      readonly target: FeaTarget;
    }
  | {
      readonly kind: 'radiation';
      readonly emissivity: number | { readonly fromProperty: 'emissivityIr' };
      readonly sinkTemperature: Q;
      readonly target: FeaTarget;
    };

export interface ThermalBcRecord {
  readonly id: string;
  readonly name: string;
  readonly bc: ThermalBc;
  readonly amplitude?: string;
  readonly source?: { readonly citation: string; readonly locator?: string };
}

export interface CavityRadiation {
  readonly id: string;
  readonly name: string;
  readonly environment: { readonly kind: 'open'; readonly temperature: Q } | { readonly kind: 'closed' };
  readonly faces: ReadonlyArray<{ readonly target: FeaTarget; readonly emissivity: number | { readonly fromProperty: 'emissivityIr' } }>;
}

export interface ThermalContact {
  readonly id: string;
  readonly name: string;
  readonly master: FeaTarget;
  readonly slave: FeaTarget;
  readonly conductance:
    | Q
    | { readonly points: ReadonlyArray<readonly [conductanceW_m2K: number, pressureMPa: number, temperature: number]> };
}

export interface ThermalStep {
  readonly endTimeS?: number;
  readonly initialIncrementS?: number;
  readonly maxIncrementS?: number;
  readonly minIncrementS?: number;
  readonly fixedIncrements?: boolean;
  readonly maxTemperatureChangePerIncrement?: Q;
  readonly outputTimesS?: readonly number[];
  readonly outputEveryS?: number;
}

export interface TemperatureLimit {
  readonly id: string;
  readonly name: string;
  readonly scope: { readonly entityId: EntityId } | { readonly target: FeaTarget };
  readonly min?: Q;
  readonly max?: Q;
  readonly source: { readonly citation: string; readonly locator?: string };
}

export interface Disposition {
  readonly decision: Decision;
  readonly justification: string;
  readonly resultsHash: string;
  readonly signer: string;
  readonly signatureId: string;
  /** The signature object the signing port verified; readers re-verify it against the payload (a record without it is unverified). */
  readonly signature?: unknown;
}

export interface ThermalSetup {
  readonly temperatureScale: TemperatureScale;
  readonly initialTemperature?: Q;
  /** Explicit Stefan-Boltzmann constant (SI value, `defaulted: false`, with source); absent = the 2019 SI exact value. */
  readonly stefanBoltzmann?: Named;
  readonly bcs: Readonly<Record<string, ThermalBcRecord>>;
  readonly bcOrder: readonly string[];
  readonly amplitudes: Readonly<Record<string, Amplitude>>;
  readonly cavities: Readonly<Record<string, CavityRadiation>>;
  readonly contacts: Readonly<Record<string, ThermalContact>>;
  readonly step: ThermalStep;
  readonly limits: Readonly<Record<string, TemperatureLimit>>;
  readonly limitOrder: readonly string[];
  readonly dispositions: Readonly<Record<string, Disposition>>;
}

/** PHY-04 §3.1. */
export type TemperatureFieldSource =
  | {
      readonly kind: 'thermal_result';
      readonly analysisId: string;
      readonly time: number | 'last';
      readonly mapping: 'same_mesh' | 'interpolate';
    }
  | { readonly kind: 'uniform'; readonly value: Q }
  | {
      readonly kind: 'expression';
      readonly expression: string;
      readonly coordinatesUnit: 'mm' | 'm' | 'in';
      readonly temperatureUnit: 'degC' | 'K' | 'degF';
    }
  | {
      readonly kind: 'table';
      readonly csvSha256: string;
      readonly rows: number;
      readonly coordinatesUnit: string;
      readonly temperatureUnit: string;
    };

/** Stated basis of a material's `cte` model (PHY-04 §3.3 override until PHY-01 carries one). */
export type CteBasisSpec = { readonly kind: 'secant'; readonly referenceTemperature: Q } | { readonly kind: 'instantaneous' };

/** PHY-04 M4b: material axes of a part with an orthotropic CTE, in the document frame (`axis1` = material direction 1, `axis2` lies in the 1-2 plane). */
export interface MaterialOrientation {
  readonly axis1: Vec3;
  readonly axis2: Vec3;
}

export interface ThermoMechSetup {
  readonly referenceTemperature: Q;
  /** Scale the temperature field and results are reported in (recorded, never implied). */
  readonly temperatureScale: TemperatureScale;
  readonly field?: TemperatureFieldSource;
  /** Per material id: how its `cte` property model is to be read (secant at a reference, or instantaneous). */
  readonly cteBasis?: Readonly<Record<string, CteBasisSpec>>;
  readonly thermal?: ThermalSetup;
  /** Per part id: the material axes of its orthotropic CTE (absent = the document X, Y, Z axes; a rotated part then needs one). */
  readonly orientations?: Readonly<Record<EntityId, MaterialOrientation>>;
  readonly loadCaseName: string;
}

interface FitDisposition {
  readonly decision: Decision;
  readonly justification: string;
  readonly inputsHash: string;
  readonly signer: string;
  readonly signatureId: string;
  /** The signature object the signing port verified; readers re-verify it against the payload. */
  readonly signature?: unknown;
}
export type FitDispositions = Readonly<Record<string, FitDisposition>>;

export interface AnalysisCase {
  readonly id: string;
  readonly name: string;
  readonly type: AnalysisType;
  readonly solver: FeSolver;
  readonly unitSystem: UnitSystem;
  readonly modes?: number;
  /** modal only: restrict the extracted modes to this frequency range in Hz (`*FREQUENCY` data line `modes, min, max`); absent = the lowest `modes`. */
  readonly frequencyRangeHz?: { readonly min?: number; readonly max?: number };
  readonly factors: FactorSet;
  readonly parts: Readonly<Record<EntityId, Idealization>>;
  readonly constraints: Readonly<Record<string, FeaConstraint>>;
  readonly constraintOrder: readonly string[];
  readonly loads: Readonly<Record<string, FeaLoad>>;
  readonly loadOrder: readonly string[];
  readonly mesh: MeshControls;
  readonly meshSummary?: MeshSummary;
  readonly results?: ResultsSummary;
  readonly probes: Readonly<Record<string, ResultProbe>>;
  readonly view?: {
    readonly field: 'von_mises' | 'u_mag' | 'u_x' | 'u_y' | 'u_z' | 's_xx' | 's_yy' | 's_zz' | 'mode';
    readonly loadCase?: string;
    readonly mode?: number;
    readonly deformationScale: number;
  };
  readonly thermal?: ThermalSetup;
  readonly thermomech?: ThermoMechSetup;
  readonly nonlinear?: NonlinearSettings;
  /** PHY-17 topology studies of this case (plugin `topology`); absent until the first `create_topology_study`. */
  readonly topology?: Readonly<Record<string, TopologyStudy>>;
  readonly topologyOrder?: readonly string[];
  /** Margin dispositions by row id (human gate). */
  readonly dispositions: Readonly<Record<string, Disposition>>;
}

export interface AnalysisModel {
  readonly cases: Readonly<Record<string, AnalysisCase>>;
  readonly caseOrder: readonly string[];
  readonly fitDispositions?: FitDispositions;
  /** Absent until the first durability command (`define_load_history`, `define_crack`; plugin `cae`, PHY-07 / PHY-08). */
  readonly durability?: DurabilityModel;
}

/** Mesh artifact (JSON, no typed arrays); stored by the host under `sha256Hex(canonicalJson(artifact))`. */
export interface FeMeshArtifact {
  readonly kind: 'fe_mesh';
  readonly unitSystem: UnitSystem;
  readonly mesher: string;
  readonly mesherVersion: string;
  readonly inputHash: string;
  readonly nodes: readonly (readonly [id: number, x: number, y: number, z: number])[];
  readonly blocks: readonly {
    readonly type: FeElementType;
    readonly entityId: EntityId;
    readonly elements: readonly (readonly number[])[];
  }[];
  readonly nodeSets: Readonly<Record<string, readonly number[]>>;
  readonly faceSets: Readonly<Record<string, readonly (readonly [elementId: number, face: number])[]>>;
  readonly targets: Readonly<Record<string, { readonly residual: number }>>;
  /** Parts meshed from a faceted tessellation that has curved faces (polygons, not B-rep): stresses at curved features are off by several %. */
  readonly facetedParts?: readonly EntityId[];
}

export interface FeResultsArtifact {
  readonly kind: 'fe_results';
  readonly meshHash: string;
  readonly inputHash: string;
  readonly solver: string;
  readonly solverVersion: string;
  readonly steps: readonly {
    readonly step: number;
    readonly time: number;
    readonly fields: Readonly<
      Record<string, { readonly components: readonly string[]; readonly values: Readonly<Record<string, readonly number[]>> }>
    >;
  }[];
  readonly dat?: {
    readonly tables: readonly { readonly title: string; readonly time: number; readonly rows: readonly (readonly number[])[] }[];
  };
  /** Nonlinear solves only: the increments the solver took (`.sta`). */
  readonly convergence?: readonly FeConvergenceRow[];
}

/** Temperature table (PHY-04 TR-TMC-14): rows `[x, y, z, T]` in the units the `table` field source declares; written by `fea_import_field`. */
export interface FeTableArtifact {
  readonly kind: 'fe_table';
  readonly rows: readonly (readonly [x: number, y: number, z: number, T: number])[];
}

/** Read-only artifact store injected by the host (`ExecutionContext.feaArtifacts`). */
export interface FeArtifactPort {
  get(hash: string): FeMeshArtifact | FeResultsArtifact | FeTableArtifact | FeTopologyArtifact | null;
}

/** Verifies a human signature over a payload hash (09 PLM); no implementation is installed, so human gates refuse. */
export interface HumanSignaturePort {
  verify(signature: unknown, payloadSha256: string): { readonly signer: string; readonly signatureId: string } | null;
}
