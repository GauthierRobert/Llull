/** Public API of the CAE domain package: the plugins the composition root installs and the pure helpers the host transports call. */

// analysis plugin
export { caePlugin } from './plugin';

// topology optimisation: plugin, job and artifact builders, study lookup
export { topologyPlugin } from './topology/plugin';
export { buildTopologyJob, type TopologyJob, type TopologyJobResult } from './topology/job';
export { buildTopologyArtifact, type TopologySolveOutput, topologySummary } from './topology/artifact';
export { findStudy } from './topology/model';

// input hashing and mesh requests for the FEA host
export { analysisInputHash } from './hash/inputHash';
export { meshRequest, type MeshRequest } from './hash/meshRequest';

// explicit dynamics: plugin, job and artifact builders
export { explicitPlugin } from './explicit/plugin';
export { buildExplicitJob, type ExplicitJob } from './explicit/job';
export { buildExplicitArtifact, explicitSummary } from './explicit/artifact';

// V// vnvV benchmark judging (CLI benchmarks)
export { adaptLegacyCase, expectedResultsFileSchema, normaliseGrade, type ExpectedCase, type JsonValue } from './vnv/expected';
export { judgeCase, type Measured, type Verdict } from './vnv/judge';

// shell midsurface geometry and shell result mapping
export { partMidsurfaceGeometry, type MidsurfaceGeometry } from './shell/meshGeometry';
export { mapShellResults } from './shell/shellResults';

// solver deck writers (BDF, INP) and unit names
export { writeBdf, type BdfResult } from './decks/bdfWriter';
export { writeInp } from './decks/inpWriter';
export { lengthUnitName, stressUnitName } from './decks/units';

// result readers/writers, plot rendering and input binding
export { firstNonFinite, parseFrd } from './results/frdReader';
export { parseDat } from './results/datReader';
export { readOp2, type Op2Result, type Op2Tables } from './results/op2Reader';
export { op2ToResults, type Op2Import } from './results/op2Results';
export { writeVtu, type VtuEncoding } from './results/vtuWriter';
export { meshSummary, resultsSummary } from './results/summary';
export { bindingOf, frdBoundHashes, mismatchMessage, UNBOUND_WARNING } from './results/inputBinding';
export { fieldPlotLayout } from './results/fieldPlotSvg';
export { finishRaster, prepareRaster, rasterPixels, type PreparedRaster, type RasterPixels } from './results/fieldRaster';
export { fieldPlotRequest, renderParams } from './results/plotRequest';

// nonlinear solver-log classification
export { classifyNonlinearStop, parseSta, type NonlinearStopCode } from './nonlinear/solverLog';

// thermo-mechanical field import and mapping
export { parseFieldTable, type TableImport } from './thermomech/tableImport';
export { temperatureMappingRequest } from './thermomech/field';
export { mappedFieldArtifact, mappingJobBuffers, readMappedField, type MappingRequest } from './thermomech/mappedField';

// fatigue field evaluation
export { isEvaluationFailure } from './fatigue/evaluate';
export { fatigueFieldArtifact, fatigueFieldInput, FIELD_COMPONENTS, readFatigueField } from './fatigue/feField';

// random-vibration nodal field set-up
export {
  nodalWork,
  randomFieldInput,
  randomFieldReference,
  randomJobJson,
  TS_NODAL_WORK_LIMIT,
  withNodalRms,
  type RandomFieldInput,
} from './dynamics/nodalField';
export { isPostProblem } from './dynamics/randomSetup';

// shared analysis defaults
export { analysisLengthMetres, DEFAULT_FACTORS } from './shared/defaults';
