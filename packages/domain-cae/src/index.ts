/** Public API of the CAE domain package: the plugins the composition root installs and the pure helpers the host transports call. */

export { caePlugin } from './plugin';
export { topologyPlugin } from './topology/plugin';
export { analysisInputHash } from './hash/inputHash';
export { meshRequest, type MeshRequest } from './hash/meshRequest';
export { buildTopologyJob, type TopologyJob, type TopologyJobResult } from './topology/job';
export { buildTopologyArtifact, runTopologyReference, type TopologySolveOutput } from './topology/artifact';
export { TS_REFERENCE_MAX_ELEMENTS } from './topology/defaults';
