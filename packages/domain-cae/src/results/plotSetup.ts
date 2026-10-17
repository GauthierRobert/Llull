/** Set-up helpers of render_fea_results: view frame, result-set selection, support / load / BC markers. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import type { VIEW_DIRECTIONS } from '@core/model/sheet';
import { directionFrame } from '@core/geometry/viewDirections';
import type { ViewFrame } from '@core/geometry/viewProjection';
import { significantNumber } from '@lib/compactNumber';
import { loadCasesOf } from '../decks/context';
import { stepOfLoadCase, type ResultStep } from './fields';
import type { PlotMarker } from './fieldPlotSvg';
import { faceNodes, indexMesh } from '../thermal/meshGeometry';

/** Marker colour per thermal BC kind (film / radiation / prescribed temperature / flux read apart). */
const BC_COLORS: Readonly<Record<string, string>> = {
  film: '#ffb74d',
  radiation: '#ce93d8',
  temperature: '#ff5252',
  surface_flux: '#fff176',
  concentrated_flux: '#fff176',
};

export const isHeat = (analysis: AnalysisCase): boolean => analysis.type === 'heat_steady' || analysis.type === 'heat_transient';

export function frameOf(view: (typeof VIEW_DIRECTIONS)[number], direction: readonly number[] | undefined): ViewFrame {
  const [dx = 0, dy = 0, dz = 0] = direction ?? [];
  const length = Math.hypot(dx, dy, dz);
  if (direction === undefined || !(length > 0)) return directionFrame(view);
  const toViewer: Vec3 = [dx / length, dy / length, dz / length];
  const hint: Vec3 = Math.abs(toViewer[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const rx = hint[1] * toViewer[2] - hint[2] * toViewer[1];
  const ry = hint[2] * toViewer[0] - hint[0] * toViewer[2];
  const rz = hint[0] * toViewer[1] - hint[1] * toViewer[0];
  const rl = Math.hypot(rx, ry, rz);
  const right: Vec3 = [rx / rl, ry / rl, rz / rl];
  const up: Vec3 = [
    toViewer[1] * right[2] - toViewer[2] * right[1],
    toViewer[2] * right[0] - toViewer[0] * right[2],
    toViewer[0] * right[1] - toViewer[1] * right[0],
  ];
  return { toViewer, project: (p) => [p[0] * right[0] + p[1] * right[1] + p[2] * right[2], p[0] * up[0] + p[1] * up[1] + p[2] * up[2]] };
}

export interface Selected {
  readonly step: ResultStep;
  readonly label: string;
}

export function selectStep(
  analysis: AnalysisCase,
  results: FeResultsArtifact,
  loadCase: string | undefined,
  time: number | undefined,
): Selected | string {
  if (isHeat(analysis)) {
    if (results.steps.length === 0) return 'the results hold no result set';
    const step =
      time === undefined
        ? results.steps.at(-1)
        : results.steps.reduce((best, candidate) => (Math.abs(candidate.time - time) < Math.abs(best.time - time) ? candidate : best));
    return step === undefined
      ? 'the results hold no result set'
      : { step, label: analysis.type === 'heat_steady' ? 'steady state' : `t = ${significantNumber(step.time, 6)} s` };
  }
  const cases = loadCasesOf(analysis);
  const index = loadCase === undefined ? 0 : cases.findIndex((entry) => entry.name === loadCase);
  if (index < 0) return `no load case '${loadCase ?? ''}' (load cases: ${cases.map((entry) => entry.name).join(', ')})`;
  const step = stepOfLoadCase(results, index);
  return step === undefined
    ? `no result set for load case '${cases[index]?.name ?? ''}'`
    : { step, label: `load case ${cases[index]?.name ?? ''}` };
}

export function markersOf(analysis: AnalysisCase, mesh: FeMeshArtifact, position: (node: number) => Vec3 | undefined): PlotMarker[] {
  const index = indexMesh(mesh);
  const pointsOf = (key: string): Vec3[] => {
    const nodes = new Set(Object.hasOwn(mesh.nodeSets, key) ? (mesh.nodeSets[key] ?? []) : []);
    for (const [elementId, label] of Object.hasOwn(mesh.faceSets, key) ? (mesh.faceSets[key] ?? []) : []) {
      const element = index.elements.get(elementId);
      for (const node of element === undefined ? [] : (faceNodes(element, label) ?? [])) nodes.add(node);
    }
    return [...nodes].map(position).filter((p) => p !== undefined);
  };
  const markers: PlotMarker[] = [];
  for (const id of analysis.constraintOrder) {
    const constraint = analysis.constraints[id];
    if (constraint !== undefined)
      markers.push({ label: `${constraint.name} (${constraint.kind})`, color: '#4fc3f7', points: pointsOf(`C_${id}`) });
  }
  for (const id of analysis.loadOrder) {
    const load = analysis.loads[id];
    if (load === undefined) continue;
    const arrow = load.kind === 'pressure' || load.vector === undefined ? undefined : load.vector;
    markers.push({
      label: `${load.name} (${load.kind})`,
      color: '#ff4fd8',
      points: pointsOf(`L_${id}`),
      ...(arrow === undefined ? {} : { arrow }),
    });
  }
  for (const id of analysis.thermal?.bcOrder ?? []) {
    const record = analysis.thermal?.bcs[id];
    if (record !== undefined)
      markers.push({
        label: `${record.name} (${record.bc.kind})`,
        color: BC_COLORS[record.bc.kind] ?? '#ffb74d',
        points: pointsOf(`B_${id}`),
      });
  }
  return markers.filter((marker) => marker.points.length > 0);
}
