/** Value validation of the raw field nodes of the `implicit` slice (05 IMP D3). */

import { isRecord } from '@lib/isRecord';
import { hypotOf } from '@lib/hypotOf';

const OPS = new Set(['primitive', 'solid', 'boolean', 'offset', 'shell', 'transform', 'tpms', 'struts', 'graph', 'voronoi', 'scalar']);
const SHAPES = new Set(['sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane']);
const TPMS_KINDS = new Set(['gyroid', 'schwarz_p', 'diamond', 'neovius', 'iwp', 'lidinoid', 'fischer_koch_s', 'split_p']);
const STRUT_CELLS = new Set(['cubic', 'bcc', 'fcc', 'octet', 'kelvin', 'diamond', 'bccz', 'fccz', 'reentrant']);
const SCALAR_KINDS = new Set(['coordinate', 'distance', 'ramp', 'mix', 'arith', 'noise', 'topology_density', 'fea_result']);
const isFiniteNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isLaw = (value: unknown): boolean => typeof value === 'number' || typeof value === 'string';
export const isVec3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === 'number' && Number.isFinite(c));

const isPositive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isWhole = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 1;

/** Whether a stored cell map is well formed (kind, finite positive sizes, whole cell counts where the seam needs them, a non-zero axis). */
function validMap(map: unknown): boolean {
  if (map === undefined) return true;
  if (!isRecord(map)) return false;
  switch (map['kind']) {
    case 'cylindrical':
      return (
        isVec3(map['origin']) &&
        isVec3(map['axis']) &&
        hypotOf(map['axis'] as number[]) > 0 &&
        isWhole(map['cellsAround']) &&
        isPositive(map['radialCellSize'])
      );
    case 'spherical':
      return isVec3(map['origin']) && isWhole(map['cellsAround']) && isWhole(map['cellsPolar']) && isPositive(map['radialCellSize']);
    case 'surface_uv':
      return (
        typeof map['sheetId'] === 'string' &&
        isPositive(map['cellsU']) &&
        isPositive(map['cellsV']) &&
        isPositive(map['depth']) &&
        isWhole(map['layers'])
      );
    default:
      return false;
  }
}

type RawNode = Record<string, unknown>;

const primitiveValid = (node: RawNode): boolean =>
  typeof node['shape'] === 'string' &&
  SHAPES.has(node['shape']) &&
  isRecord(node['dims']) &&
  Object.values(node['dims']).every((dim) => isFiniteNumber(dim) || isVec3(dim)) &&
  (node['rounding'] === undefined || isFiniteNumber(node['rounding'])) &&
  isVec3(node['position']) &&
  isVec3(node['rotation']);

const transformValid = (node: RawNode): boolean =>
  typeof node['source'] === 'string' && isVec3(node['position']) && isVec3(node['rotation']) && typeof node['scale'] === 'number';

const tpmsValid = (node: RawNode): boolean =>
  typeof node['kind'] === 'string' &&
  TPMS_KINDS.has(node['kind']) &&
  isVec3(node['cellSize']) &&
  isVec3(node['origin']) &&
  isVec3(node['rotation']) &&
  (node['form'] === 'sheet' || node['form'] === 'network') &&
  (node['normalize'] === 'gradient' || node['normalize'] === 'none') &&
  isRecord(node['control']) &&
  validMap(node['map']);

const strutsValid = (node: RawNode): boolean =>
  typeof node['cell'] === 'string' &&
  STRUT_CELLS.has(node['cell']) &&
  isVec3(node['cellSize']) &&
  isVec3(node['origin']) &&
  isVec3(node['rotation']) &&
  isLaw(node['radius']) &&
  validMap(node['map']);

const graphValid = (node: RawNode): boolean =>
  Array.isArray(node['sourceIds']) &&
  node['sourceIds'].every((o) => typeof o === 'string') &&
  typeof node['radiusStart'] === 'number' &&
  typeof node['radiusEnd'] === 'number' &&
  typeof node['chord'] === 'number' &&
  typeof node['mergeTolerance'] === 'number';

const voronoiValid = (node: RawNode): boolean =>
  isVec3(node['min']) &&
  isVec3(node['max']) &&
  typeof node['density'] === 'number' &&
  node['density'] > 0 &&
  typeof node['seed'] === 'number' &&
  typeof node['radius'] === 'number';

const scalarValid = (node: RawNode): boolean =>
  typeof node['kind'] === 'string' &&
  SCALAR_KINDS.has(node['kind']) &&
  (node['kind'] !== 'topology_density' || typeof node['studyId'] === 'string') &&
  (node['kind'] !== 'fea_result' ||
    (typeof node['caseId'] === 'string' && (node['quantity'] === 'von_mises' || node['quantity'] === 'u_mag')));

const NODE_CHECKS: Record<string, (node: RawNode) => boolean> = {
  primitive: primitiveValid,
  solid: (node) => typeof node['entityId'] === 'string',
  boolean: (node) => Array.isArray(node['operands']) && node['operands'].every((o) => typeof o === 'string'),
  offset: (node) => typeof node['source'] === 'string' && isLaw(node['distance']),
  shell: (node) => typeof node['source'] === 'string' && isLaw(node['thickness']),
  transform: transformValid,
  tpms: tpmsValid,
  struts: strutsValid,
  graph: graphValid,
  voronoi: voronoiValid,
  scalar: scalarValid,
};

/** Why a stored field node is malformed (not a node, unknown op, bad parameters), or null when it is valid. */
export function nodeError(key: string, node: unknown): string | null {
  if (!isRecord(node) || node['id'] !== key || typeof node['op'] !== 'string' || !OPS.has(node['op']))
    return `field '${key}' is not a valid node`;
  return NODE_CHECKS[node['op']]?.(node) === true ? null : `field '${key}' (${node['op']}) has malformed parameters`;
}
